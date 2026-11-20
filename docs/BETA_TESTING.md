# Testing the 0.3.0 beta

Install the beta from the [Releases page](../../../releases) (or the latest CI run's artifacts), then work through what applies to you. Tick what works, and for anything that doesn't, note what you did, what you expected and what happened. **Session → Connection diagnostics… → Copy diagnostics** gives a report that's safe to paste.

Most of this was tested on Linux against a local OpenSSH server. The items marked **(untested)** couldn't be checked without real hardware or Windows, so they matter most.

## Everyday SSH

- [ ] Connect with a password, a key file and (if you use one) ssh-agent or Pageant **(Pageant and the Windows agent untested)**.
- [ ] Split right and down, move between panes with Alt+arrows, move a pane to another tab (View menu).
- [ ] Right-click copies the selection or pastes. A multi-line paste asks first.
- [ ] Find (Ctrl+Shift+F), session log (Ctrl+Shift+L), snippets bar.
- [ ] Files (Ctrl+Shift+E): upload and download a file and a folder.
- [ ] Tunnels: a saved `-L` forward starts on connect.

## New in the beta

- [ ] **Settings** (Ctrl+,): change theme, font and cursor; Cancel puts them back.
- [ ] **Reconnect:** turn Wi-Fi off and on, or sleep the computer, with a session open. It should come back on its own.
- [ ] **Broadcast** (Ctrl+Shift+I): type into two terminals at once; stop it.
- [ ] **Diagnostics:** connect to a wrong port or host and open Diagnostics.
- [ ] **File → SSH keys:** make a new key, see its fingerprint, add one to the agent.
- [ ] **Tags and Production:** mark a session Production; a snippet to it asks first; the badge shows on the tab.
- [ ] **Workspaces:** save your tabs (File → Save workspace…), close them, open the workspace again.
- [ ] **Profiles:** export a profile and import it on another computer (passwords aren't included).
- [ ] **Jump hosts:** a session through one or two jump hosts.
- [ ] **tmux:** give a session a tmux name, run something, disconnect, reconnect, and it's still there.
- [ ] **Bookmarks** (Ctrl+Shift+M): bookmark selected text, make a redacted copy, export as Markdown.
- [ ] **Local terminal** (Ctrl+Shift+N): PowerShell opens on Windows **(untested)**; try `pwsh` or `wsl.exe` in Settings → Terminal → Local shell **(untested)**.
- [ ] **Telnet:** an old switch or router, if you have one **(untested on real devices)**.
- [ ] **Serial:** a USB console cable to a router or board, at its speed (often 9600 or 115200) **(untested on real hardware)**.
- [ ] **Updates:** Help → Check for updates… answers. In-place installs need the signing key set up first (README, "Signed updates").

## Known gaps

- The Windows installers aren't code-signed, so SmartScreen warns.
- `.deb` and `.rpm` installs can't update themselves; the update dialog links to the release page.
- Each reconnect starts a new shell unless the session uses tmux.
