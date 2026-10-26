//! Finds sign-in links in server banners, such as the one Tailscale SSH sends
//! in check mode.

use std::sync::LazyLock;

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
