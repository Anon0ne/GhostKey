//! Saved workspace layouts: named sets of tabs and split panes that point at
//! saved sessions. The layout itself is checked by the UI, which owns its
//! shape; this only stores it. Layouts never hold secrets or commands.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
/// Profile files and layouts are small; refuse anything that isn't.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    /// One entry per tab, each a split tree of session references.
    pub tabs: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    workspaces: Vec<Workspace>,
}

pub struct WorkspaceStore {
    path: PathBuf,
}

impl WorkspaceStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> anyhow::Result<Vec<Workspace>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let file: WorkspaceFile = serde_json::from_str(&text)?;
        if file.version > SCHEMA_VERSION {
            anyhow::bail!(
                "workspaces.json was written by a newer GhostKey (version {})",
                file.version
            );
        }
        let mut list = file.workspaces;
        list.sort_by_key(|w| w.name.to_lowercase());
        Ok(list)
    }

    pub fn save(&self, w: Workspace) -> anyhow::Result<()> {
        if w.name.trim().is_empty() {
            anyhow::bail!("Give the workspace a name");
        }
        if w.tabs.is_empty() {
            anyhow::bail!("A workspace needs at least one tab");
        }
        let mut list = self.list()?;
        match list.iter_mut().find(|x| x.id == w.id) {
            Some(existing) => *existing = w,
            None => list.push(w),
        }
        self.write(list)
    }

    pub fn delete(&self, id: Uuid) -> anyhow::Result<()> {
        let mut list = self.list()?;
        list.retain(|w| w.id != id);
        self.write(list)
    }

    fn write(&self, workspaces: Vec<Workspace>) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = WorkspaceFile {
            version: SCHEMA_VERSION,
            workspaces,
        };
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Reads a small text file the user chose, such as a profile to import.
pub fn read_text(path: &Path) -> anyhow::Result<String> {
    let size = fs::metadata(path)
        .map_err(|e| anyhow::anyhow!("Couldn't open {}: {e}", path.display()))?
        .len();
    if size > MAX_FILE_BYTES {
        anyhow::bail!("{} is too large to be a GhostKey profile", path.display());
    }
    let bytes =
        fs::read(path).map_err(|e| anyhow::anyhow!("Couldn't read {}: {e}", path.display()))?;
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("{} isn't a text file", path.display()))
}

/// Writes a file the user chose in a save dialog (which already asked about replacing it).
pub fn write_text(path: &Path, text: &str) -> anyhow::Result<()> {
    let tmp = path.with_extension("ghostkey-tmp");
    fs::write(&tmp, text).map_err(|e| anyhow::anyhow!("Couldn't write {}: {e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| anyhow::anyhow!("Couldn't write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            name: name.into(),
            tabs: vec![serde_json::json!({"kind": "leaf", "session": null, "label": "x"})],
        }
    }

    #[test]
    fn save_list_delete_and_reject_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().join("workspaces.json"));
        let a = sample("Morning");
        store.save(a.clone()).unwrap();
        store.save(sample("Audit")).unwrap();
        let names: Vec<_> = store.list().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["Audit", "Morning"]);
        assert_eq!(store.list().unwrap()[1], a);
        store.delete(a.id).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert!(store.save(sample(" ")).is_err());
        let mut empty = sample("e");
        empty.tabs.clear();
        assert!(store.save(empty).is_err());
    }

    #[test]
    fn newer_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        fs::write(&path, r#"{"version":9,"workspaces":[]}"#).unwrap();
        assert!(WorkspaceStore::new(path)
            .list()
            .unwrap_err()
            .to_string()
            .contains("newer"));
    }

    #[test]
    fn text_files_round_trip_and_large_or_binary_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("profile.json");
        write_text(&p, "{\"a\":1}").unwrap();
        assert_eq!(read_text(&p).unwrap(), "{\"a\":1}");
        let bin = dir.path().join("bin");
        fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_text(&bin).is_err());
        let big = dir.path().join("big");
        fs::write(&big, vec![b'a'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        assert!(read_text(&big)
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }
}
