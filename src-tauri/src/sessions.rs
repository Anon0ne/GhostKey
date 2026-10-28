//! Saved sessions, stored as plain JSON. Secrets never go in this file; see
//! `secrets.rs`.

use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    /// Password or keyboard-interactive.
    Password,
    /// Private key file, with password as a fallback.
    Key,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: Uuid,
    pub name: String,
    /// Folder path such as "Work/Lab". Empty means top level.
    #[serde(default)]
    pub folder: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Open Tailscale sign-in links without asking.
    #[serde(default)]
    pub auto_open_tailscale: bool,
    /// Start a session log every time this session connects.
    #[serde(default)]
    pub auto_log: bool,
    /// Port forwards saved with the session.
    #[serde(default)]
    pub forwards: Vec<crate::forward::Forward>,
    /// Another saved session to connect through first, like ProxyJump.
    #[serde(default)]
    pub jump_session: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    sessions: Vec<SavedSession>,
}

pub struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> anyhow::Result<Vec<SavedSession>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let file: SessionFile = serde_json::from_str(&text)?;
        if file.version > SCHEMA_VERSION {
            anyhow::bail!(
                "sessions.json was written by a newer GhostKey (version {})",
                file.version
            );
        }
        let mut sessions = file.sessions;
        sessions.sort_by(|a, b| {
            (a.folder.to_lowercase(), a.name.to_lowercase())
                .cmp(&(b.folder.to_lowercase(), b.name.to_lowercase()))
        });
        Ok(sessions)
    }

    /// Inserts or replaces the session with the same id.
    pub fn save(&self, session: SavedSession) -> anyhow::Result<()> {
        validate(&session)?;
        let mut sessions = self.list()?;
        match sessions.iter_mut().find(|s| s.id == session.id) {
            Some(existing) => *existing = session,
            None => sessions.push(session),
        }
        self.write(sessions)
    }

    pub fn delete(&self, id: Uuid) -> anyhow::Result<()> {
        let mut sessions = self.list()?;
        sessions.retain(|s| s.id != id);
        self.write(sessions)
    }

    #[cfg(test)]
    pub fn get(&self, id: Uuid) -> anyhow::Result<Option<SavedSession>> {
        Ok(self.list()?.into_iter().find(|s| s.id == id))
    }

    fn write(&self, sessions: Vec<SavedSession>) -> anyhow::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let file = SessionFile {
            version: SCHEMA_VERSION,
            sessions,
        };
        // Write to a temp file and rename, so a crash never leaves a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn validate(s: &SavedSession) -> anyhow::Result<()> {
    if s.name.trim().is_empty() {
        anyhow::bail!("Session name is required");
    }
    if s.host.trim().is_empty() || s.host.chars().any(char::is_whitespace) {
        anyhow::bail!("Host is required and can't contain spaces");
    }
    if s.port == 0 {
        anyhow::bail!("Port must be between 1 and 65535");
    }
    if s.username.trim().is_empty() {
        anyhow::bail!("Username is required");
    }
    if s.auth == AuthMethod::Key && s.key_path.as_deref().unwrap_or("").trim().is_empty() {
        anyhow::bail!("Choose a key file for key login");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str, folder: &str) -> SavedSession {
        SavedSession {
            id: Uuid::new_v4(),
            name: name.into(),
            folder: folder.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "kali".into(),
            auth: AuthMethod::Password,
            key_path: None,
            auto_open_tailscale: false,
            auto_log: false,
            forwards: Vec::new(),
            jump_session: None,
        }
    }

    #[test]
    fn save_list_update_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("sessions.json"));
        assert!(store.list().unwrap().is_empty());

        let mut a = sample("web", "Lab");
        let b = sample("db", "");
        store.save(a.clone()).unwrap();
        store.save(b.clone()).unwrap();
        let names: Vec<_> = store.list().unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["db", "web"]);

        a.port = 2222;
        store.save(a.clone()).unwrap();
        assert_eq!(store.get(a.id).unwrap().unwrap().port, 2222);
        assert_eq!(store.list().unwrap().len(), 2);

        store.delete(b.id).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn rejects_invalid_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("sessions.json"));
        let mut s = sample("x", "");
        s.host = "bad host".into();
        assert!(store.save(s).is_err());
        let mut s = sample("x", "");
        s.auth = AuthMethod::Key;
        assert!(store.save(s).is_err());
    }

    #[test]
    fn file_never_contains_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("sessions.json"));
        store.save(sample("x", "")).unwrap();
        let text = fs::read_to_string(store.path()).unwrap();
        assert!(!text.to_lowercase().contains("password\":"));
        assert!(text.contains("\"version\": 1"));
    }
}
