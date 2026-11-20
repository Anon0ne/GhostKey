//! SSH keys: inspect, generate and convert key files, and talk to the
//! system's SSH agent (ssh-agent on Linux and macOS, the Windows OpenSSH agent
//! or Pageant on Windows). Private keys stay in Rust: nothing here returns a
//! private key to the UI, and agent-held keys can't be exported at all.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::bail;
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{private::KeypairData, LineEnding};
use russh::keys::{self, Algorithm, EcdsaCurve, HashAlg, PrivateKey, PublicKey};
use serde::{Deserialize, Serialize};

/// What the UI shows about a key. Never holds private material.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub format: String,
    /// Empty when the key is encrypted in a format that hides its public part.
    pub algorithm: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub comment: String,
    pub encrypted: bool,
    /// The file is encrypted and the passphrase is needed to read even its public key.
    pub needs_passphrase: bool,
    /// The public key in `authorized_keys` form.
    pub public_line: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum KeyKind {
    Ed25519,
    Ecdsa256,
    Rsa4096,
}

/// Expands a leading `~` to the home folder, as typed paths like `~/.ssh/id_ed25519` expect.
pub fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    let rest = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))
        .or_else(|| (path == "~").then_some(""));
    match (rest, dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn format_of(text: &str) -> &'static str {
    let t = text.trim_start();
    if t.starts_with("PuTTY-User-Key-File-") {
        "PuTTY (.ppk)"
    } else if t.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        "OpenSSH"
    } else if t.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
        "PEM (RSA)"
    } else if t.starts_with("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || t.starts_with("-----BEGIN PRIVATE KEY-----")
    {
        "PKCS#8"
    } else if t.starts_with("ssh-") || t.starts_with("ecdsa-") || t.starts_with("sk-") {
        "Public key"
    } else {
        "Unknown"
    }
}

fn bits(public: &PublicKey) -> Option<u32> {
    use russh::keys::ssh_key::public::KeyData;
    match public.key_data() {
        KeyData::Rsa(rsa) => Some(
            rsa.n()
                .as_positive_bytes()
                .map_or(0, |b| b.len() as u32 * 8),
        ),
        KeyData::Ed25519(_) => Some(256),
        KeyData::Ecdsa(e) => Some(match e.curve() {
            EcdsaCurve::NistP256 => 256,
            EcdsaCurve::NistP384 => 384,
            EcdsaCurve::NistP521 => 521,
        }),
        _ => None,
    }
}

fn public_line(public: &PublicKey, comment: &str) -> String {
    let mut p = public.clone();
    p.set_comment(comment);
    p.to_openssh().unwrap_or_default()
}

fn describe(format: &str, public: &PublicKey, comment: &str, encrypted: bool) -> KeyInfo {
    KeyInfo {
        format: format.into(),
        algorithm: public.algorithm().as_str().into(),
        bits: bits(public),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        comment: comment.into(),
        encrypted,
        needs_passphrase: false,
        public_line: public_line(public, comment),
    }
}

fn read(path: &Path) -> anyhow::Result<String> {
    std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("Couldn't read {}: {e}", path.display()))
}

fn wrong_passphrase(e: keys::Error) -> anyhow::Error {
    match e {
        keys::Error::KeyIsEncrypted => anyhow::anyhow!("This key needs its passphrase"),
        keys::Error::SshKey(_) | keys::Error::CouldNotReadKey => {
            anyhow::anyhow!("Wrong passphrase, or the key file is damaged")
        }
        other => anyhow::anyhow!("Couldn't read the key: {other}"),
    }
}

/// Reads a private key file, decrypting it with `passphrase` when needed.
fn load_private(text: &str, passphrase: Option<&str>) -> anyhow::Result<PrivateKey> {
    keys::decode_secret_key(text, passphrase.filter(|p| !p.is_empty())).map_err(wrong_passphrase)
}

/// Describes a key file. OpenSSH and public key files show their public key
/// without a passphrase; other encrypted formats need it.
pub fn inspect(path: &Path, passphrase: Option<&str>) -> anyhow::Result<KeyInfo> {
    let text = read(path)?;
    let format = format_of(&text);
    match format {
        "Public key" => {
            let public = PublicKey::from_openssh(text.trim())
                .map_err(|e| anyhow::anyhow!("Couldn't read the public key: {e}"))?;
            let comment = public.comment().to_string();
            Ok(describe(format, &public, &comment, false))
        }
        "OpenSSH" => {
            let key = PrivateKey::from_openssh(&text)
                .map_err(|e| anyhow::anyhow!("Couldn't read the key: {e}"))?;
            // The public part is readable without decrypting; an encrypted key's
            // comment isn't, so take it from the passphrase or the .pub file beside it.
            let mut comment = key.comment().to_string();
            if key.is_encrypted() {
                if let Some(Ok(open)) = passphrase.filter(|p| !p.is_empty()).map(|p| key.decrypt(p))
                {
                    comment = open.comment().to_string();
                } else if let Ok(public) = keys::load_public_key(pub_path(path)) {
                    if public.key_data() == key.public_key().key_data() {
                        comment = std::fs::read_to_string(pub_path(path))
                            .ok()
                            .and_then(|t| t.split_whitespace().nth(2).map(str::to_string))
                            .unwrap_or_default();
                    }
                }
            }
            Ok(describe(
                format,
                key.public_key(),
                &comment,
                key.is_encrypted(),
            ))
        }
        "Unknown" => bail!("This isn't a key file GhostKey recognises"),
        _ => {
            let encrypted = text.contains("ENCRYPTED") || ppk_encrypted(&text);
            match load_private(&text, passphrase) {
                Ok(key) => {
                    let comment = key.comment().to_string();
                    Ok(describe(format, key.public_key(), &comment, encrypted))
                }
                Err(_) if encrypted && passphrase.map_or(true, str::is_empty) => Ok(KeyInfo {
                    format: format.into(),
                    algorithm: String::new(),
                    bits: None,
                    fingerprint: String::new(),
                    comment: String::new(),
                    encrypted: true,
                    needs_passphrase: true,
                    public_line: String::new(),
                }),
                Err(e) => Err(e),
            }
        }
    }
}

fn ppk_encrypted(text: &str) -> bool {
    text.lines()
        .find_map(|l| l.strip_prefix("Encryption:"))
        .is_some_and(|v| v.trim() != "none")
}

/// Creates `path` only if nothing is there, readable by the owner alone when `private`.
fn create_new(path: &Path, contents: &[u8], private: bool) -> anyhow::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            anyhow::anyhow!("{} already exists. Choose another name.", path.display())
        } else {
            anyhow::anyhow!("Couldn't create {}: {e}", path.display())
        }
    })?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

fn pub_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".pub");
    PathBuf::from(name)
}

/// Writes `key` in OpenSSH format to `path`, and its public key to `path.pub`.
/// Refuses to replace either file.
fn write_pair(key: &PrivateKey, path: &Path, passphrase: Option<&str>) -> anyhow::Result<()> {
    let public = pub_path(path);
    for p in [path, public.as_path()] {
        if p.exists() {
            bail!("{} already exists. Choose another name.", p.display());
        }
    }
    let to_write = match passphrase.filter(|p| !p.is_empty()) {
        Some(p) => key
            .encrypt(&mut rand::rng(), p)
            .map_err(|e| anyhow::anyhow!("Couldn't encrypt the key: {e}"))?,
        None => key.clone(),
    };
    let pem = to_write
        .to_openssh(LineEnding::LF)
        .map_err(|e| anyhow::anyhow!("Couldn't encode the key: {e}"))?;
    create_new(path, pem.as_bytes(), true)?;
    let line = public_line(key.public_key(), key.comment().as_ref()) + "\n";
    if let Err(e) = create_new(&public, line.as_bytes(), false) {
        // Don't leave half a pair behind.
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

pub fn generate(
    path: &Path,
    kind: KeyKind,
    comment: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<KeyInfo> {
    let algorithm = match kind {
        KeyKind::Ed25519 => Algorithm::Ed25519,
        KeyKind::Ecdsa256 => Algorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        KeyKind::Rsa4096 => Algorithm::Rsa { hash: None },
    };
    let mut key = if kind == KeyKind::Rsa4096 {
        let data = russh::keys::ssh_key::private::RsaKeypair::random(&mut rand::rng(), 4096)
            .map_err(|e| anyhow::anyhow!("Couldn't generate the key: {e}"))?;
        PrivateKey::new(KeypairData::Rsa(data), comment)
            .map_err(|e| anyhow::anyhow!("Couldn't generate the key: {e}"))?
    } else {
        PrivateKey::random(&mut rand::rng(), algorithm)
            .map_err(|e| anyhow::anyhow!("Couldn't generate the key: {e}"))?
    };
    key.set_comment(comment);
    write_pair(&key, path, passphrase)?;
    inspect(path, passphrase)
}

/// Saves a PuTTY, PEM or OpenSSH key as a new OpenSSH key file with its own
/// passphrase (or none). Also how to change a key's passphrase. The original
/// file is never touched.
pub fn convert(
    from: &Path,
    passphrase: Option<&str>,
    to: &Path,
    new_passphrase: Option<&str>,
) -> anyhow::Result<KeyInfo> {
    let text = read(from)?;
    if format_of(&text) == "Public key" {
        bail!("That's a public key. Choose the private key file.");
    }
    let key = load_private(&text, passphrase)?;
    write_pair(&key, to, new_passphrase)?;
    inspect(to, new_passphrase)
}

// ---------------------------------------------------------------- agent

pub type Agent = AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>;

/// Connects to the system agent. Returns which agent it found.
pub async fn agent() -> anyhow::Result<(Agent, &'static str)> {
    #[cfg(unix)]
    {
        match AgentClient::connect_env().await {
            Ok(a) => Ok((a.dynamic(), "ssh-agent")),
            Err(keys::Error::EnvVar(_)) => bail!(
                "No SSH agent is running (SSH_AUTH_SOCK isn't set). Start one with `eval \"$(ssh-agent)\"` and add keys with `ssh-add`, or start GhostKey from a desktop session that runs one."
            ),
            Err(keys::Error::BadAuthSock) => {
                bail!("SSH_AUTH_SOCK points to an agent that isn't running anymore")
            }
            Err(e) => bail!("Couldn't reach the SSH agent: {e}"),
        }
    }
    #[cfg(windows)]
    {
        if let Ok(a) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return Ok((a.dynamic(), "Windows OpenSSH agent"));
        }
        match AgentClient::connect_pageant().await {
            Ok(a) => Ok((a.dynamic(), "Pageant")),
            Err(_) => bail!(
                "No SSH agent found. Start the \"OpenSSH Authentication Agent\" service (Services, or `Start-Service ssh-agent` as administrator) or run Pageant, then add your keys."
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentKey {
    pub algorithm: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub comment: String,
    pub certificate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub kind: Option<String>,
    pub error: Option<String>,
    pub keys: Vec<AgentKey>,
}

pub fn agent_key(id: &AgentIdentity) -> AgentKey {
    match id {
        AgentIdentity::PublicKey { key, comment } => AgentKey {
            algorithm: key.algorithm().as_str().into(),
            bits: bits(key),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            comment: comment.clone(),
            certificate: false,
        },
        AgentIdentity::Certificate {
            certificate,
            comment,
        } => AgentKey {
            algorithm: certificate.algorithm().as_str().into(),
            bits: None,
            fingerprint: certificate
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            comment: comment.clone(),
            certificate: true,
        },
    }
}

pub async fn agent_status() -> AgentStatus {
    match agent().await {
        Err(e) => AgentStatus {
            kind: None,
            error: Some(format!("{e:#}")),
            keys: Vec::new(),
        },
        Ok((mut a, kind)) => match a.request_identities().await {
            Ok(ids) => AgentStatus {
                kind: Some(kind.into()),
                error: None,
                keys: ids.iter().map(agent_key).collect(),
            },
            Err(e) => AgentStatus {
                kind: Some(kind.into()),
                error: Some(format!(
                    "The agent didn't list its keys (it may be locked): {e}"
                )),
                keys: Vec::new(),
            },
        },
    }
}

/// Loads a key file into the agent, so it can log in without the file.
pub async fn agent_add(path: &Path, passphrase: Option<&str>) -> anyhow::Result<()> {
    let key = load_private(&read(path)?, passphrase)?;
    let (mut a, _) = agent().await?;
    a.add_identity(&key, &[])
        .await
        .map_err(|e| anyhow::anyhow!("The agent didn't accept the key: {e}"))
}

/// Tests that change SSH_AUTH_SOCK hold this, so they don't see each other's agent.
#[cfg(test)]
pub(crate) static AGENT_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_paths_expand_to_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_home("~/.ssh/id"), home.join(".ssh/id"));
        assert_eq!(expand_home(" /abs/key "), PathBuf::from("/abs/key"));
        assert_eq!(expand_home("~other/x"), PathBuf::from("~other/x"));
    }

    #[test]
    fn generate_inspect_and_refuse_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_test");
        let info = generate(&path, KeyKind::Ed25519, "me@test", Some("pw")).unwrap();
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert_eq!(info.format, "OpenSSH");
        assert!(info.encrypted);
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert!(
            info.public_line.starts_with("ssh-ed25519 ") && info.public_line.ends_with(" me@test")
        );

        // The .pub file matches, and the private key loads with the passphrase.
        let public = std::fs::read_to_string(pub_path(&path)).unwrap();
        assert_eq!(public.trim(), info.public_line);
        let key = keys::load_secret_key(&path, Some("pw")).unwrap();
        assert_eq!(
            key.public_key().fingerprint(HashAlg::Sha256).to_string(),
            info.fingerprint
        );
        assert!(keys::load_secret_key(&path, Some("nope")).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // Never replaces an existing key.
        let before = std::fs::read(&path).unwrap();
        let err = generate(&path, KeyKind::Ed25519, "", None).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // Nor a stray .pub with the same name.
        let other = dir.path().join("id_other");
        std::fs::write(pub_path(&other), "keep me").unwrap();
        assert!(generate(&other, KeyKind::Ed25519, "", None).is_err());
        assert!(!other.exists());
        assert_eq!(
            std::fs::read_to_string(pub_path(&other)).unwrap(),
            "keep me"
        );

        // The public key file inspects too.
        let p = inspect(&pub_path(&path), None).unwrap();
        assert_eq!(
            (p.format.as_str(), p.fingerprint),
            ("Public key", info.fingerprint)
        );
    }

    #[test]
    fn ecdsa_and_rsa_keys() {
        let dir = tempfile::tempdir().unwrap();
        let ec = generate(&dir.path().join("ec"), KeyKind::Ecdsa256, "", None).unwrap();
        assert_eq!(
            (ec.algorithm.as_str(), ec.bits, ec.encrypted),
            ("ecdsa-sha2-nistp256", Some(256), false)
        );
        let rsa = generate(&dir.path().join("rsa"), KeyKind::Rsa4096, "r", None).unwrap();
        assert_eq!((rsa.algorithm.as_str(), rsa.bits), ("ssh-rsa", Some(4096)));
    }

    #[test]
    fn convert_changes_passphrase_and_keeps_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let made = generate(&src, KeyKind::Ed25519, "c", Some("old")).unwrap();
        let original = std::fs::read(&src).unwrap();

        let dst = dir.path().join("dst");
        assert!(convert(&src, Some("wrong"), &dst, Some("new")).is_err());
        assert!(!dst.exists());
        let out = convert(&src, Some("old"), &dst, Some("new")).unwrap();
        assert_eq!(out.fingerprint, made.fingerprint);
        assert!(keys::load_secret_key(&dst, Some("new")).is_ok());
        assert_eq!(std::fs::read(&src).unwrap(), original);

        // Without a new passphrase the copy is unencrypted.
        let plain = dir.path().join("plain");
        assert!(!convert(&src, Some("old"), &plain, None).unwrap().encrypted);
        // A public key can't be converted.
        assert!(convert(&pub_path(&src), None, &dir.path().join("x"), None).is_err());
    }

    #[test]
    fn encrypted_pem_needs_the_passphrase_to_inspect() {
        let dir = tempfile::tempdir().unwrap();
        // An RSA key in the old encrypted PEM format, as `ssh-keygen -m PEM` writes it.
        let pem = dir.path().join("pem");
        let status = std::process::Command::new("ssh-keygen")
            .args([
                "-q", "-t", "rsa", "-b", "2048", "-m", "PEM", "-N", "secret", "-C", "", "-f",
            ])
            .arg(&pem)
            .status();
        if !status.is_ok_and(|s| s.success()) {
            eprintln!("ssh-keygen not available; skipping PEM test");
            return;
        }
        let locked = inspect(&pem, None).unwrap();
        assert!(locked.needs_passphrase && locked.encrypted);
        assert_eq!(locked.format, "PEM (RSA)");
        assert!(inspect(&pem, Some("wrong")).is_err());
        let open = inspect(&pem, Some("secret")).unwrap();
        assert_eq!(open.algorithm, "ssh-rsa");
        let converted = convert(&pem, Some("secret"), &dir.path().join("out"), None).unwrap();
        assert_eq!(converted.fingerprint, open.fingerprint);
        assert_eq!(converted.format, "OpenSSH");
    }

    #[tokio::test]
    async fn missing_agent_is_explained() {
        #[cfg(unix)]
        {
            let _env = AGENT_ENV.lock().await;
            let saved = std::env::var_os("SSH_AUTH_SOCK");
            unsafe { std::env::set_var("SSH_AUTH_SOCK", "/nonexistent/ghostkey-agent.sock") };
            let status = agent_status().await;
            match saved {
                Some(v) => unsafe { std::env::set_var("SSH_AUTH_SOCK", v) },
                None => unsafe { std::env::remove_var("SSH_AUTH_SOCK") },
            }
            assert!(status.kind.is_none());
            assert!(status.error.unwrap().contains("isn't running"));
        }
    }
}
