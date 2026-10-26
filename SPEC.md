# GhostKey v1 Spec

GhostKey is a stable, good-looking SSH client for Windows and Linux. It looks like the Kali Linux terminal and aims to cover what PuTTY and SecureCRT do. v1 covers the five features below. Everything else comes in later releases.

## Goals and v1 scope

| Feature | v1 behavior |
| --- | --- |
| Password login | Password and keyboard-interactive login, with an optional saved password |
| Key login | Ed25519, ECDSA and RSA keys in OpenSSH format, plus PuTTY `.ppk` import. Asks for the passphrase when the key is encrypted |
| Saved sessions | Host, port, user, login method and key path, sorted into folders, with search and one-click connect |
| Kali theme | Kali's default terminal colors and font, used for the terminal and the app shell |
| Tailscale verification | Spots the sign-in link that Tailscale SSH check mode sends, shows it as a link with an **Open in browser** button, and keeps the connection waiting until you approve |

**Later releases:** session logging, tabs and split panes, SFTP browser, port forwarding, jump hosts, SSH agent, typing into several sessions at once, scripting, serial and telnet.

## Kali theme

Kali's default terminal is QTerminal. It uses the **Kali-Dark** color scheme with **Fira Code at 10 pt**, a 5 px margin, and 5% window transparency (source: [qterminal.ini](https://gitlab.com/kalilinux/packages/kali-themes/-/blob/kali/master/etc/xdg/qterminal.org/qterminal.ini)). GhostKey ships Fira Code inside the app, which its OFL license allows, so it looks the same on Windows. The colors below come from Kali's [Kali-Dark.colorscheme](https://gitlab.com/kalilinux/packages/kali-themes/-/blob/kali/master/share/qtermwidget6/color-schemes/Kali-Dark.colorscheme).

| Slot | Normal | Bright |
| --- | --- | --- |
| Background | `#23252E` | `#23252E` |
| Foreground | `#FFFFFF` | `#FFFFFF` |
| 0 Black | `#1F2229` | `#198388` |
| 1 Red | `#D41919` | `#EC0101` |
| 2 Green | `#5EBDAB` | `#47D4B9` |
| 3 Yellow | `#FEA44C` | `#FF8A18` |
| 4 Blue | `#367BF0` | `#277FFF` |
| 5 Magenta | `#9755B3` | `#962AC3` |
| 6 Cyan | `#49AEE6` | `#05A1F7` |
| 7 White | `#E6E6E6` | `#FFFFFF` |

The colored folders and files from `ls`, and the bold `user@host` prompt, are sent by the server's shell. GhostKey draws them with the palette above and shows bold text in a real bold weight, so a Kali server looks just like it does in QTerminal.

The app shell (session list, dialogs, title bar) uses the same background, with Kali blue `#367BF0` as the accent color. Font, size and transparency can be changed in Settings.

## Architecture

GhostKey is built with **Tauri 2**: a Rust core with a small web-view UI. Anything that touches the network or secrets runs in Rust, so a UI bug can't leak a password or drop a connection.

```
 UI (web view)                         Core (Rust)
 ┌───────────────────────┐            ┌────────────────────────────┐
 │ Terminal view         │            │ Session store              │
 │ Sessions sidebar      │◄─ Tauri ──►│ Secrets (OS keychain)      │
 │ Auth dialogs          │    IPC     │ SSH engine (russh)         │
 └───────────────────────┘            └──────┬──────────────┬──────┘
                                             │ SSH          │ opens URL
                                        SSH server     Web browser
                                 (incl. Tailscale SSH)  (Tailscale sign-in)
```

The UI sends commands to the core: connect, keystrokes, resize. The core sends events back: terminal output, login prompts and server banners.

| Part | Choice | Why |
| --- | --- | --- |
| SSH protocol | [russh](https://github.com/Eugeny/russh) | Pure Rust, async and actively maintained. Supports server banners and keyboard-interactive login |
| Terminal | [xterm.js](https://xtermjs.org/) | The terminal that VS Code uses. Fast, and handles full-screen apps like vim and htop |
| UI | TypeScript + Vite | Small and easy to theme |
| Secrets | [keyring](https://crates.io/crates/keyring) crate | Uses Windows Credential Manager on Windows and the Secret Service on Linux |
| Opening links | Tauri opener plugin | Opens the system's default browser |

## Login flow

When you connect, GhostKey checks the server's host key first. It then tries key login, then keyboard-interactive, then password.

1. **Host key check.** The server's key is checked against GhostKey's `known_hosts` file, which uses the same format as OpenSSH. For a server you haven't connected to before, GhostKey shows its SHA256 fingerprint and asks whether to trust it. If a known server's key has changed, the connection is blocked with a clear warning, and there's no one-click way around it.
2. **Key login.** GhostKey loads the session's key file. If the key is encrypted, it asks for the passphrase.
3. **Keyboard-interactive and password.** The server's prompts are shown in a dialog, and a saved password is filled in automatically. If login fails, GhostKey asks you again instead of quietly retrying.
4. **Tailscale SSH check mode.** In check mode, the Tailscale server holds the login and sends a sign-in link as an SSH *login banner*, before login finishes ([Tailscale SSH docs](https://tailscale.com/kb/1193/tailscale-ssh), [tailssh source](https://github.com/tailscale/tailscale/blob/main/ssh/tailssh/tailssh.go)). GhostKey:
    - shows every login banner, so the link is never lost;
    - finds the https links in it and highlights any link to a `tailscale.com` site with an **Open in browser** button, which can open by itself if you turn that on;
    - shows "Waiting for Tailscale approval" with a Cancel button, and turns off the normal login timeout while it waits;
    - never opens a link that isn't https, and asks before opening links to any other site.

## Saved sessions and security

Session details are saved in a plain JSON file. Passwords and passphrases are never written there.

| Data | Where it's stored |
| --- | --- |
| Sessions (name, folder, host, port, user, login method, key path) | `sessions.json` in the app's config folder |
| Passwords and key passphrases | Windows Credential Manager, or the Linux Secret Service (GNOME Keyring or KWallet) |
| Known hosts | `known_hosts` in the app's config folder (OpenSSH format) |

Importing sessions from PuTTY and from `~/.ssh/config` is optional for v1 and may move to v1.1.

## Build, test and packaging

- **CI:** GitHub Actions checks, tests and builds every push on Windows and Linux.
- **Tests:** Rust unit tests cover the session store, link detection and host-key checks. Integration tests run against a real OpenSSH server.
- **Packages:** `.msi` and `.exe` installers for Windows, plus `.deb`, `.rpm` and AppImage for Linux, all built with Tauri's bundler. Signing the Windows installers needs a paid certificate, so that's decided later.

## Milestones

1. Spec approved (this file).
2. Alpha: Kali-themed terminal, login by password, key or keyboard-interactive, host-key checks, Tailscale sign-in links, and saved sessions.
3. Testing against real servers, then the first packaged release.
