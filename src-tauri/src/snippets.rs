//! Saved command snippets, stored as plain JSON next to the sessions.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    /// Group name such as "Recon". Empty means ungrouped.
    #[serde(default)]
    pub group: String,
    pub command: String,
    /// Press Enter after inserting. Off means the text is only typed in.
    #[serde(default)]
    pub run: bool,
    /// Show on the button bar.
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnippetFile {
    version: u32,
    snippets: Vec<Snippet>,
}

pub struct SnippetStore {
    path: PathBuf,
}

impl SnippetStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> anyhow::Result<Vec<Snippet>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let file: SnippetFile = serde_json::from_str(&text)?;
        if file.version > SCHEMA_VERSION {
            anyhow::bail!(
                "snippets.json was written by a newer GhostKey (version {})",
                file.version
            );
        }
        let mut snippets = file.snippets;
        snippets.sort_by(|a, b| {
            (a.group.to_lowercase(), a.name.to_lowercase())
                .cmp(&(b.group.to_lowercase(), b.name.to_lowercase()))
        });
        Ok(snippets)
    }

    /// Inserts or replaces the snippet with the same id.
    pub fn save(&self, snippet: Snippet) -> anyhow::Result<()> {
        if snippet.name.trim().is_empty() {
            anyhow::bail!("Give the snippet a name");
        }
        if snippet.command.is_empty() {
            anyhow::bail!("The command is empty");
        }
        let mut snippets = self.list()?;
        match snippets.iter_mut().find(|s| s.id == snippet.id) {
            Some(existing) => *existing = snippet,
            None => snippets.push(snippet),
        }
        self.write(snippets)
    }

    pub fn delete(&self, id: Uuid) -> anyhow::Result<()> {
        let mut snippets = self.list()?;
        snippets.retain(|s| s.id != id);
        self.write(snippets)
    }

    fn write(&self, snippets: Vec<Snippet>) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = SnippetFile {
            version: SCHEMA_VERSION,
            snippets,
        };
        // Write to a temp file and rename, so a crash never leaves a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str, group: &str) -> Snippet {
        Snippet {
            id: Uuid::new_v4(),
            name: name.into(),
            group: group.into(),
            command: "ls -la".into(),
            run: false,
            favorite: false,
        }
    }

    #[test]
    fn save_list_update_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnippetStore::new(dir.path().join("snippets.json"));
        assert!(store.list().unwrap().is_empty());

        let mut a = sample("users", "Recon");
        let b = sample("disk", "");
        store.save(a.clone()).unwrap();
        store.save(b.clone()).unwrap();
        let names: Vec<_> = store.list().unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["disk", "users"]);

        a.command = "cat /etc/passwd\nid".into();
        a.run = true;
        store.save(a.clone()).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list.iter().find(|s| s.id == a.id).unwrap(), &a);

        store.delete(b.id).unwrap();
        assert_eq!(store.list().unwrap(), [a]);
    }

    #[test]
    fn rejects_empty_names_and_commands() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnippetStore::new(dir.path().join("snippets.json"));
        let mut s = sample(" ", "");
        assert!(store.save(s.clone()).is_err());
        s.name = "x".into();
        s.command.clear();
        assert!(store.save(s).is_err());
    }

    #[test]
    fn older_files_without_options_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snippets.json");
        let id = Uuid::new_v4();
        fs::write(
            &path,
            format!(r#"{{"version":1,"snippets":[{{"id":"{id}","name":"x","command":"pwd"}}]}}"#),
        )
        .unwrap();
        let s = &SnippetStore::new(path).list().unwrap()[0];
        assert!(!s.run && !s.favorite && s.group.is_empty());
    }
}
