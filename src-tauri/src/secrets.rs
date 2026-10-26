//! Passwords and key passphrases live in the OS keychain: Windows Credential
//! Manager, or the Secret Service (GNOME Keyring, KWallet) on Linux.

use keyring::Entry;
use uuid::Uuid;

const SERVICE: &str = "GhostKey";

#[derive(Debug, Clone, Copy)]
pub enum SecretKind {
    Password,
    Passphrase,
}

fn entry(session: Uuid, kind: SecretKind) -> keyring::Result<Entry> {
    let account = match kind {
        SecretKind::Password => format!("{session}:password"),
        SecretKind::Passphrase => format!("{session}:passphrase"),
    };
    Entry::new(SERVICE, &account)
}

/// Returns the stored secret, or None if there is none or the keychain is unavailable.
pub fn get(session: Uuid, kind: SecretKind) -> Option<String> {
    match entry(session, kind).and_then(|e| e.get_password()) {
        Ok(s) => Some(s),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("keychain read failed: {e}");
            None
        }
    }
}

pub fn set(session: Uuid, kind: SecretKind, secret: &str) -> anyhow::Result<()> {
    entry(session, kind)?.set_password(secret)?;
    Ok(())
}

pub fn delete(session: Uuid, kind: SecretKind) {
    match entry(session, kind).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => log::warn!("keychain delete failed: {e}"),
    }
}

pub fn delete_all(session: Uuid) {
    delete(session, SecretKind::Password);
    delete(session, SecretKind::Passphrase);
}
