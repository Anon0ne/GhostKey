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
| F01 | Tabs and split panes | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F02 | Session logging | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F03 | SFTP file browser | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F04 | Port forwarding and jump hosts | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F05 | SSH agent and key manager | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F06 | Broadcast input | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F07 | Import PuTTY and SSH config sessions | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
| F08 | Command snippets and button bar | Needs coordination | Unconfirmed | — | Check Claude's current implementation |
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
