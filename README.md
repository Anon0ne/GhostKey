# GhostKey

A modern SSH client for Windows and Linux that looks like the Kali Linux terminal.

![GhostKey with two panes side by side, one of them logging](docs/screenshots/split-panes.png)

> **Status: beta (0.3.0).** Everything planned for 1.0 is in, and it needs testing on real servers and devices. Please report anything odd. [docs/BETA_TESTING.md](docs/BETA_TESTING.md) lists what to try.

## What's in the beta

- **Kali look:** Kali-Dark colors and Fira Code, taken from Kali's own QTerminal settings. Folder and file colors from `ls` and the bold `user@host` prompt look the same as on Kali.
- **Login:** password, keyboard-interactive, and private keys (OpenSSH or PuTTY `.ppk`, with or without a passphrase).
- **Host-key checks:** you confirm a new server's fingerprint once. If a known server's key changes, GhostKey blocks the connection and warns you.
- **Saved sessions:** sorted into folders, with search. Passwords are stored in your system keychain (Windows Credential Manager, or GNOME Keyring / KWallet on Linux), never in a file.
- **Tailscale SSH:** when a server in check mode sends a sign-in link, GhostKey shows it with an **Open in browser** button and waits for you to approve. You can set it to open the link automatically for each session.
- **Tabs and split panes (new in 0.2):** open as many sessions as you like in tabs, and split any tab side by side or top and bottom. Each pane has its own connection and Reconnect button. When a tab is split, each pane has a × in its corner that disconnects and closes it. Splitting a connected pane opens a second shell on the same server. **View → Move pane to new tab** or **Move pane to tab…** moves a pane, still connected, to where you want it.
- **Import (new):** bring in sessions from `~/.ssh/config` and PuTTY with the ⇩ button. You see everything first, pick what to import, and fix names or users. Sessions you already have are skipped unless you choose to update them. GhostKey only reads those files, never runs commands from them, and tells you what it couldn't bring over (such as ProxyJump or port forwards).
- **Snippets and button bar (new):** save commands you type often, sorted into groups, and star them to get a button above the terminal. A snippet either types its text in and waits for you to press Enter (the default) or runs it. Running, or sending several lines or control characters, first shows exactly what will be sent and to which server, using the same review as pasting. Ctrl+Shift+S opens the list.
- **File browser (new):** press **Files** (Ctrl+Shift+E) to browse the server over SFTP beside the terminal, using the same login. Download files or whole folders to a folder you pick, upload files with the ⇧ button, folders with ⇪, or either by dropping them on the panel, and create folders, rename, or delete. Each transfer shows its progress and can be cancelled. A file is written under a temporary name and renamed only when it is complete, and GhostKey asks before replacing an existing file. Copying a folder over an existing one merges into it only if you say so; links and special files inside a folder are skipped, and names from the server that could point outside the chosen folder are refused. If a server has no SFTP, the panel says so and the terminal is unaffected.
- **Tunnels and jump hosts (new):** save port forwards with a session: local (`-L`), remote (`-R`), and SOCKS proxies (`-D`). You can type them the OpenSSH way, such as `-L 8080:db:5432`. They start when the session connects, listen on 127.0.0.1 unless you explicitly allow other computers, and stop when it disconnects. **Tunnels** in the toolbar shows each tunnel's address, open connections and errors (such as a port already in use), and lets you stop, retry, or add a temporary one. A session can also connect through another saved session as a jump host, like `ssh -J`, and that one can have its own jump host, up to five deep (the editor shows the whole route). Each server's host key is checked and each asks for its own login.
- **Session logging (new in 0.2):** save what a session prints to a timestamped text file, with colors removed. Start and stop it from the toolbar, or set a saved session to log automatically. Choose the folder in Settings.
- **Reconnects on its own (new):** when a connection drops (Wi-Fi changes, the server reboots, the computer wakes from sleep), GhostKey says so in the terminal and tries again after 2, 4, 8, 16 and 30 seconds. The toolbar shows the countdown with **Reconnect now** and **Cancel**. It asks for a password again if one isn't saved, gives up on a refused login, and never reconnects after you type `exit` or press Disconnect. Saved tunnels set to start on connect come back with it. Each reconnect is a new shell, so programs from the old one are gone. Turn it off in Settings.
- **Tags and production warnings (new):** give a session tags and an environment (Production, Staging, Development or Lab) in its settings. The environment shows as a badge with an icon and text in the session list, the tab and the toolbar. Search matches tags (`#web`) and environments (`prod`). Snippets sent to a production session are always reviewed first, paste reviews and broadcast say when production is included, and choosing production terminals for broadcast needs an extra confirmation.
- **SSH agent and keys (new):** sessions can log in with keys from ssh-agent, the Windows OpenSSH agent or Pageant (choose **SSH agent / Pageant** as the login method), falling back to a password. **File → SSH keys** shows the agent's keys, adds a key file to the agent, shows any key's type, fingerprint and public key, creates Ed25519, ECDSA or RSA keys with an optional passphrase, and saves a PuTTY, PEM or OpenSSH key as a new OpenSSH file with a new passphrase. GhostKey never replaces an existing file, private keys are written readable only by you, and keys held by the agent can't be exported. Key paths can start with `~`.
- **Connection diagnostics (new):** when a connection fails, the toolbar says which stage it stopped at (looking up the address, the network connection, the SSH handshake, the server's identity, logging in, the jump host, or starting the shell) and the terminal suggests what to try next. **Diagnostics** (also in the Session menu) lists every stage with its timing and has **Copy diagnostics** for a report you can share. Host names, user names and addresses are left out unless you tick the box, and sign-in tokens and your local account name are always removed.
- **Broadcast input (new):** type into several terminals at once, across tabs. Choose them in **Session → Broadcast input…** or with Ctrl+Shift+I. A yellow bar lists every terminal in the group and each one gets an outline. Pastes and snippets show every destination before anything is sent. A terminal that disconnects or reconnects leaves the group, so a new connection never joins without being chosen, and login prompts are never broadcast.
- **tmux (new):** give a saved session a tmux session name and it attaches to that session on connect, creating it if needed, so programs keep running when the connection drops and a reconnect picks up where you were. **Session → tmux sessions…** lists what's running on the server and opens one in a new tab, or starts a new one. Without tmux on the server you get an ordinary shell. Names are checked and quoted, and GhostKey never ends a tmux session; closing the tab only detaches.
- **Evidence bookmarks (new):** select text and press Ctrl+Shift+M (or **Edit → Bookmark selection…**) to keep it with a note, the session it came from and the time. The excerpt is kept as selected, even after it scrolls away. **Edit → Bookmarks…** lists them, lets you make a redacted copy beside the untouched original (with suggestions for passwords, tokens and keys), and exports the ones you tick as Markdown or JSON. Exports say which excerpts are redacted copies and that this isn't a forensic record. Bookmarks are stored in `bookmarks.json`, readable only by you.
- **Local terminal, Telnet and serial (new):** **File → New local terminal** (Ctrl+Shift+N) opens a shell on this computer in a tab: PowerShell on Windows, your login shell elsewhere, or any program you set in **Settings → Terminal → Local shell** (such as `pwsh`, `cmd.exe` or `wsl.exe`). Splitting it opens another local shell. In **New session**, set **Type** to **Telnet** for old switches and routers (the editor warns that Telnet sends passwords as plain text) or to **Serial port** for a console cable: pick the port (GhostKey lists the ones it finds), the speed and the line settings (data bits, parity, stop bits, flow control). These terminals get logging, Find, snippets, broadcast and bookmarks like SSH ones; files, tunnels and tmux need SSH, so they're hidden there.
- **Updates (new):** GhostKey checks GitHub for a newer release when it starts (turn this off, or leave out alpha and beta builds, in **Settings → Updates**) and shows **Update: x.y.z** at the top right. **Help → Check for updates…** checks at once. The dialog shows the release notes and opens the release page; on Windows and the AppImage, a signed release can be installed in place with **Install and restart**, after GhostKey checks its signature. `.deb` and `.rpm` installs are updated by downloading the new package. Only the list of releases is fetched; nothing about you or your sessions is sent.
- **Workspaces (new):** **File → Save workspace…** keeps your tabs and splits under a name, with the saved session each pane uses. **File → Open workspace…** shows every pane first and opens the layout in new tabs. Only the panes you tick connect; the rest wait with a **Connect** button, and production sessions start unticked. A workspace holds no passwords or commands.
- **Profiles (new):** **File → Export profile…** saves your sessions, snippets and workspaces to one JSON file, and **Import profile…** brings them in on another computer. Before importing you see what's new, what differs from yours and what's already the same; your own versions are kept unless you choose to replace them, and nothing is deleted. Passwords and passphrases are never exported, and key paths under your home folder are written as `~/…`. Key files themselves aren't copied.
- **Menu bar and Settings (new):** File, Edit, View, Session and Help menus across the top, like a normal desktop program. **File → Settings** (Ctrl+,) picks the theme (Kali Dark, Kali Light, Dracula, Solarized Dark, High contrast), font and size, cursor, scrollback, copy on select, a default user and port for Quick connect, and the log folder. Changes show as you make them, and Cancel puts them back. **View** hides the session list (Ctrl+Shift+B) or the snippet bar.

| Tailscale sign-in | New host key | Session editor |
| --- | --- | --- |
| ![Tailscale approval](docs/screenshots/tailscale.png) | ![Host key prompt](docs/screenshots/hostkey.png) | ![Session editor](docs/screenshots/editor.png) |

| Import preview | Snippet preview | File browser |
| --- | --- | --- |
| ![Import preview](docs/screenshots/import.png) | ![Snippet preview before running](docs/screenshots/snippets.png) | ![SFTP file panel beside the terminal](docs/screenshots/files.png) |

| Tunnels | Settings | Menu bar |
| --- | --- | --- |
| ![Live tunnels with one port already in use](docs/screenshots/tunnels.png) | ![Settings](docs/screenshots/settings.png) | ![File menu](docs/screenshots/menu-bar.png) |

| Reconnecting | Broadcast input | Diagnostics |
| --- | --- | --- |
| ![Reconnecting after the connection dropped](docs/screenshots/reconnect.png) | ![One command typed into two terminals](docs/screenshots/broadcast.png) | ![Where a connection stopped, with a report to copy](docs/screenshots/diagnostics.png) |

| SSH keys | Production warning | Open workspace |
| --- | --- | --- |
| ![The agent's keys and a key file's fingerprint](docs/screenshots/ssh-keys.png) | ![Badges, tags and a snippet review for a production session](docs/screenshots/production.png) | ![A workspace's panes, ticked to connect](docs/screenshots/workspaces.png) |

| Two jump hosts | tmux sessions | Evidence bookmark |
| --- | --- | --- |
| ![Logging in through two jump hosts in turn](docs/screenshots/multi-hop.png) | ![tmux sessions on the server](docs/screenshots/tmux.png) | ![A bookmark's original and redacted copy](docs/screenshots/bookmarks.png) |

| Local terminals | Serial session settings | Serial console |
| --- | --- | --- |
| ![Two local shells side by side](docs/screenshots/local-terminal.png) | ![Choosing a serial port, speed and line settings](docs/screenshots/serial-editor.png) | ![Talking to a device over a serial port](docs/screenshots/serial.png) |

## Install the beta

Every push builds installers in GitHub Actions. Open the latest **CI** run on the [Actions tab](../../actions), scroll down to **Artifacts**, and download:

- **GhostKey-Windows:** a `.msi` or `-setup.exe` installer.
- **GhostKey-Linux:** a `.deb` (Debian, Ubuntu, Kali), a `.rpm` (Fedora), or an `.AppImage` (any distribution).

The Windows installers aren't code-signed yet, so SmartScreen will warn you. Click **More info**, then **Run anyway**.

Tagged releases (`v0.3.0` and so on) are published as draft pre-releases on the [Releases page](../../releases).

### Signed updates (for maintainers)

In-place updates need a signing key pair. Make one once, on your own computer, and keep the private key out of the repository:

```sh
npx tauri signer generate -w ~/.tauri/ghostkey.key
```

1. Put the contents of `~/.tauri/ghostkey.key.pub` in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and commit it.
2. In the repository's **Settings → Secrets and variables → Actions**, add `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/ghostkey.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The release workflow then signs the installers and attaches `latest.json`, and copies built with the public key can install that release in place. Without the secret the release still builds and the app points people to the release page. Losing the private key means copies already installed can't take signed updates from a new key, so keep a backup.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+Shift+T | New tab |
| Ctrl+Shift+N | New local terminal |
| Ctrl+Shift+W | Close the focused pane |
| Ctrl+Shift+R / Ctrl+Shift+D | Split right / split down |
| Alt+Arrow keys | Move between panes |
| Alt+1 … Alt+9, Ctrl+PgUp / Ctrl+PgDn | Switch tabs |
| Ctrl+Shift+L | Start or stop logging |
| Ctrl+Shift+S | Snippets |
| Ctrl+Shift+E | Show or hide the file browser |
| Ctrl+Shift+F | Find in the terminal |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste |
| Right-click | Copy the selection, or paste when nothing is selected |
| Ctrl+= / Ctrl+- / Ctrl+0 | Bigger / smaller / default font size |
| Ctrl+Shift+I | Choose terminals to broadcast to, or stop broadcasting |
| Ctrl+Shift+M | Bookmark the selected text as evidence |
| Ctrl+Shift+B | Show or hide the session list |
| Ctrl+, | Settings |
| F10 | Open the menu bar (when focus isn't in the terminal, since htop and mc use F10) |
| Ctrl+click a link | Open it in your browser |

## Where your data lives

| What | Where |
| --- | --- |
| Saved sessions | `sessions.json` in the app config folder (`%APPDATA%\com.anon0ne.ghostkey` on Windows, `~/.config/com.anon0ne.ghostkey` on Linux) |
| Trusted host keys | `known_hosts` in the same folder (OpenSSH format) |
| Passwords and passphrases | Your system keychain, under the service name "GhostKey" |
| Settings | The log folder is in `settings.json` in the app config folder. Theme, font and the other Settings are stored by the app's web view on this computer |
| Snippets | `snippets.json` in the app config folder |
| Workspaces | `workspaces.json` in the app config folder |
| Evidence bookmarks | `bookmarks.json` in the app config folder, readable only by you. Excerpts can include secrets that were on screen |
| Session logs | `Documents/GhostKey Logs` unless you pick another folder in Settings. Logs hold everything the server printed, which can include secrets |

## Building from source

You need Rust (stable), Node.js 20 or later, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Debian or Kali:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
```

Then:

```sh
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # build installers into src-tauri/target/release/bundle
```

### Tests

```sh
npm test                   # frontend: connection lifecycle and split layout
cd src-tauri && cargo test # Rust core
```

The live SSH tests run against a real OpenSSH server. To run them locally, start the throwaway server with `sudo scripts/test-sshd.sh /tmp/gk-sshd`, export the variables it prints, then run `cargo test`.

## Design

See [SPEC.md](SPEC.md) for the full v1 design: scope, theme values, architecture, and how login works.
