//! Host key checks against GhostKey's own known_hosts file (OpenSSH format).

use std::path::Path;

use russh::keys::{self, HashAlg, PublicKey};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum HostKeyStatus {
    /// The key matches a recorded key for this host.
    Trusted,
    /// No key of this type is recorded for this host yet.
    Unknown,
    /// A different key of the same type is recorded: possible attack.
    Changed { line: usize },
}

pub fn check(host: &str, port: u16, key: &PublicKey, path: &Path) -> anyhow::Result<HostKeyStatus> {
    match keys::check_known_hosts_path(host, port, key, path) {
        Ok(true) => Ok(HostKeyStatus::Trusted),
        Ok(false) => Ok(HostKeyStatus::Unknown),
        Err(keys::Error::KeyChanged { line }) => Ok(HostKeyStatus::Changed { line }),
        Err(e) => Err(e.into()),
    }
}

pub fn learn(host: &str, port: u16, key: &PublicKey, path: &Path) -> anyhow::Result<()> {
    keys::known_hosts::learn_known_hosts_path(host, port, key, path)?;
    Ok(())
}

/// The `SHA256:...` fingerprint that `ssh` shows.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn algorithm(key: &PublicKey) -> String {
    key.algorithm().as_str().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    #[test]
    fn unknown_then_trusted_then_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let a = keys::parse_public_key_base64(KEY_A).unwrap();
        let b = keys::parse_public_key_base64(KEY_B).unwrap();

        assert_eq!(
            check("srv", 2222, &a, &path).unwrap(),
            HostKeyStatus::Unknown
        );
        learn("srv", 2222, &a, &path).unwrap();
        assert_eq!(
            check("srv", 2222, &a, &path).unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(matches!(
            check("srv", 2222, &b, &path).unwrap(),
            HostKeyStatus::Changed { .. }
        ));
        // A different port is a different host.
        assert_eq!(check("srv", 22, &b, &path).unwrap(), HostKeyStatus::Unknown);
    }

    #[test]
    fn fingerprint_is_sha256() {
        let a = keys::parse_public_key_base64(KEY_A).unwrap();
        assert!(fingerprint(&a).starts_with("SHA256:"));
        assert_eq!(algorithm(&a), "ssh-ed25519");
    }
}
