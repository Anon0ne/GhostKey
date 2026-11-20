//! Finds newer GhostKey releases on GitHub and, when the release is signed,
//! installs them in place with Tauri's updater.
//!
//! The list of releases comes from the GitHub API rather than a fixed
//! `latest.json` URL, because GitHub's "latest release" link skips
//! pre-releases, and the alpha and beta builds are pre-releases. Each release
//! can carry the `latest.json` that `tauri-action` makes; the updater then
//! checks the download against the public key in `tauri.conf.json` before
//! installing anything. Releases without it, or builds without a key, can only
//! be downloaded by hand.

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};

pub const RELEASES_API: &str = "https://api.github.com/repos/Anon0ne/GhostKey/releases?per_page=30";
/// Release pages and downloads must come from this repository.
pub const RELEASE_PAGE_PREFIX: &str = "https://github.com/Anon0ne/GhostKey/releases/";
pub const DOWNLOAD_PREFIX: &str = "https://github.com/Anon0ne/GhostKey/releases/download/";
/// The manifest `tauri-action` attaches to a release.
const MANIFEST: &str = "latest.json";
const MAX_NOTES: usize = 8000;

#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub name: String,
    pub notes: String,
    /// The release page, to download by hand.
    pub url: String,
    pub published: Option<String>,
    pub prerelease: bool,
    /// The signed update manifest, when the release has one.
    pub manifest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current: String,
    pub available: Option<Release>,
    /// True when `available` can be installed in place.
    pub can_install: bool,
    /// Why it can't, in words, when it can't.
    pub install_note: Option<String>,
}

/// "v0.3.0-beta.1" → 0.3.0-beta.1.
pub fn tag_version(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// The newest release that is newer than `current`, skipping drafts, links
/// outside this repository and, unless asked for, pre-releases.
pub fn newest(releases: &[GhRelease], current: &Version, include_pre: bool) -> Option<Release> {
    releases
        .iter()
        .filter(|r| !r.draft && (include_pre || !r.prerelease))
        .filter(|r| r.html_url.starts_with(RELEASE_PAGE_PREFIX))
        .filter_map(|r| tag_version(&r.tag_name).map(|v| (v, r)))
        .filter(|(v, _)| v > current)
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(v, r)| Release {
            version: v.to_string(),
            name: r
                .name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| format!("GhostKey {}", r.tag_name)),
            notes: truncate(r.body.as_deref().unwrap_or("").trim(), MAX_NOTES),
            url: r.html_url.clone(),
            published: r.published_at.clone(),
            prerelease: r.prerelease,
            manifest: r
                .assets
                .iter()
                .find(|a| a.name == MANIFEST && a.browser_download_url.starts_with(DOWNLOAD_PREFIX))
                .map(|a| a.browser_download_url.clone()),
        })
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Why this copy of GhostKey can't replace itself, if it can't. Only the
/// Windows installers and the AppImage can be updated in place; .deb and .rpm
/// installs belong to the system's package manager.
pub fn platform_note() -> Option<&'static str> {
    if cfg!(windows) {
        None
    } else if cfg!(target_os = "linux") {
        if std::env::var_os("APPIMAGE").is_some() {
            None
        } else {
            Some("This copy was installed from a .deb or .rpm package, so it can't replace itself. Download the new package from the release page and install it the same way.")
        }
    } else {
        Some("Updating in place isn't supported on this system. Download the new version from the release page.")
    }
}

fn ensure_crypto() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// Asks GitHub for the releases. Sends nothing about this computer beyond
/// what any web request does.
pub async fn fetch_releases() -> anyhow::Result<Vec<GhRelease>> {
    ensure_crypto();
    let client = reqwest::Client::builder()
        .user_agent(concat!("GhostKey/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()?;
    let resp = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Couldn't reach GitHub: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        anyhow::bail!("GitHub is limiting requests from this network. Try again in an hour.");
    }
    if !status.is_success() {
        anyhow::bail!("GitHub answered {status}");
    }
    Ok(resp.json().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, pre: bool, draft: bool, manifest: bool) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            name: Some(format!("GhostKey {tag}")),
            body: Some("notes".into()),
            html_url: format!("{RELEASE_PAGE_PREFIX}tag/{tag}"),
            draft,
            prerelease: pre,
            published_at: None,
            assets: if manifest {
                vec![GhAsset {
                    name: "latest.json".into(),
                    browser_download_url: format!("{DOWNLOAD_PREFIX}{tag}/latest.json"),
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn picks_the_newest_newer_release() {
        let cur = Version::parse("0.2.4").unwrap();
        let list = vec![
            rel("v0.2.3", true, false, false),
            rel("v0.3.0-beta.1", true, false, true),
            rel("v0.3.0-beta.2", true, true, true),
            rel("v0.2.5", false, false, false),
            rel("not-a-version", false, false, false),
        ];
        let r = newest(&list, &cur, true).unwrap();
        assert_eq!(r.version, "0.3.0-beta.1");
        assert!(r.manifest.unwrap().ends_with("/v0.3.0-beta.1/latest.json"));
        // Without pre-releases, only the stable one counts.
        assert_eq!(newest(&list, &cur, false).unwrap().version, "0.2.5");
        // Nothing newer.
        let cur = Version::parse("0.3.0").unwrap();
        assert!(newest(&list, &cur, true).is_none());
    }

    #[test]
    fn a_beta_is_older_than_its_release() {
        let cur = Version::parse("0.3.0-beta.1").unwrap();
        let list = vec![
            rel("v0.3.0", false, false, false),
            rel("v0.3.0-beta.1", true, false, false),
        ];
        assert_eq!(newest(&list, &cur, true).unwrap().version, "0.3.0");
    }

    #[test]
    fn links_outside_the_repository_are_ignored() {
        let cur = Version::parse("0.2.4").unwrap();
        let mut evil = rel("v9.0.0", false, false, true);
        evil.html_url = "https://example.com/ghostkey".into();
        assert!(newest(&[evil], &cur, true).is_none());
        let mut odd = rel("v9.0.0", false, false, true);
        odd.assets[0].browser_download_url = "https://example.com/latest.json".into();
        assert_eq!(newest(&[odd], &cur, true).unwrap().manifest, None);
    }

    #[test]
    fn long_notes_are_cut_on_a_character_boundary() {
        let s = "é".repeat(5000);
        let t = truncate(&s, MAX_NOTES + 1);
        assert!(t.ends_with('…'));
        assert!(t.len() <= MAX_NOTES + 1 + '…'.len_utf8());
    }

    /// Talks to GitHub, so it only runs when asked: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn github_lists_this_repositorys_releases() {
        let list = fetch_releases().await.unwrap();
        assert!(list.iter().any(|r| r.tag_name == "v0.2.4"));
        let old = Version::parse("0.1.0").unwrap();
        assert!(newest(&list, &old, true).is_some());
    }
}
