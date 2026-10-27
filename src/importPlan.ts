// Decides what an import does with each found session. Kept free of DOM code
// so it can be tested.

import type { AuthMethod, SavedSession } from "./api";

export interface Candidate {
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath: string | null;
  source: string;
  notes: string[];
}

export interface SourceReport {
  label: string;
  found: boolean;
  error: string | null;
  notes: string[];
}

export interface Scan {
  candidates: Candidate[];
  sources: SourceReport[];
}

/** What to do with a found session that matches one already saved. */
export type DupAction = "skip" | "update" | "add";

export interface Row {
  candidate: Candidate;
  selected: boolean;
  name: string;
  username: string;
  /** A saved session for the same server, or with the same name. */
  existing: SavedSession | null;
  action: DupAction;
}

const sameServer = (s: SavedSession, c: Candidate) =>
  s.host.toLowerCase() === c.host.toLowerCase() && s.port === c.port && s.username === c.username;

/** One row per found session. New ones start selected; duplicates start skipped. */
export function planRows(candidates: Candidate[], sessions: SavedSession[]): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const c of candidates) {
    // The same server can appear in both PuTTY and ~/.ssh/config; list it once.
    const key = `${c.username}@${c.host.toLowerCase()}:${c.port}|${c.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const existing =
      sessions.find((s) => sameServer(s, c)) ?? sessions.find((s) => s.name.toLowerCase() === c.name.toLowerCase()) ?? null;
    rows.push({
      candidate: c,
      selected: !existing && !!c.username,
      name: c.name,
      username: c.username,
      existing,
      action: existing ? "skip" : "add",
    });
  }
  return rows;
}

/** Why the selected rows can't be imported yet, or null when they can. */
export function problem(rows: Row[]): string | null {
  const chosen = rows.filter((r) => r.selected && r.action !== "skip");
  if (chosen.length === 0) return "Choose at least one session to import.";
  const missing = chosen.find((r) => !r.username.trim() || !r.name.trim());
  if (missing) return `Enter a name and user for ${missing.candidate.name || missing.candidate.host}.`;
  return null;
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The sessions to save. Updates keep the saved session's id, name, folder and options. */
export function toSessions(rows: Row[], folder: string, newId: () => string, sessions: SavedSession[]): SavedSession[] {
  const taken = new Set(sessions.map((s) => s.name.toLowerCase()));
  const out: SavedSession[] = [];
  for (const r of rows) {
    if (!r.selected || r.action === "skip") continue;
    const c = r.candidate;
    const auth: AuthMethod = c.keyPath ? "key" : "password";
    const connection = { host: c.host, port: c.port, username: r.username.trim(), auth, keyPath: c.keyPath };
    if (r.existing && r.action === "update") {
      out.push({ ...r.existing, ...connection });
    } else {
      out.push({
        id: newId(),
        name: uniqueName(r.name.trim(), taken),
        folder: folder.trim().replace(/^\/+|\/+$/g, ""),
        ...connection,
        autoOpenTailscale: false,
        autoLog: false,
      });
    }
  }
  return out;
}
