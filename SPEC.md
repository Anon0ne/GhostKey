# GhostKey v1 Spec

GhostKey is a stable, good-looking SSH client for Windows and Linux. It looks like the Kali Linux terminal and aims to cover what PuTTY and SecureCRT do. v1 covers the five features below. Everything else comes in later releases.

For the shared expansion backlog and AI-to-AI handoff, see [docs/FEATURE_ROADMAP.md](docs/FEATURE_ROADMAP.md).

## Goals and v1 scope

| Feature | v1 behavior |
| --- | --- |
| Password login | Password and keyboard-interactive login, with an optional saved password |
| Key login | Ed25519, ECDSA and RSA keys in OpenSSH format, plus PuTTY `.ppk` import. Asks for the passphrase when the key is encrypted |
| Saved sessions | Host, port, user, login method and key path, sorted into folders, with search and one-click connect |
| Kali theme | Kali's default terminal colors and font, used for the terminal and the app shell |
| Tailscale verification | Spots the sign-in link that Tailscale SSH check mode sends, shows it as a link with an **Open in browser** button, and keeps the connection waiting until you approve |

**v0.2 adds** tabs, split panes and session logging; see [v0.2: tabs, split panes and logging](#v02-tabs-split-panes-and-logging).

**Later releases:** SFTP browser, port forwarding, jump hosts, SSH agent, typing into several sessions at once, scripting, serial and telnet.

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

## v0.2: tabs, split panes and logging

**Tabs and panes.** Each tab holds one or more panes, split side by side or one above the other, with a draggable divider. Every pane has its own terminal, connection, login prompts and Retry/Reconnect button, so closing or reconnecting one never touches another. The toolbar always describes the focused pane, which has a blue outline when a tab has more than one. Login dialogs name the session they belong to, switch to that pane, and appear one at a time. Splitting a connected pane opens a second shell on the same server. Opening a saved session uses the focused pane when it is idle, otherwise a new tab.

| Keys | Action |
| --- | --- |
| Ctrl+Shift+T | New tab |
| Ctrl+Shift+W | Close the focused pane (asks first if it's connected) |
| Ctrl+Shift+R / Ctrl+Shift+D | Split right / split down |
| Alt+Arrow keys | Move focus to the next pane in that direction |
| Alt+1 … Alt+9, Ctrl+PgUp / Ctrl+PgDn | Switch tabs |
| Ctrl+Shift+L | Start or stop logging the focused pane |

**Session logs.** A log is readable text: colors and cursor movement are removed, and line editing (backspace, carriage-return redraws, long command lines wrapped by the shell) is applied, like PuTTY's "printable output". The Rust core follows each session's output even while not logging, so a log started mid-line still records the whole line. Raw byte logs are not offered yet.

- Start and stop from the toolbar or with Ctrl+Shift+L. A red **REC** marks the pane in the toolbar, and a red dot marks its tab.
- Saved sessions can log automatically from the moment the shell opens.
- Files are named `<session name>_<YYYY-MM-DD_HH-MM-SS>.log`, with `_2`, `_3` and so on if the name is taken, and start and end with a timestamped line.
- The folder defaults to `Documents/GhostKey Logs` and can be changed in Settings.
- Answers typed into login dialogs never pass through the terminal stream, so they are never logged. Everything the server prints is, including any secrets it shows; the session editor and Settings say so.
- If writing fails (disk full, folder removed), logging stops and the error shows in the terminal. The SSH session stays up.

## Snippets and button bar

Snippets are saved commands with a name, an optional group, and a mode. They live in `snippets.json` in the app config folder. Starred snippets appear as buttons on a bar above the terminal; Ctrl+Shift+S opens the full list, where they can be sent, edited or deleted.

- **Type in (default):** the text is pasted into the focused pane and nothing runs until the user presses Enter. Buttons show the name only.
- **Run:** Enter is pressed after the text. Buttons show ⏎ and an orange outline.
- Trailing newlines in a snippet are dropped, so only the mode decides whether it runs.
- **Preview:** running a snippet, or sending one with several lines, first shows the destination (session name, user, host and port), the exact text and the line count. The destination is fixed when the button is pressed, so changing focus during the preview can't redirect it. If the pane disconnects meanwhile, nothing is sent.
- Text is sent with the terminal's paste, so shells that support bracketed paste receive several lines as one paste. The preview warns that other shells may run each line as it arrives.
- Snippets go only to the focused pane, and only when it's connected; the bar's buttons are disabled otherwise. Placeholders are not supported yet. A fuller paste preview for every paste is planned as F15.

## Saved sessions and security

Session details are saved in a plain JSON file. Passwords and passphrases are never written there.

| Data | Where it's stored |
| --- | --- |
| Sessions (name, folder, host, port, user, login method, key path, auto-log) | `sessions.json` in the app's config folder |
| Passwords and key passphrases | Windows Credential Manager, or the Linux Secret Service (GNOME Keyring or KWallet) |
| Known hosts | `known_hosts` in the app's config folder (OpenSSH format) |
| Settings (log folder) | `settings.json` in the app's config folder |
| Snippets | `snippets.json` in the app's config folder |

### Importing sessions

The ⇩ button scans `~/.ssh/config` and PuTTY's saved sessions (the registry on Windows, `~/.putty/sessions` elsewhere), and the user can add another OpenSSH config file. Nothing is saved until the user confirms the preview.

- **OpenSSH config:** every concrete name on a `Host` line becomes a session; wildcard and negated patterns are applied but are not sessions. Values follow OpenSSH: the first value wins, `Host *` and the global section apply, `Include` files are read in place (relative to `~/.ssh`, wildcards in the file name, nesting stops at 16), and `~`, `%h`, `%r`, `%u`, `%d` are expanded. Missing `User` uses the local user name, and a missing `IdentityFile` uses the first default key that exists, as ssh would; the preview says so. `Match` blocks are skipped and reported.
- **PuTTY:** host (including `user@host`), port, user and key file. Telnet, serial and other non-SSH sessions are skipped and listed.
- **Never run, always reported:** `ProxyCommand`, `ProxyJump`, port forwards, proxies and any other setting GhostKey can't use are listed for each session. Imported sessions connect directly until jump hosts exist.
- **Duplicates:** a session for the same user, host and port, or with the same name, starts as "Skip". It can be switched to "Update" (keeps the saved name, folder and options; replaces host, port, user and key) or "Add as a new session" (gets a "(2)" name).
- No passwords are read; PuTTY and OpenSSH configs don't hold them. Source files are only read.

## Build, test and packaging

- **CI:** GitHub Actions checks, tests and builds every push on Windows and Linux.
- **Tests:** Rust unit tests cover the session store, link detection and host-key checks. Integration tests run against a real OpenSSH server.
- **Packages:** `.msi` and `.exe` installers for Windows, plus `.deb`, `.rpm` and AppImage for Linux, all built with Tauri's bundler. Signing the Windows installers needs a paid certificate, so that's decided later.

## Milestones

1. Spec approved (this file).
2. Alpha: Kali-themed terminal, login by password, key or keyboard-interactive, host-key checks, Tailscale sign-in links, and saved sessions.
3. Testing against real servers, then the first packaged release.
4. v0.2: tabs, split panes and session logging.
