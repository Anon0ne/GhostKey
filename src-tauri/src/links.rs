//! Finds sign-in links in server banners, such as the one Tailscale SSH sends
//! in check mode.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;

static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https://[^\s<>"'`]+"#).expect("valid URL regex"));

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BannerLink {
    pub url: String,
    /// True when the link points at Tailscale, so the UI can offer a one-click
    /// open (or open it automatically when the user allows that).
    pub tailscale: bool,
}

/// Returns every https link in `text`, in order, without duplicates.
pub fn find_links(text: &str) -> Vec<BannerLink> {
    let mut links: Vec<BannerLink> = Vec::new();
    for m in URL_RE.find_iter(text) {
        let url = m
            .as_str()
            .trim_end_matches(['.', ',', ';', ':', ')', ']', '}']);
        if links.iter().any(|l| l.url == url) {
            continue;
        }
        links.push(BannerLink {
            url: url.to_string(),
            tailscale: is_tailscale_url(url),
        });
    }
    links
}

/// Remembers what one connection's banners have already shown and opened.
/// Tailscale SSH can send the same check-mode banner more than once while it
/// waits for approval, and the browser should open only once.
#[derive(Default)]
pub struct BannerSeen {
    last: Option<String>,
    opened: HashSet<String>,
}

const APPROVAL_WINDOW: Duration = Duration::from_secs(300);
const DOUBLE_CLICK_WINDOW: Duration = Duration::from_secs(2);

/// Shared across panes, jump hosts and connection retries. A new approval URL
/// can still open independently, and the user can reopen a page deliberately.
#[derive(Default)]
pub struct ApprovalBrowser {
    opened: Mutex<HashMap<String, Instant>>,
}

impl ApprovalBrowser {
    pub fn open<E>(
        &self,
        url: &str,
        automatic: bool,
        launch: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        self.open_at(url, automatic, Instant::now(), launch)
    }

    fn open_at<E>(
        &self,
        url: &str,
        automatic: bool,
        now: Instant,
        launch: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut opened = self.opened.lock().unwrap();
        opened.retain(|_, last| now.saturating_duration_since(*last) < APPROVAL_WINDOW);
        let interval = if automatic {
            APPROVAL_WINDOW
        } else {
            DOUBLE_CLICK_WINDOW
        };
        if opened
            .get(url)
            .is_some_and(|last| now.saturating_duration_since(*last) < interval)
        {
            return Ok(());
        }
        launch()?;
        opened.insert(url.to_string(), now);
        Ok(())
    }
}

impl BannerSeen {
    /// Returns false when `banner` repeats the previous one, so it isn't shown again.
    pub fn is_new(&mut self, banner: &str) -> bool {
        if self.last.as_deref() == Some(banner) {
            return false;
        }
        self.last = Some(banner.to_string());
        true
    }

    /// The Tailscale link to open automatically, if one hasn't been opened yet.
    pub fn to_open<'a>(&self, links: &'a [BannerLink]) -> Option<&'a BannerLink> {
        links
            .iter()
            .find(|l| l.tailscale && !self.opened.contains(&l.url))
    }

    pub fn mark_opened(&mut self, url: &str) {
        self.opened.insert(url.to_string());
    }

    pub fn was_opened(&self, url: &str) -> bool {
        self.opened.contains(url)
    }
}

/// True for https links on tailscale.com or one of its subdomains.
pub fn is_tailscale_url(url: &str) -> bool {
    match host_of(url) {
        Some(host) => host == "tailscale.com" || host.ends_with(".tailscale.com"),
        None => false,
    }
}

/// Only plain https links are ever handed to the system browser.
pub fn is_safe_to_open(url: &str) -> bool {
    host_of(url).is_some_and(|h| !h.is_empty())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // Reject user-info tricks such as https://tailscale.com@evil.example/
    if authority.contains('@') {
        return None;
    }
    let host = authority.split(':').next()?.to_ascii_lowercase();
    if host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Some(host)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_launch_is_shared_and_manual_retry_remains_available() {
        let browser = ApprovalBrowser::default();
        let now = Instant::now();
        let url = "https://login.tailscale.com/a/abc";
        let other = "https://login.tailscale.com/a/def";
        let launch = || Ok::<(), ()>(());
        let duplicate = || -> Result<(), ()> { panic!("duplicate browser launch") };

        assert_eq!(browser.open_at(url, true, now, || Err(())), Err(()));
        browser.open_at(url, true, now, launch).unwrap();
        browser.open_at(url, true, now, duplicate).unwrap();
        browser.open_at(url, false, now, duplicate).unwrap();
        browser.open_at(other, true, now, launch).unwrap();

        let retry = now + DOUBLE_CLICK_WINDOW;
        browser.open_at(url, false, retry, launch).unwrap();
        browser.open_at(url, false, retry, duplicate).unwrap();
        browser.open_at(url, true, retry, duplicate).unwrap();
        browser
            .open_at(url, true, retry + APPROVAL_WINDOW, launch)
            .unwrap();
    }

    #[test]
    fn finds_tailscale_check_link() {
        let banner = "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l1b2c3d4e5\n";
        let links = find_links(banner);
        assert_eq!(
            links,
            vec![BannerLink {
                url: "https://login.tailscale.com/a/l1b2c3d4e5".into(),
                tailscale: true
            }]
        );
    }

    #[test]
    fn trims_trailing_punctuation_and_dedupes() {
        let links = find_links("see (https://example.com/x). again https://example.com/x,");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://example.com/x");
        assert!(!links[0].tailscale);
    }

    #[test]
    fn repeated_banner_opens_once() {
        let banner = "# To authenticate, visit: https://login.tailscale.com/a/abc\n";
        let mut seen = BannerSeen::default();
        assert!(seen.is_new(banner));
        let links = find_links(banner);
        let link = seen.to_open(&links).unwrap().url.clone();
        seen.mark_opened(&link);
        // The same banner again is dropped.
        assert!(!seen.is_new(banner));
        // A different banner with the same link doesn't reopen it.
        let other = "# Still waiting. Visit https://login.tailscale.com/a/abc\n";
        assert!(seen.is_new(other));
        assert!(seen.to_open(&find_links(other)).is_none());
        assert!(seen.was_opened(&link));
        // A new link does open.
        let fresh = find_links("https://login.tailscale.com/a/def");
        assert_eq!(
            seen.to_open(&fresh).unwrap().url,
            "https://login.tailscale.com/a/def"
        );
    }

    #[test]
    fn ignores_plain_http() {
        assert!(find_links("http://login.tailscale.com/a/1").is_empty());
    }

    #[test]
    fn rejects_lookalike_hosts() {
        assert!(!is_tailscale_url("https://tailscale.com.evil.example/a"));
        assert!(!is_tailscale_url("https://eviltailscale.com/a"));
        assert!(!is_tailscale_url(
            "https://login.tailscale.com@evil.example/a"
        ));
        assert!(is_tailscale_url("https://login.tailscale.com:443/a/xyz"));
    }

    #[test]
    fn safe_to_open_requires_https() {
        assert!(is_safe_to_open("https://login.tailscale.com/a/1"));
        assert!(!is_safe_to_open("http://login.tailscale.com/a/1"));
        assert!(!is_safe_to_open("file:///etc/passwd"));
        assert!(!is_safe_to_open("javascript:alert(1)"));
    }
}
