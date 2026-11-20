//! Evidence bookmarks: excerpts copied from the terminal with a note, where
//! they came from, and when they were bookmarked. The original excerpt is
//! never changed after it's saved; a redacted copy is kept beside it. The file
//! can hold secrets that were on screen, so on Unix it's readable only by you.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
pub const MAX_EXCERPT_BYTES: usize = 256 * 1024;
pub const MAX_NOTE_CHARS: usize = 4000;
pub const MAX_BOOKMARKS: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    pub username: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub environment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: Uuid,
    /// When the bookmark was made (RFC 3339), not when the text was printed.
    pub created_at: String,
    pub source: Source,
    #[serde(default)]
    pub note: String,
    /// The text exactly as it was selected.
    pub original: String,
    /// A copy with secrets removed by hand, if one was made.
    #[serde(default)]
    pub redacted: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BookmarkFile {
    version: u32,
    bookmarks: Vec<Bookmark>,
}

pub struct BookmarkStore {
    path: PathBuf,
}

impl BookmarkStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> anyhow::Result<Vec<Bookmark>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let file: BookmarkFile = serde_json::from_str(&text)?;
        if file.version > SCHEMA_VERSION {
            anyhow::bail!(
                "bookmarks.json was written by a newer GhostKey (version {})",
                file.version
            );
        }
        Ok(file.bookmarks)
    }

    /// Adds a bookmark, or updates the note and redacted copy of an existing one.
    /// An existing bookmark's original text, source and time are kept as they were.
    pub fn save(&self, mut b: Bookmark) -> anyhow::Result<()> {
        if b.original.is_empty() {
            anyhow::bail!("There's no text to bookmark");
        }
        if b.original.len() > MAX_EXCERPT_BYTES {
            anyhow::bail!(
                "The selection is too long to bookmark (at most {} KB)",
                MAX_EXCERPT_BYTES / 1024
            );
        }
        if b.redacted
            .as_ref()
            .is_some_and(|r| r.len() > MAX_EXCERPT_BYTES)
        {
            anyhow::bail!("The redacted copy is too long");
        }
        b.note = b.note.chars().take(MAX_NOTE_CHARS).collect();
        let mut list = self.list()?;
        match list.iter_mut().find(|x| x.id == b.id) {
            Some(existing) => {
                existing.note = b.note;
                existing.redacted = b.redacted.filter(|r| *r != existing.original);
            }
            None => {
                if list.len() >= MAX_BOOKMARKS {
                    anyhow::bail!(
                        "There are already {MAX_BOOKMARKS} bookmarks; export and delete some first"
                    );
                }
                list.push(b)
            }
        }
        self.write(list)
    }

    pub fn delete(&self, id: Uuid) -> anyhow::Result<()> {
        let mut list = self.list()?;
        list.retain(|b| b.id != id);
        self.write(list)
    }

    fn write(&self, bookmarks: Vec<Bookmark>) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = BookmarkFile {
            version: SCHEMA_VERSION,
            bookmarks,
        };
        let tmp = self.path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        {
            use std::io::Write;
            let mut f = opts.open(&tmp)?;
            f.write_all(serde_json::to_string_pretty(&file)?.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(text: &str) -> Bookmark {
        Bookmark {
            id: Uuid::new_v4(),
            created_at: "2026-11-20T02:00:00Z".into(),
            source: Source {
                name: "lab".into(),
                username: "kali".into(),
                host: "10.0.0.5".into(),
                port: 22,
                session_id: None,
                environment: "lab".into(),
            },
            note: "found it".into(),
            original: text.into(),
            redacted: None,
        }
    }

    #[test]
    fn originals_are_never_changed_by_an_update() {
        let dir = tempfile::tempdir().unwrap();
        let store = BookmarkStore::new(dir.path().join("bookmarks.json"));
        let b = sample("password=hunter2\n✓ ünïcode line\n");
        store.save(b.clone()).unwrap();
        let mut edit = b.clone();
        edit.original = "tampered".into();
        edit.note = "x".repeat(MAX_NOTE_CHARS + 10);
        edit.redacted = Some("password=[REDACTED]\n✓ ünïcode line\n".into());
        store.save(edit).unwrap();
        let got = &store.list().unwrap()[0];
        assert_eq!(got.original, b.original);
        assert_eq!(got.note.chars().count(), MAX_NOTE_CHARS);
        assert_eq!(
            got.redacted.as_deref(),
            Some("password=[REDACTED]\n✓ ünïcode line\n")
        );
        // A "redacted" copy identical to the original isn't kept.
        let mut same = b.clone();
        same.redacted = Some(b.original.clone());
        store.save(same).unwrap();
        assert_eq!(store.list().unwrap()[0].redacted, None);
        store.delete(b.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn empty_and_oversized_excerpts_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = BookmarkStore::new(dir.path().join("bookmarks.json"));
        assert!(store.save(sample("")).is_err());
        assert!(store
            .save(sample(&"x".repeat(MAX_EXCERPT_BYTES + 1)))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        BookmarkStore::new(path.clone()).save(sample("x")).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
