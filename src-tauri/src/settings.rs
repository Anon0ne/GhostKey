//! App-wide settings that the Rust core needs, stored in settings.json.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Where session logs go. None means the default folder.
    #[serde(default)]
    pub log_dir: Option<String>,
}

pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Documents/GhostKey Logs, where people expect to find them; the app data
/// folder when there is no Documents folder.
pub fn default_log_dir(app_data: &Path) -> PathBuf {
    dirs::document_dir()
        .map(|d| d.join("GhostKey Logs"))
        .unwrap_or_else(|| app_data.join("logs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(load(&path), Settings::default());
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let s = Settings {
            log_dir: Some("/tmp/logs".into()),
        };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
    }
}
