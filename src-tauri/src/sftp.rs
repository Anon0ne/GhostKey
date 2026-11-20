//! SFTP file browsing and transfers over a session's existing SSH connection.
//! The SFTP channel is opened next to the shell, so a server without SFTP
//! only fails here and the terminal keeps working.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use uuid::Uuid;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Suffix of a uniquely named file still being written. It is committed only when complete,
/// so an interrupted transfer never leaves a truncated file under the real name.
const PART: &str = ".ghostkey-part";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Dir,
    File,
    Link,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// For a symlink, whether it points at a directory.
    pub link_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<u32>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The directory's absolute path, as the server resolves it.
    pub path: String,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum TransferEvent {
    Progress { done: u64, total: u64 },
    Done,
    Cancelled,
    Failed { error: String },
}

fn kind(t: FileType) -> Kind {
    match t {
        FileType::Dir => Kind::Dir,
        FileType::File => Kind::File,
        FileType::Symlink => Kind::Link,
        FileType::Other => Kind::Other,
    }
}

/// Lists a directory. An empty path means the login directory.
pub async fn list(sftp: &SftpSession, path: &str) -> anyhow::Result<Listing> {
    let path = sftp
        .canonicalize(if path.is_empty() { "." } else { path })
        .await?;
    let mut entries = Vec::new();
    for e in sftp.read_dir(path.clone()).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let kind = kind(e.file_type());
        // Follow links once, so a link to a directory can be opened.
        let link_dir = kind == Kind::Link
            && sftp
                .metadata(join(&path, &name))
                .await
                .is_ok_and(|m| m.file_type().is_dir());
        entries.push(Entry {
            name,
            kind,
            link_dir,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime,
            permissions: meta.permissions,
        });
    }
    Ok(Listing { path, entries })
}

/// Joins a remote directory and a name with `/`, whatever the local OS uses.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Running transfers, so the UI can cancel them.
#[derive(Default)]
pub struct Transfers {
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

impl Transfers {
    pub fn start(&self) -> (u32, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().insert(id, flag.clone());
        (id, flag)
    }

    pub fn cancel(&self, id: u32) {
        if let Some(flag) = self.running.lock().unwrap().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn finish(&self, id: u32) {
        self.running.lock().unwrap().remove(&id);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CopyError {
    #[error("cancelled")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Copies a stream, reporting progress at most every 100 ms and checking for cancel
/// between chunks.
pub async fn copy<R, W>(
    mut from: R,
    to: &mut W,
    total: u64,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<u64, CopyError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    let mut last = Instant::now();
    progress(0, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyError::Cancelled);
        }
        let n = from.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n]).await?;
        done += n as u64;
        if last.elapsed() >= PROGRESS_EVERY {
            progress(done, total.max(done));
            last = Instant::now();
        }
    }
    to.flush().await?;
    progress(done, total.max(done));
    Ok(done)
}

pub fn outcome(result: anyhow::Result<()>) -> TransferEvent {
    match result {
        Ok(()) => TransferEvent::Done,
        Err(e) if matches!(e.downcast_ref(), Some(CopyError::Cancelled)) => {
            TransferEvent::Cancelled
        }
        Err(e) => TransferEvent::Failed {
            error: format!("{e:#}"),
        },
    }
}

fn exists_error(path: &str) -> anyhow::Error {
    anyhow::anyhow!("{path} already exists")
}

fn local_part(local: &Path) -> PathBuf {
    let mut name = local.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}{PART}", Uuid::new_v4()));
    local.with_file_name(name)
}

/// Downloads a remote file or folder. Without `overwrite`, an existing local
/// file or folder is an error.
pub async fn download(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    if sftp.metadata(remote).await?.file_type().is_dir() {
        download_dir(sftp, remote, local, overwrite, cancel, progress).await
    } else {
        download_file(sftp, remote, local, overwrite, cancel, progress).await
    }
}

/// Uploads a local file or folder. Without `overwrite`, an existing remote
/// file or folder is an error.
pub async fn upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    if tokio::fs::metadata(local).await?.is_dir() {
        upload_dir(sftp, local, remote, overwrite, cancel, progress).await
    } else {
        upload_file(sftp, local, remote, overwrite, cancel, progress).await
    }
}

/// Downloads one remote file. Without `overwrite`, an existing local file is an error.
async fn download_file(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    if !overwrite && tokio::fs::try_exists(local).await? {
        return Err(exists_error(&local.display().to_string()));
    }
    let meta = sftp.metadata(remote).await?;
    if meta.file_type().is_dir() {
        anyhow::bail!("{remote} is a folder");
    }
    let part = local_part(local);
    // Claim the temporary file before entering cleanup; never remove a file we did not create.
    let mut out = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .await?;
    let result = async {
        let file = sftp.open(remote).await?;
        copy(file, &mut out, meta.size.unwrap_or(0), cancel, progress).await?;
        out.sync_all().await?;
        drop(out);
        #[cfg(unix)]
        if let Some(mode) = meta.permissions {
            use std::os::unix::fs::PermissionsExt;
            let mode = mode & 0o777;
            tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(mode)).await?;
        }
        if overwrite && tokio::fs::try_exists(local).await? {
            // Windows can't rename over an existing file.
            tokio::fs::remove_file(local).await?;
        }
        if overwrite {
            tokio::fs::rename(&part, local).await?;
        } else {
            // Unlike rename on Unix, hard_link cannot replace a destination that
            // appeared after the initial existence check.
            tokio::fs::hard_link(&part, local).await?;
            tokio::fs::remove_file(&part).await?;
        }
        anyhow::Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

/// Uploads one local file. Without `overwrite`, an existing remote file is an error.
/// When replacing a file, its permissions are kept.
async fn upload_file(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    let local_meta = tokio::fs::metadata(local).await?;
    if local_meta.is_dir() {
        anyhow::bail!("{} is a folder", local.display());
    }
    let existing = sftp.metadata(remote).await.ok();
    if existing.is_some() && !overwrite {
        return Err(exists_error(remote));
    }
    let part = format!("{remote}.{}{PART}", Uuid::new_v4());
    let mut file = sftp
        .open_with_flags(
            part.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await?;
    let result = async {
        let input = tokio::fs::File::open(local).await?;
        copy(input, &mut file, local_meta.len(), cancel, progress).await?;
        file.shutdown().await?;
        drop(file);
        if let Some(perms) = existing.as_ref().and_then(|m| m.permissions) {
            let attrs = FileAttributes {
                permissions: Some(perms),
                ..FileAttributes::empty()
            };
            sftp.set_metadata(part.clone(), attrs).await?;
        }
        if existing.is_some() {
            // SFTP v3 rename fails when the target exists.
            sftp.remove_file(remote).await?;
        }
        sftp.rename(part.clone(), remote).await?;
        anyhow::Ok(())
    }
    .await;
    if result.is_err() {
        let _ = sftp.remove_file(part).await;
    }
    result
}

/// Most files and folders one folder transfer may hold.
const MAX_TREE_ENTRIES: usize = 50_000;
/// Deepest folder nesting a folder transfer follows.
const MAX_TREE_DEPTH: usize = 32;

/// Whether a name is one plain path part, so a server can't make a download
/// write outside the chosen folder with names like `..` or `a/b`.
fn safe_name(name: &str) -> bool {
    use std::path::Component;
    if name.is_empty() || name.contains(['/', '\\', '\0']) {
        return false;
    }
    let mut parts = Path::new(name).components();
    matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    )
}

/// A folder's contents: folders to create and files to copy, as paths relative to it.
/// Links and special files are skipped and counted.
#[derive(Debug, Default)]
struct Tree {
    dirs: Vec<Vec<String>>,
    files: Vec<(Vec<String>, u64)>,
    skipped: usize,
}

impl Tree {
    fn add(
        &mut self,
        rel: Vec<String>,
        is_dir: bool,
        is_file: bool,
        size: u64,
    ) -> anyhow::Result<bool> {
        if self.dirs.len() + self.files.len() >= MAX_TREE_ENTRIES {
            anyhow::bail!("The folder holds more than {MAX_TREE_ENTRIES} files and folders");
        }
        if is_dir {
            if rel.len() > MAX_TREE_DEPTH {
                anyhow::bail!("The folder is nested more than {MAX_TREE_DEPTH} levels deep");
            }
            self.dirs.push(rel);
            return Ok(true);
        }
        if is_file {
            self.files.push((rel, size));
        } else {
            self.skipped += 1;
        }
        Ok(false)
    }

    fn total(&self) -> u64 {
        self.files.iter().map(|(_, n)| n).sum()
    }
}

fn remote_path(root: &str, rel: &[String]) -> String {
    rel.iter().fold(root.to_string(), |p, n| join(&p, n))
}

fn local_path(root: &Path, rel: &[String]) -> PathBuf {
    rel.iter().fold(root.to_path_buf(), |p, n| p.join(n))
}

async fn remote_tree(sftp: &SftpSession, root: &str, cancel: &AtomicBool) -> anyhow::Result<Tree> {
    let mut tree = Tree::default();
    let mut stack = vec![Vec::<String>::new()];
    while let Some(rel) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyError::Cancelled.into());
        }
        for e in sftp.read_dir(remote_path(root, &rel)).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if !safe_name(&name) {
                tree.skipped += 1;
                continue;
            }
            let mut child = rel.clone();
            child.push(name);
            let t = e.file_type();
            let size = e.metadata().size.unwrap_or(0);
            if tree.add(child.clone(), t.is_dir(), t.is_file(), size)? {
                stack.push(child);
            }
        }
    }
    Ok(tree)
}

async fn local_tree(root: &Path, cancel: &AtomicBool) -> anyhow::Result<Tree> {
    let mut tree = Tree::default();
    let mut stack = vec![Vec::<String>::new()];
    while let Some(rel) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err(CopyError::Cancelled.into());
        }
        let mut dir = tokio::fs::read_dir(local_path(root, &rel)).await?;
        while let Some(e) = dir.next_entry().await? {
            // A name that isn't valid UTF-8 can't be sent over SFTP as text.
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                tree.skipped += 1;
                continue;
            };
            // Not followed: a link could point outside the folder or loop.
            let meta = tokio::fs::symlink_metadata(e.path()).await?;
            let mut child = rel.clone();
            child.push(name);
            if tree.add(child.clone(), meta.is_dir(), meta.is_file(), meta.len())? {
                stack.push(child);
            }
        }
    }
    Ok(tree)
}

/// Adds each file's progress to what earlier files in a folder transfer already copied.
struct Running<'a> {
    before: std::sync::atomic::AtomicU64,
    total: u64,
    progress: &'a (dyn Fn(u64, u64) + Send + Sync),
}

impl Running<'_> {
    fn report(&self, done: u64) {
        let before = self.before.load(Ordering::Relaxed);
        (self.progress)(before + done, self.total.max(before + done));
    }

    fn finished(&self, size: u64) {
        self.before.fetch_add(size, Ordering::Relaxed);
    }
}

/// Downloads a folder and everything in it. Without `overwrite`, an existing
/// local folder is an error; with it, files are merged in and same-named ones
/// replaced. Links and special files are skipped.
async fn download_dir(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    let tree = remote_tree(sftp, remote, cancel).await?;
    if overwrite {
        tokio::fs::create_dir_all(local).await?;
    } else {
        tokio::fs::create_dir(local)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => exists_error(&local.display().to_string()),
                _ => e.into(),
            })?;
    }
    for rel in &tree.dirs {
        tokio::fs::create_dir_all(local_path(local, rel)).await?;
    }
    let run = Running {
        before: 0.into(),
        total: tree.total(),
        progress,
    };
    for (rel, size) in &tree.files {
        let from = remote_path(remote, rel);
        let to = local_path(local, rel);
        // Files are new unless merging into a folder that was already there.
        let each = |done: u64, _| run.report(done);
        download_file(sftp, &from, &to, overwrite, cancel, &each)
            .await
            .map_err(|e| e.context(from.clone()))?;
        run.finished(*size);
    }
    Ok(())
}

/// Uploads a folder and everything in it. Without `overwrite`, an existing
/// remote folder is an error; with it, files are merged in and same-named ones
/// replaced. Links and special files are skipped.
async fn upload_dir(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    let tree = local_tree(local, cancel).await?;
    let exists = sftp.metadata(remote).await.ok();
    match exists {
        Some(m) if !overwrite || !m.file_type().is_dir() => return Err(exists_error(remote)),
        Some(_) => {}
        None => sftp.create_dir(remote).await?,
    }
    for rel in &tree.dirs {
        let dir = remote_path(remote, rel);
        if sftp.metadata(dir.clone()).await.is_err() {
            sftp.create_dir(dir).await?;
        }
    }
    let run = Running {
        before: 0.into(),
        total: tree.total(),
        progress,
    };
    for (rel, size) in &tree.files {
        let from = local_path(local, rel);
        let to = remote_path(remote, rel);
        let each = |done: u64, _| run.report(done);
        upload_file(sftp, &from, &to, overwrite, cancel, &each)
            .await
            .map_err(|e| e.context(from.display().to_string()))?;
        run.finished(*size);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_names_that_could_leave_the_folder_are_refused() {
        for bad in ["", ".", "..", "a/b", "a\\b", "/etc", "x\0y"] {
            assert!(!safe_name(bad), "{bad:?}");
        }
        for good in ["notes.txt", ".bashrc", "a b", "..hidden", "ü.txt"] {
            assert!(safe_name(good), "{good:?}");
        }
    }

    #[tokio::test]
    async fn local_tree_skips_links_and_lists_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("top.txt"), b"12345").unwrap();
        std::fs::write(root.join("a/b/deep.txt"), b"xy").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        let tree = local_tree(root, &AtomicBool::new(false)).await.unwrap();
        let mut dirs: Vec<_> = tree.dirs.iter().map(|d| d.join("/")).collect();
        dirs.sort();
        assert_eq!(dirs, ["a", "a/b"]);
        let mut files: Vec<_> = tree.files.iter().map(|(f, n)| (f.join("/"), *n)).collect();
        files.sort();
        assert_eq!(
            files,
            [("a/b/deep.txt".to_string(), 2), ("top.txt".to_string(), 5)]
        );
        assert_eq!(tree.total(), 7);
        #[cfg(unix)]
        assert_eq!(tree.skipped, 1);
    }

    #[test]
    fn joins_remote_paths_with_slashes() {
        assert_eq!(join("/home/kali", "a b.txt"), "/home/kali/a b.txt");
        assert_eq!(join("/", "etc"), "/etc");
    }

    #[test]
    fn part_files_sit_next_to_the_target() {
        let p = local_part(Path::new("/tmp/x/report.pdf"));
        assert_eq!(p.parent(), Some(Path::new("/tmp/x")));
        assert!(p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("report.pdf."));
        assert!(p.file_name().unwrap().to_string_lossy().ends_with(PART));
        assert_ne!(p, local_part(Path::new("/tmp/x/report.pdf")));
    }

    #[tokio::test]
    async fn copy_reports_progress_and_stops_on_cancel() {
        let data = vec![7u8; CHUNK * 3 + 5];
        let mut out = Vec::new();
        let seen = Mutex::new(Vec::new());
        let cancel = AtomicBool::new(false);
        let n = copy(&data[..], &mut out, data.len() as u64, &cancel, &|d, t| {
            seen.lock().unwrap().push((d, t))
        })
        .await
        .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(out, data);
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.first(), Some(&(0, data.len() as u64)));
        assert_eq!(seen.last(), Some(&(data.len() as u64, data.len() as u64)));

        cancel.store(true, Ordering::Relaxed);
        let mut out = Vec::new();
        let r = copy(&data[..], &mut out, 0, &cancel, &|_, _| {}).await;
        assert!(matches!(r, Err(CopyError::Cancelled)));
        assert!(out.is_empty());
    }

    #[test]
    fn cancelled_copies_are_reported_as_cancelled() {
        let e = anyhow::Error::from(CopyError::Cancelled).context("downloading");
        assert!(matches!(outcome(Err(e)), TransferEvent::Cancelled));
        assert!(matches!(outcome(Ok(())), TransferEvent::Done));
    }
}
