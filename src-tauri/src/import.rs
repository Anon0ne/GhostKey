//! Reads sessions from OpenSSH config files and PuTTY for the import dialog.
//! Nothing here runs a command: ProxyCommand, `Match exec` and the like are
//! reported, never executed. Source files are only read.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A session found in another program's settings, before the user picks it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: Option<String>,
    /// Where it came from, e.g. "~/.ssh/config" or "PuTTY".
    pub source: String,
    /// What wasn't imported or was filled in, in plain words.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub label: String,
    pub found: bool,
    pub error: Option<String>,
    /// Things skipped for the whole source, such as Match blocks.
    pub notes: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub candidates: Vec<Candidate>,
    pub sources: Vec<SourceReport>,
}

/// Facts about the local machine that config values can refer to.
pub struct Env {
    pub home: PathBuf,
    pub local_user: String,
}

impl Env {
    pub fn current() -> Self {
        Self {
            home: dirs::home_dir().unwrap_or_default(),
            local_user: std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_default(),
        }
    }
}

/// Scans the usual places: ~/.ssh/config and PuTTY's saved sessions.
pub fn scan_default(env: &Env) -> Scan {
    let mut scan = Scan::default();
    let config = env.home.join(".ssh").join("config");
    scan_ssh_config(&mut scan, &config, "~/.ssh/config", env);
    scan_putty(&mut scan, env);
    scan
}

/// Scans one OpenSSH config file the user picked.
pub fn scan_file(path: &Path, env: &Env) -> Scan {
    let mut scan = Scan::default();
    scan_ssh_config(&mut scan, path, &path.display().to_string(), env);
    scan
}

// ---------------------------------------------------------------- OpenSSH config

/// OpenSSH's own limit on nested Include.
const MAX_INCLUDE_DEPTH: usize = 16;

#[derive(Debug, Clone)]
enum Line {
    Host(Vec<String>),
    Match,
    Option {
        /// Lowercase, for matching.
        key: String,
        /// As written, for messages.
        name: String,
        args: Vec<String>,
    },
}

fn scan_ssh_config(scan: &mut Scan, path: &Path, label: &str, env: &Env) {
    let mut report = SourceReport {
        label: label.to_string(),
        ..Default::default()
    };
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            scan.sources.push(report);
            return;
        }
        Err(e) => {
            report.error = Some(e.to_string());
            scan.sources.push(report);
            return;
        }
    };
    report.found = true;
    let mut lines = Vec::new();
    let mut notes = Vec::new();
    flatten(&text, env, 0, &mut lines, &mut notes);
    scan.candidates.extend(ssh_candidates(&lines, label, env));
    report.notes = dedupe(notes);
    scan.sources.push(report);
}

/// Splits a config line into words, honoring double quotes and `key=value`.
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut first = true;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            c if !quoted && (c.is_whitespace() || (first && c == '=')) => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    first = false;
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Parses config text into lines, reading Include files in place.
fn flatten(text: &str, env: &Env, depth: usize, out: &mut Vec<Line>, notes: &mut Vec<String>) {
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut w = words(line);
        if w.is_empty() {
            continue;
        }
        let name = w.remove(0);
        let key = name.to_ascii_lowercase();
        match key.as_str() {
            "host" => out.push(Line::Host(w)),
            "match" => {
                notes.push("Match blocks were skipped; GhostKey doesn't evaluate them.".into());
                out.push(Line::Match);
            }
            "include" => {
                if depth >= MAX_INCLUDE_DEPTH {
                    notes.push(
                        "Include is nested too deeply; the deepest files were skipped.".into(),
                    );
                    continue;
                }
                for pattern in w {
                    for file in include_paths(&pattern, env) {
                        match fs::read_to_string(&file) {
                            Ok(t) => flatten(&t, env, depth + 1, out, notes),
                            Err(e) => notes.push(format!(
                                "Couldn't read included file {}: {e}",
                                file.display()
                            )),
                        }
                    }
                }
            }
            _ => out.push(Line::Option { key, name, args: w }),
        }
    }
}

/// Files an Include names. Relative paths are under ~/.ssh, as in OpenSSH.
/// Wildcards are allowed in the file name.
fn include_paths(pattern: &str, env: &Env) -> Vec<PathBuf> {
    let expanded = expand_tilde(pattern, env);
    let path = if Path::new(&expanded).is_absolute() {
        PathBuf::from(expanded)
    } else {
        env.home.join(".ssh").join(expanded)
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !name.contains(['*', '?']) {
        return if path.is_file() { vec![path] } else { vec![] };
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut found: Vec<PathBuf> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| wildcard(&name, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found
}

/// OpenSSH-style pattern: `*` any run, `?` one character, case-insensitive.
fn wildcard(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], t) || (!t.is_empty() && go(p, &t[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &t[1..]),
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b) && go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// Whether a `Host` line applies to `alias`: any pattern matches and no
/// negated pattern does.
fn host_matches(patterns: &[String], alias: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if wildcard(neg, alias) {
                return false;
            }
        } else if wildcard(p, alias) {
            hit = true;
        }
    }
    hit
}

/// Options that would change where or how GhostKey connects if ignored quietly.
const ROUTING: [&str; 2] = ["proxyjump", "proxycommand"];
const FORWARDS: [&str; 3] = ["localforward", "remoteforward", "dynamicforward"];

fn ssh_candidates(lines: &[Line], source: &str, env: &Env) -> Vec<Candidate> {
    // Every concrete name on a Host line, in order. Patterns are not sessions.
    let mut aliases: Vec<&str> = Vec::new();
    for line in lines {
        if let Line::Host(patterns) = line {
            for p in patterns {
                if !p.contains(['*', '?', '!']) && !aliases.contains(&p.as_str()) {
                    aliases.push(p);
                }
            }
        }
    }

    aliases
        .into_iter()
        .map(|alias| {
            // First value wins, and the global section applies to everyone.
            let mut opts: HashMap<&str, &[String]> = HashMap::new();
            let mut names: HashMap<&str, &str> = HashMap::new();
            let mut active = true;
            for line in lines {
                match line {
                    Line::Host(patterns) => active = host_matches(patterns, alias),
                    Line::Match => active = false,
                    Line::Option { key, name, args } if active => {
                        opts.entry(key.as_str()).or_insert(args.as_slice());
                        names.entry(key.as_str()).or_insert(name.as_str());
                    }
                    Line::Option { .. } => {}
                }
            }
            candidate_from(alias, &opts, &names, source, env)
        })
        .collect()
}

fn candidate_from(
    alias: &str,
    opts: &HashMap<&str, &[String]>,
    names: &HashMap<&str, &str>,
    source: &str,
    env: &Env,
) -> Candidate {
    let mut notes = Vec::new();
    let first = |k: &str| opts.get(k).and_then(|a| a.first()).cloned();

    let username = match first("user") {
        Some(u) => u,
        None => {
            notes.push(format!(
                "No User set; using your local name \"{}\", as ssh would.",
                env.local_user
            ));
            env.local_user.clone()
        }
    };
    let host = match first("hostname") {
        Some(h) => expand_tokens(&h, alias, &username, env, &mut notes),
        None => alias.to_string(),
    };
    let port = match first("port") {
        Some(p) => p.parse().unwrap_or_else(|_| {
            notes.push(format!("Port \"{p}\" isn't a number; using 22."));
            22
        }),
        None => 22,
    };
    let key_path = match first("identityfile") {
        Some(f) if !f.eq_ignore_ascii_case("none") => {
            Some(expand_tokens(&f, alias, &username, env, &mut notes))
        }
        Some(_) => None,
        None => default_key(env).inspect(|k| {
            notes.push(format!(
                "No IdentityFile set; using your default key {k}, as ssh would."
            ));
        }),
    };

    for key in ROUTING {
        if let Some(args) = opts.get(key) {
            let name = if key == "proxyjump" {
                "ProxyJump"
            } else {
                "ProxyCommand"
            };
            if args.first().is_some_and(|a| a.eq_ignore_ascii_case("none")) {
                continue;
            }
            notes.push(format!(
                "{name} isn't imported: GhostKey will connect to {host} directly. {}",
                if key == "proxycommand" {
                    "The command was not run."
                } else {
                    "Jump hosts are planned."
                }
            ));
        }
    }
    let forwards: Vec<&str> = FORWARDS
        .iter()
        .filter(|k| opts.contains_key(*k))
        .map(|k| match *k {
            "localforward" => "LocalForward",
            "remoteforward" => "RemoteForward",
            _ => "DynamicForward",
        })
        .collect();
    if !forwards.is_empty() {
        notes.push(format!(
            "Port forwarding ({}) isn't imported yet.",
            forwards.join(", ")
        ));
    }
    let known: HashSet<&str> = ["user", "hostname", "port", "identityfile"]
        .into_iter()
        .chain(ROUTING)
        .chain(FORWARDS)
        .collect();
    let mut other: Vec<&str> = opts
        .keys()
        .filter(|k| !known.contains(*k))
        .map(|k| names.get(k).copied().unwrap_or(k))
        .collect();
    other.sort_unstable();
    if !other.is_empty() {
        notes.push(format!(
            "Other settings not imported: {}.",
            other.join(", ")
        ));
    }

    note_missing_key(&key_path, &mut notes);
    Candidate {
        name: alias.to_string(),
        host,
        port,
        username,
        key_path,
        source: source.to_string(),
        notes,
    }
}

fn expand_tilde(s: &str, env: &Env) -> String {
    match s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        Some(rest) => env.home.join(rest).display().to_string(),
        None if s == "~" => env.home.display().to_string(),
        None => s.to_string(),
    }
}

/// Expands `~` and the common `%` tokens. Unknown tokens are kept and noted.
fn expand_tokens(s: &str, alias: &str, user: &str, env: &Env, notes: &mut Vec<String>) -> String {
    let s = expand_tilde(s, env);
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('h') | Some('n') => out.push_str(alias),
            Some('r') => out.push_str(user),
            Some('u') => out.push_str(&env.local_user),
            Some('d') => out.push_str(&env.home.display().to_string()),
            Some(other) => {
                notes.push(format!(
                    "Couldn't expand %{other} in \"{s}\"; check this value."
                ));
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// The first of OpenSSH's default key files that exists.
fn default_key(env: &Env) -> Option<String> {
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|n| env.home.join(".ssh").join(n))
        .find(|p| p.is_file())
        .map(|p| p.display().to_string())
}

fn note_missing_key(key_path: &Option<String>, notes: &mut Vec<String>) {
    if let Some(k) = key_path {
        if !Path::new(k).is_file() {
            notes.push(format!("The key file {k} wasn't found on this computer."));
        }
    }
}

fn dedupe(notes: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    notes
        .into_iter()
        .filter(|n| seen.insert(n.clone()))
        .collect()
}

// ---------------------------------------------------------------- PuTTY

fn scan_putty(scan: &mut Scan, env: &Env) {
    let mut report = SourceReport {
        label: "PuTTY".into(),
        ..Default::default()
    };
    match read_putty_sessions(env) {
        Ok(sessions) => {
            report.found = !sessions.is_empty();
            for (name, values) in sessions {
                match putty_candidate(&name, &values) {
                    Ok(c) => scan.candidates.push(c),
                    Err(Some(why)) => report.notes.push(why),
                    Err(None) => {}
                }
            }
        }
        Err(e) => report.error = Some(e),
    }
    scan.sources.push(report);
}

/// A session name and its settings, all as strings.
type PuttySession = (String, HashMap<String, String>);

/// PuTTY keeps sessions in the registry on Windows, and in ~/.putty/sessions
/// as `Key=Value` files elsewhere. Values come back as strings.
#[cfg(windows)]
fn read_putty_sessions(_env: &Env) -> Result<Vec<PuttySession>, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    let root = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\SimonTatham\PuTTY\Sessions")
    {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else {
            continue;
        };
        let mut values = HashMap::new();
        for (value_name, value) in key.enum_values().flatten() {
            let text = String::from_reg_value(&value)
                .ok()
                .or_else(|| u32::from_reg_value(&value).ok().map(|n| n.to_string()));
            if let Some(text) = text {
                values.insert(value_name, text);
            }
        }
        out.push((url_decode(&name), values));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg(not(windows))]
fn read_putty_sessions(env: &Env) -> Result<Vec<PuttySession>, String> {
    let dir = env.home.join(".putty").join("sessions");
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        out.push((
            url_decode(&entry.file_name().to_string_lossy()),
            parse_putty_file(&text),
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg_attr(windows, allow(dead_code))]
fn parse_putty_file(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// PuTTY stores session names percent-encoded.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Turns one PuTTY session into a candidate. `Err(Some(reason))` explains a
/// skipped session; `Err(None)` skips quietly (PuTTY's "Default Settings").
fn putty_candidate(name: &str, v: &HashMap<String, String>) -> Result<Candidate, Option<String>> {
    let get = |k: &str| v.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
    let raw_host = match get("HostName") {
        Some(h) => h,
        None if name == "Default Settings" => return Err(None),
        None => {
            return Err(Some(format!(
                "\"{name}\" has no host name, so it was skipped."
            )))
        }
    };
    let protocol = get("Protocol").unwrap_or("ssh");
    if !protocol.eq_ignore_ascii_case("ssh") {
        return Err(Some(format!(
            "\"{name}\" uses {protocol}, not SSH, so it was skipped."
        )));
    }
    let (host_user, host) = match raw_host.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, raw_host),
    };
    let mut notes = Vec::new();
    let username = get("UserName")
        .or(host_user)
        .unwrap_or_default()
        .to_string();
    if username.is_empty() {
        notes.push("PuTTY asks for the user name at login; enter one before importing.".into());
    }
    let port = match get("PortNumber") {
        Some(p) => p.parse().unwrap_or_else(|_| {
            notes.push(format!("Port \"{p}\" isn't a number; using 22."));
            22
        }),
        None => 22,
    };
    if get("ProxyMethod").is_some_and(|m| m != "0") {
        let via = get("ProxyHost").unwrap_or("a proxy");
        notes.push(format!(
            "PuTTY connects through {via}; that isn't imported, so GhostKey will connect directly."
        ));
    }
    if get("PortForwardings").is_some() {
        notes.push("Port forwarding isn't imported yet.".into());
    }
    let key_path = get("PublicKeyFile").map(str::to_string);
    note_missing_key(&key_path, &mut notes);
    Ok(Candidate {
        name: name.to_string(),
        host: host.to_string(),
        port,
        username,
        key_path,
        source: "PuTTY".into(),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &Path) -> Env {
        Env {
            home: home.to_path_buf(),
            local_user: "kali".into(),
        }
    }

    fn parse(text: &str, home: &Path) -> (Vec<Candidate>, Vec<String>) {
        let e = env(home);
        let mut lines = Vec::new();
        let mut notes = Vec::new();
        flatten(text, &e, 0, &mut lines, &mut notes);
        let c = ssh_candidates(&lines, "~/.ssh/config", &e);
        (c, dedupe(notes))
    }

    fn find<'a>(c: &'a [Candidate], name: &str) -> &'a Candidate {
        c.iter().find(|c| c.name == name).unwrap()
    }

    #[test]
    fn reads_hosts_with_first_value_winning() {
        let home = tempfile::tempdir().unwrap();
        let (c, _) = parse(
            "# lab machines\n\
             Host kali kali-alt\n  HostName 10.0.0.5\n  User root\n  Port 2222\n  IdentityFile ~/.ssh/lab_key\n\
             Host kali\n  User ignored\n\
             Host *\n  User fallback\n  ServerAliveInterval 30\n",
            home.path(),
        );
        assert_eq!(c.len(), 2);
        let k = find(&c, "kali");
        assert_eq!(
            (k.host.as_str(), k.port, k.username.as_str()),
            ("10.0.0.5", 2222, "root")
        );
        assert_eq!(
            k.key_path.as_deref(),
            Some(home.path().join(".ssh/lab_key").to_str().unwrap())
        );
        assert!(
            k.notes.iter().any(|n| n.contains("ServerAliveInterval")),
            "{:?}",
            k.notes
        );
        assert_eq!(find(&c, "kali-alt").username, "root");
    }

    #[test]
    fn wildcard_and_negated_patterns_apply_but_are_not_sessions() {
        let home = tempfile::tempdir().unwrap();
        let (c, _) = parse(
            "Host web-* !web-test\n  User deploy\nHost web-prod web-test\n  HostName %h.example.com\nHost *\n  User other\n",
            home.path(),
        );
        assert_eq!(c.len(), 2);
        assert_eq!(find(&c, "web-prod").username, "deploy");
        assert_eq!(find(&c, "web-prod").host, "web-prod.example.com");
        assert_eq!(find(&c, "web-test").username, "other");
    }

    #[test]
    fn missing_values_use_ssh_defaults_and_say_so() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        fs::write(home.path().join(".ssh/id_ed25519"), "key").unwrap();
        let (c, _) = parse("Host box\n", home.path());
        let b = &c[0];
        assert_eq!(
            (b.host.as_str(), b.port, b.username.as_str()),
            ("box", 22, "kali")
        );
        assert!(b.key_path.as_deref().unwrap().ends_with("id_ed25519"));
        assert_eq!(b.notes.len(), 2, "{:?}", b.notes);
    }

    #[test]
    fn proxies_and_forwards_are_reported_not_run() {
        let home = tempfile::tempdir().unwrap();
        let (c, _) = parse(
            "Host inner\n  ProxyCommand touch /tmp/ghostkey-should-not-exist\n  LocalForward 8080 localhost:80\n\
             Host deep\n  ProxyJump bastion\nHost plain\n  ProxyJump none\n",
            home.path(),
        );
        let inner = find(&c, "inner");
        assert!(inner
            .notes
            .iter()
            .any(|n| n.contains("ProxyCommand") && n.contains("not run")));
        assert!(inner.notes.iter().any(|n| n.contains("LocalForward")));
        assert!(!Path::new("/tmp/ghostkey-should-not-exist").exists());
        assert!(find(&c, "deep")
            .notes
            .iter()
            .any(|n| n.contains("ProxyJump")));
        assert!(!find(&c, "plain")
            .notes
            .iter()
            .any(|n| n.contains("ProxyJump")));
    }

    #[test]
    fn match_blocks_are_skipped_and_noted() {
        let home = tempfile::tempdir().unwrap();
        let (c, notes) = parse(
            "Host a\n  User one\nMatch exec \"false\"\n  User wrong\nHost b\n  User two\n",
            home.path(),
        );
        assert_eq!(find(&c, "a").username, "one");
        assert_eq!(find(&c, "b").username, "two");
        assert!(notes.iter().any(|n| n.contains("Match")));
    }

    #[test]
    fn include_reads_files_in_place_with_wildcards() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        fs::create_dir_all(ssh.join("conf.d")).unwrap();
        fs::write(
            ssh.join("conf.d/b.conf"),
            "Host beta\n  HostName 10.0.0.2\n",
        )
        .unwrap();
        fs::write(
            ssh.join("conf.d/a.conf"),
            "Host alpha\n  HostName 10.0.0.1\n",
        )
        .unwrap();
        fs::write(ssh.join("conf.d/skip.txt"), "Host nope\n").unwrap();
        // A file that includes itself stops at the depth limit instead of looping.
        fs::write(ssh.join("loop"), "Include loop\n").unwrap();
        let (c, notes) = parse(
            "Include conf.d/*.conf\nInclude loop\nHost gamma\n",
            home.path(),
        );
        let names: Vec<_> = c.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta", "gamma"]);
        assert!(notes.iter().any(|n| n.contains("too deeply")));
    }

    #[test]
    fn quoted_values_and_equals_signs() {
        let home = tempfile::tempdir().unwrap();
        let (c, _) = parse(
            "Host=win\n  IdentityFile \"C:\\Keys\\my key.ppk\"\n  Port=2200\n",
            home.path(),
        );
        assert_eq!(c[0].key_path.as_deref(), Some("C:\\Keys\\my key.ppk"));
        assert_eq!(c[0].port, 2200);
    }

    #[test]
    fn missing_config_is_not_an_error() {
        let home = tempfile::tempdir().unwrap();
        let scan = scan_file(&home.path().join("nope"), &env(home.path()));
        assert!(scan.candidates.is_empty());
        assert!(!scan.sources[0].found);
        assert!(scan.sources[0].error.is_none());
    }

    #[test]
    fn putty_sessions_map_to_candidates() {
        let file = "HostName=admin@10.1.1.1\nPortNumber=2022\nProtocol=ssh\nUserName=\nPublicKeyFile=/home/kali/key.ppk\nProxyMethod=0\nPortForwardings=L8080=localhost:80\n";
        let c = putty_candidate(&url_decode("My%20Router"), &parse_putty_file(file)).unwrap();
        assert_eq!(c.name, "My Router");
        assert_eq!(
            (c.host.as_str(), c.port, c.username.as_str()),
            ("10.1.1.1", 2022, "admin")
        );
        assert_eq!(c.key_path.as_deref(), Some("/home/kali/key.ppk"));
        assert_eq!(c.notes[0], "Port forwarding isn't imported yet.");
        assert!(c.notes[1].contains("wasn't found"), "{:?}", c.notes);
    }

    #[test]
    fn putty_skips_non_ssh_and_defaults() {
        let telnet = parse_putty_file("HostName=switch\nProtocol=telnet\n");
        assert!(putty_candidate("Switch", &telnet)
            .unwrap_err()
            .unwrap()
            .contains("telnet"));
        assert_eq!(
            putty_candidate("Default Settings", &HashMap::new()),
            Err(None)
        );
        let proxied = parse_putty_file("HostName=h\nProxyMethod=5\nProxyHost=jump.local\n");
        let c = putty_candidate("p", &proxied).unwrap();
        assert!(c.notes.iter().any(|n| n.contains("jump.local")));
        assert!(c.notes.iter().any(|n| n.contains("user name")));
    }

    #[test]
    fn url_decoding_handles_bad_escapes() {
        assert_eq!(url_decode("a%2Fb%zz%4"), "a/b%zz%4");
    }

    #[cfg(not(windows))]
    #[test]
    fn reads_putty_session_files() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".putty/sessions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("Lab%20box"),
            "HostName=10.0.0.9\nUserName=kali\nProtocol=ssh\n",
        )
        .unwrap();
        let scan = scan_default(&env(home.path()));
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].name, "Lab box");
        assert_eq!(scan.sources.len(), 2);
    }
}
