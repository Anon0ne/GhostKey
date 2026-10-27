# GhostKey shared feature roadmap

This is the shared planning and handoff file for Claude, Codex, and human contributors.
It combines the eight features discussed with Claude and ten additional ideas approved
for the roadmap. It is a backlog, not a claim that these features already exist or a
request to implement all eighteen in a single change. SPEC.md describes the original
scope; this file tracks the proposed expansion.

## Pick up work in either AI session

1. Fetch the latest repository state. Read this file, SPEC.md, applicable repository
   instructions, and the implementation before changing anything.
2. Check open PRs and branches and ask about unpushed concurrent work when it overlaps.
   Claude was reported to be working on features F01–F08; exact ownership and completion
   have not been verified. Do not assume those features are unclaimed.
3. Choose a bounded feature slice and update its status, owner/session, branch or PR,
   and next step below. Coordinate before touching files another session owns.
4. Preserve other contributors' changes. Use separate branches and small PRs; do not
   overwrite a shared branch or treat this file as an automatic lock.
5. Add meaningful regression coverage, run the relevant frontend and Rust checks,
   and record results and platform limitations. Keep credentials, private keys, terminal
   secrets, and sensitive target data out of fixtures, logs, and Git.
6. Update the handoff before stopping. Mark Done only with a merged implementation
   and evidence that the acceptance criteria are met; record partial slices explicitly.

Statuses: **Needs coordination**, **Planned**, **In progress**, **Blocked**, **Done**.
Owner “Unconfirmed” means Claude may already have local work; it does not reserve or
release ownership. This file was initialized on 2026-10-27 from the planning conversation.

## Work tracker

| ID | Feature | Status | Owner/session | Branch / PR | Next step |
| --- | --- | --- | --- | --- | --- |
| F01 | Tabs and split panes | Done | Claude | #6 (merged) | Follow-up: move panes between tabs (not started) |
| F02 | Session logging | Done | Claude | #6 (merged) | Follow-up: raw logs and per-line timestamps, with F14/F16 |
| F03 | SFTP file browser | Planned | Claude (queued after F01/F02) | — | Not started; no local work exists yet |
| F04 | Port forwarding and jump hosts | Planned | Claude (queued after F01/F02) | — | Not started; no local work exists yet |
| F05 | SSH agent and key manager | Planned | Claude (queued after F01/F02) | — | Not started; no local work exists yet |
| F06 | Broadcast input | Planned | Claude (queued after F01/F02) | — | Not started; no local work exists yet |
| F07 | Import PuTTY and SSH config sessions | Done | Claude | #7 (merged) | Follow-up: try the PuTTY registry import on Windows |
| F08 | Command snippets and button bar | In progress | Claude | `f08-snippets` | Snippet store, editor, button bar; preview before multiline or run |
| F09 | Connection diagnostics | Planned | — | — | Define connection stages and redacted diagnostics |
| F10 | Network recovery | Planned | — | — | Define recovery policy and cancellation behavior |
| F11 | tmux integration | Planned | — | — | Define explicit attach/create flow |
| F12 | Workspace layouts | Planned | — | — | Coordinate with F01's pane/session model |
| F13 | Host identity guardrails | Planned | — | — | Define host labels and production designation |
| F14 | Searchable terminal history | Planned | — | — | Define scrollback search and retention choices |
| F15 | Safe paste preview | Planned | — | — | Cover every paste entry point |
| F16 | Evidence bookmarks | Planned | — | — | Define selection metadata and export format |
| F17 | Portable session profiles | Planned | — | — | Define versioned export/import format |
| F18 | Local terminal tabs | Planned | — | — | Define local PTY lifecycle on both platforms |

## Feature definitions and acceptance criteria

### F01 — Tabs and split panes

Run several independent SSH sessions in one window, with horizontal or vertical splits.
Support opening, switching, resizing, moving, and closing panes with keyboard shortcuts.
Each pane owns its terminal, connection state, prompts, and reconnect action. Closing or
reconnecting one pane must not interrupt another; identify the focused destination clearly.
Verify independent input/output, terminal resizing, prompt routing, and pane cleanup.

### F02 — Session logging

Save session output to timestamped files, manually or automatically for selected saved
sessions. Provide a visible recording indicator, destination choice, and stop action.
Define raw versus readable output and timestamp behavior. Do not capture credential prompt
answers; warn that remote output can itself contain secrets. Handle disk errors visibly
without dropping SSH. Verify independent logs, filename collisions, and start/stop behavior.

### F03 — SFTP file browser

Browse remote directories and upload/download files through the authenticated SSH transport
where supported, without asking the user to log in again. Include drag and drop, progress,
cancel, destination selection, and explicit overwrite handling. Unsupported SFTP must leave
the terminal usable. Test binary transfers, large files, permissions, and interrupted transfers.

### F04 — Port forwarding and jump hosts

Save local, remote, and dynamic SOCKS forwarding rules and ProxyJump-style bastion routes
with sessions. Show active tunnels, bind addresses, errors, and stop controls. Default local
listeners to loopback; make broader exposure explicit. Verify host keys at every SSH hop,
handle unavailable destinations and occupied ports, and clean up listeners on disconnect.
Start with a bounded tunnel type before adding the full combination matrix.

### F05 — SSH agent and key manager

Use supported ssh-agent and Pageant integrations, with clear platform support and fallback.
Offer key generation, fingerprint inspection, and supported format conversion. Private-key
operations belong in Rust; never export agent-held private keys or silently overwrite files.
Protect generated keys with appropriate permissions and optional passphrases. Test missing
agents, locked keys, signing failures, and encrypted-key conversion on supported platforms.

### F06 — Broadcast input

Explicitly select target panes and send keyboard input to that group. Show a persistent
broadcast indicator and target list, with a quick off switch. Exclude authentication dialogs
and disconnected panes; a newly connected pane must not silently join. Integrate F13 and
F15 so production warnings and paste previews name every destination. Test selection changes,
partial disconnects, and prevention of input reaching unselected sessions.

### F07 — Import PuTTY and ~/.ssh/config sessions

Preview imported sessions and let users select entries, map fields, and resolve duplicates
before saving. Support the appropriate PuTTY sources for each platform and useful SSH config
Host entries. Report unsupported directives instead of silently changing their meaning.
Do not execute ProxyCommand, Match exec, or other imported commands during parsing. Define
Include, wildcard, and precedence handling; preserve the source files and avoid importing secrets.

### F08 — Command snippets and button bar

Save named commands, organize them, and expose favorites as terminal buttons. Distinguish
inserting text from executing it; make the behavior visible and default to insertion.
Support multiline preview and destination checks through F15. If placeholders are added,
show the fully substituted command before execution and do not store secret answers.
Verify correct focused-pane routing, editing, deletion, and persistence.

### F09 — Connection diagnostics

Show progress and failure stages: DNS, TCP connection, SSH handshake, host-key verification,
authentication, and shell startup. Offer a relevant next action and Copy diagnostics.
Include useful error codes and timing while redacting credentials and sign-in tokens; allow
review before copying host-identifying details. Keep errors visible beside retry controls.
Test representative failures at each stage and stale errors after retry.

### F10 — Network recovery

Detect sleep/wake, network changes, and lost transports. Offer reconnect and optional bounded
retry with backoff, clear status, and cancellation. Preserve settings and existing sign-in
state where valid; prompt again when authentication requires it. Never replay commands or
silently restore tunnels without the configured policy. Explain that ordinary reconnect
starts a new remote shell; F11 provides optional session continuity. Test repeated failures,
manual disconnect, wake events, and late callbacks from obsolete attempts.

### F11 — tmux integration

Offer an opt-in way to list, attach to, or create remote tmux sessions, including reconnecting
to the selected session. Detect tmux availability and fall back to ordinary SSH. Safely quote
session names, explain shared-session attachment, and never kill remote sessions implicitly.
Verify that a remote command survives a transport drop and can be resumed without replay.

### F12 — Workspace layouts

Save named groups of tabs, panes, session references, and layout proportions. Preview and
restore the arrangement, then let users explicitly connect the selected sessions. Do not
store terminal secrets or automatically execute commands as part of restoring a layout.
Handle missing or edited sessions and different screen sizes. Depends on F01's model;
verify layout round trips and that opening a workspace alone makes no network connections.

### F13 — Host identity guardrails

Give hosts persistent labels and optional environment classifications such as production,
lab, or staging. Show the actual host and username alongside custom names; use text and
icons as well as color. Keep the focused destination obvious in tabs, panes, paste previews,
and snippets. Warn prominently when a broadcast group includes production hosts. Verify
that labels follow session edits and reconnects without becoming misleading.

### F14 — Searchable terminal history

Search current scrollback and optionally all open terminal panes, with match navigation,
source labels, and copy controls. Persistent history is opt-in with retention and clear/delete
controls. Do not invent timestamps for output captured without them. Keep matching responsive
on large buffers and specify behavior for ANSI controls and full-screen applications.
Coordinate shared capture/storage with F02 and F16 instead of duplicating terminal streams.

### F15 — Safe paste preview

Preview multiline pastes before they reach the terminal, showing the destination host(s),
line count, and exact content. Offer cancel, paste, and an explicit execution choice where
applicable. Cover keyboard shortcuts, context-menu paste, clipboard actions, and snippets;
account for bracketed paste mode and trailing newlines. Test that cancellation sends no bytes
and that changing focus or broadcast targets cannot redirect an already approved paste.

### F16 — Evidence bookmarks

Select terminal output, add a note, and export chosen excerpts with session identity and
capture timestamps when available. Preserve an original excerpt separately from redacted
exports; make edits and redactions explicit. Do not promise forensic integrity from ordinary
text logs. Define behavior when scrollback is evicted and when bookmarks contain secrets.
Coordinate F02/F14 capture and retention; test Unicode, multiline excerpts, and export metadata.

### F17 — Portable session profiles

Export/import versioned session settings and workspace layouts without credentials by default.
Preview conflicts, validate imported data, and map platform-specific paths. A later encrypted
option may include explicitly selected sensitive configuration using a reviewed encryption
library and authenticated format; do not invent custom cryptography. Test round trips,
unknown versions, corrupt files, wrong passwords, and proof that default exports omit secrets.

### F18 — Local terminal tabs

Run the user's local shell alongside SSH terminals with the same pane controls, fonts,
shortcuts, search, and paste safeguards. Use a native PTY on Linux and the appropriate Windows
PTY support, with correct resizing, process cleanup, and interactive application behavior.
Label local terminals distinctly. Verify PowerShell on Windows and a supported Linux shell;
closing a tab must handle its child processes without interrupting other terminals.

## Suggested sequencing

- Coordinate and review Claude's existing F01–F08 work first; do not start duplicate builds.
- Prioritize F09 diagnostics, F15 paste safeguards, and F11 tmux resume as bounded additions.
- Build F12 workspace layouts and F18 local terminals on F01's established lifecycle.
- Coordinate F02/F14/F16 around one output capture and metadata model.
- Integrate F06 broadcast, F08 snippets, F13 host labels, and F15 paste through a consistent
  destination-selection policy. Avoid shipping a broadcast path that bypasses those checks.
- Finalize F17 after session/workspace formats stabilize. Keep F04/F05 platform and protocol
  work in separately testable slices rather than coupling it to UI-only features.

## Verification and release handoff

Run `npm test` and `npm run build` for frontend changes. For native changes, run the relevant
Rust formatting, Clippy, and tests in src-tauri, including live SSH tests where applicable.
Record Windows and Linux coverage separately; a successful package build does not prove
interactive behavior. Check that CI runs new tests and that the Release workflow packages
both platforms. Keep package.json, package-lock.json, Cargo.toml, Cargo.lock, and
tauri.conf.json versions aligned when making a release. Do not publish a release merely
because a feature was added to this file.

### Session handoff template

Copy this block into a dated entry below when starting or stopping work:

- Date / AI session / contributor:
- Feature IDs and bounded scope:
- Branch / PR / base commit:
- Status and files owned or touched:
- Implemented behavior and remaining acceptance criteria:
- Checks run and results (including platform):
- Known failures, decisions, and dependencies:
- Exact next step / coordination needed:

### Handoff entries

- 2026-10-27 — Codex: initialized this shared backlog from the user's combined list.
  F01–F08 implementation status needs reconciliation with Claude's current session.
  No feature implementation or completion is claimed by this documentation change.
- 2026-10-27 — Claude: reconciled F01–F08. Only F01 and F02 have work, on branch `v0.2`
  (base eea8de2). F03–F08 have no code yet; Claude plans to take them after v0.2 in that
  order, but they are not locked, so say so here before starting one.
  - F02 done so far: `src-tauri/src/logging.rs` writes readable text (colors and cursor
    movement removed, line edits applied, like PuTTY's "printable output") to
    `<label>_<YYYY-MM-DD_HH-MM-SS>.log`, with `_2`, `_3` on collisions. Prompt answers never
    pass through the output stream, so they are never logged. A disk error stops the log
    and reports it without dropping SSH. `settings.rs` stores the log folder
    (default `Documents/GhostKey Logs`). Saved sessions gain `autoLog`.
  - Checks: cargo fmt, clippy `-D warnings`, cargo test including live sshd test (Linux).
  - Files owned until v0.2 merges: `src/main.ts` (being split into connection, pane and
    layout modules), `tests/connection.test.mjs` (porting to the new controller with the
    same coverage), `src-tauri/src/{ssh,lib,logging,settings,sessions}.rs`, styles, index.html.
  - Next: F01 frontend, logging UI, README/SPEC, bump to 0.2.0, then tag `v0.2.0` after merge.
- 2026-10-27 — Claude: F01 and F02 implemented on `v0.2` (PR #6), version bumped to 0.2.0.
  - F01: `src/connection.ts` (DOM-free connection lifecycle, Codex's stale-callback guards
    kept), `src/pane.ts` (one xterm, banner, prompt set and Connection per pane),
    `src/layout.ts` (pure split tree and directional focus), `src/main.ts` (tabs, toolbar
    for the focused pane, shortcuts). Login dialogs name their session, switch to its pane
    and are shown one at a time. Closing a pane or tab asks first when connected.
    Not done: moving a pane between tabs or positions (drag and drop), restoring layouts
    (F12).
  - F02: the core follows each session's output all the time (`LineLog`), so a log
    started after the prompt still records whole lines, including commands the shell
    wrapped at the terminal width. Toolbar Start/Stop log, REC indicator, red tab dot,
    Ctrl+Shift+L, per-session auto-log, and a Settings dialog for the folder. Readable
    text only; header and footer carry timestamps, lines do not. Raw logs and per-line
    timestamps are open, and should be designed with F14/F16.
  - Checks (Linux): `npm test` 14 pass (connection lifecycle including the 6 Codex
    reconnect cases, logging state, split layout); `npm run build`; cargo fmt, clippy
    `-D warnings`, `cargo test` 23 pass including the live sshd test. Release build run
    under Xvfb against a local sshd: splits, auto-log, close pane, new tab, Alt+1, and the
    Settings dialog checked by hand. Windows: CI build only, not tested interactively.
  - Known: a password dialog left open past the server's LoginGraceTime fails with
    russh's "Unable to receive more messages from the channel"; a clearer message
    belongs in F09.
  - Next: merge #6, push tag `v0.2.0`. Then Claude intends to start F07 (imports) or F08
    (snippets) unless someone claims them here first.
- 2026-10-27 — Claude: #6 merged (F01, F02 Done; acceptance evidence in the entry above).
  Tag `v0.2.0` still needs pushing by a person: this session's GitHub access can't create
  tags. Started F07 on branch `f07-import` from a7167f1. Owns `src-tauri/src/import.rs`
  (new) and an import dialog in the frontend.
- 2026-10-27 — Claude: Justin pushed tag `v0.2.0`; the release built and he tested it on
  Linux. F07 implemented on `f07-import`.
  - `src-tauri/src/import.rs` reads ~/.ssh/config (Include with wildcards and a depth limit
    of 16, first-value-wins, `Host *`, negated patterns, `%` tokens) and PuTTY sessions
    (registry via `winreg` on Windows, `~/.putty/sessions` elsewhere). It never executes
    anything: ProxyCommand, ProxyJump, Match, forwards and other settings are reported
    per session. `src/importPlan.ts` holds the duplicate rules (skip by default, update
    keeps id/name/folder/options, add gives a unique name); the dialog lives in `main.ts`.
  - Checks (Linux): 35 Rust tests (12 import), 22 frontend tests (8 import); real app
    imported 3 sessions from a sample config and PuTTY folder, skipped a duplicate, and
    listed a telnet session as skipped. The Windows registry reader was compiled for
    `x86_64-pc-windows-gnu` in isolation but not run on Windows.
  - Next: Claude plans F08 (snippets) after this merges.
- 2026-10-27 — Claude: #7 merged (F07 Done). Started F08 on `f08-snippets` from f5a8ed8.
  Owns `src-tauri/src/snippets.rs` (new), `src/snippets.ts` (new) and the snippet UI.
  F15 (safe paste preview) is not built; F08 will include a small preview for multiline
  and run-mode snippets that names the destination, which F15 can later replace.
