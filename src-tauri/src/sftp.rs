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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CHUNK: usize = 256 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Suffix of a file still being written. It is renamed into place only when complete,
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
    name.push(PART);
    local.with_file_name(name)
}

/// Downloads one remote file. Without `overwrite`, an existing local file is an error.
pub async fn download(
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
        anyhow::bail!("{remote} is a folder; folder downloads aren't supported yet");
    }
    let part = local_part(local);
    let result = async {
        let file = sftp.open(remote).await?;
        let mut out = tokio::fs::File::create(&part).await?;
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
        tokio::fs::rename(&part, local).await?;
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
pub async fn upload(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> anyhow::Result<()> {
    let local_meta = tokio::fs::metadata(local).await?;
    if local_meta.is_dir() {
        anyhow::bail!(
            "{} is a folder; folder uploads aren't supported yet",
            local.display()
        );
    }
    let existing = sftp.metadata(remote).await.ok();
    if existing.is_some() && !overwrite {
        return Err(exists_error(remote));
    }
    let part = format!("{remote}{PART}");
    let result = async {
        let input = tokio::fs::File::open(local).await?;
        let mut file = sftp
            .open_with_flags(
                part.clone(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_remote_paths_with_slashes() {
        assert_eq!(join("/home/kali", "a b.txt"), "/home/kali/a b.txt");
        assert_eq!(join("/", "etc"), "/etc");
    }

    #[test]
    fn part_files_sit_next_to_the_target() {
        let p = local_part(Path::new("/tmp/x/report.pdf"));
        assert_eq!(p, Path::new("/tmp/x/report.pdf.ghostkey-part"));
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
