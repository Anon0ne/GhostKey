// Portable profiles: export saved sessions, snippets and workspace layouts to
// one JSON file, and import them on another computer. Kept free of DOM code so
// it can be tested. Profiles never hold passwords or passphrases: those live in
// the system keychain, which is never read for an export.

import type { SavedSession } from "./api";
import type { Snippet } from "./snippets";
import { cleanWorkspace, type Workspace } from "./workspace";
import { parseTags } from "./hostLabels";

export const PROFILE_FORMAT = "ghostkey-profile";
export const PROFILE_VERSION = 1;

export interface Profile {
  format: typeof PROFILE_FORMAT;
  version: number;
  exportedAt: string;
  sessions: SavedSession[];
  snippets: Snippet[];
  workspaces: Workspace[];
}

/** Writes paths under the home folder as `~/…`, so they work on another computer. */
export function portablePath(path: string | null, home: string): string | null {
  if (!path || !home) return path;
  const norm = (p: string) => p.replace(/\\/g, "/");
  const h = norm(home).replace(/\/+$/, "");
  const p = norm(path);
  const same = /^[a-z]:/i.test(h) ? p.toLowerCase().startsWith(`${h.toLowerCase()}/`) : p.startsWith(`${h}/`);
  return same ? `~/${p.slice(h.length + 1)}` : path;
}

export function buildProfile(
  data: { sessions: SavedSession[]; snippets: Snippet[]; workspaces: Workspace[] },
  home: string,
  now = new Date(),
): Profile {
  return {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    exportedAt: now.toISOString(),
    // Copy only known fields, so nothing unexpected rides along.
    sessions: data.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.folder,
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      keyPath: portablePath(s.keyPath, home),
      autoOpenTailscale: s.autoOpenTailscale,
      autoLog: s.autoLog,
      forwards: s.forwards,
      jumpSession: s.jumpSession,
      tags: s.tags ?? [],
      environment: s.environment ?? "",
      tmux: s.tmux ?? "",
    })),
    snippets: data.snippets.map((s) => ({ id: s.id, name: s.name, group: s.group, command: s.command, run: s.run, favorite: s.favorite })),
    workspaces: data.workspaces,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max = 512): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function cleanSession(raw: unknown): SavedSession | string {
  if (!raw || typeof raw !== "object") return "not a session";
  const r = raw as Record<string, unknown>;
  const name = str(r.name)?.trim() || "";
  const host = str(r.host)?.trim() || "";
  const username = str(r.username)?.trim() || "";
  const port = typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : null;
  if (typeof r.id !== "string" || !UUID.test(r.id)) return `${name || "A session"}: missing or bad id`;
  if (!name) return "A session has no name";
  if (!host || /\s/.test(host)) return `${name}: bad host`;
  if (!username) return `${name}: no username`;
  if (port === null) return `${name}: bad port`;
  const auth = r.auth === "key" || r.auth === "agent" ? r.auth : "password";
  const keyPath = str(r.keyPath)?.trim() || null;
  if (auth === "key" && !keyPath) return `${name}: key login without a key file`;
  const env = r.environment;
  return {
    id: r.id,
    name,
    folder: str(r.folder)?.trim().replace(/^\/+|\/+$/g, "") ?? "",
    host,
    port,
    username,
    auth,
    keyPath: auth === "key" ? keyPath : null,
    autoOpenTailscale: r.autoOpenTailscale === true,
    autoLog: r.autoLog === true,
    forwards: Array.isArray(r.forwards) ? (r.forwards as SavedSession["forwards"]) : [],
    jumpSession: typeof r.jumpSession === "string" && UUID.test(r.jumpSession) ? r.jumpSession : null,
    tags: Array.isArray(r.tags) ? parseTags(r.tags.filter((t) => typeof t === "string").join(" ")) : [],
    environment: env === "production" || env === "staging" || env === "development" || env === "lab" ? env : "",
    tmux: typeof r.tmux === "string" && /^[A-Za-z0-9_@+=-]{1,64}$/.test(r.tmux) ? r.tmux : "",
  };
}

function cleanSnippet(raw: unknown): Snippet | string {
  if (!raw || typeof raw !== "object") return "not a snippet";
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 200)?.trim() || "";
  const command = str(r.command, 64 * 1024) ?? "";
  if (typeof r.id !== "string" || !UUID.test(r.id)) return `${name || "A snippet"}: missing or bad id`;
  if (!name || !command) return `${name || "A snippet"}: no name or command`;
  return { id: r.id, name, group: str(r.group, 200)?.trim() ?? "", command, run: r.run === true, favorite: r.favorite === true };
}

export type ParseResult = { ok: true; profile: Profile; skipped: string[] } | { ok: false; error: string };

/** Reads a profile file, refusing other formats and newer versions, and setting aside bad entries. */
export function parseProfile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file isn't valid JSON, so it isn't a GhostKey profile (or it's damaged)." };
  }
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.format !== PROFILE_FORMAT) {
    return { ok: false, error: "This isn't a GhostKey profile file." };
  }
  if (typeof r.version !== "number" || r.version < 1) return { ok: false, error: "The profile has no valid version." };
  if (r.version > PROFILE_VERSION) {
    return { ok: false, error: `This profile was made by a newer GhostKey (format ${r.version}). Update GhostKey to import it.` };
  }
  const skipped: string[] = [];
  const keep = <T>(list: unknown, clean: (x: unknown) => T | string): T[] => {
    if (!Array.isArray(list)) return [];
    const out: T[] = [];
    for (const item of list) {
      const c = clean(item);
      if (typeof c === "string") skipped.push(c);
      else out.push(c);
    }
    return out;
  };
  const sessions = keep(r.sessions, cleanSession);
  const snippets = keep(r.snippets, cleanSnippet);
  const workspaces = keep(r.workspaces, (w) => cleanWorkspace(w) ?? "A workspace layout is damaged");
  return {
    ok: true,
    skipped,
    profile: { format: PROFILE_FORMAT, version: PROFILE_VERSION, exportedAt: str(r.exportedAt) ?? "", sessions, snippets, workspaces },
  };
}

export type ImportState = "new" | "same" | "changed";

/** Compares one imported item with what's already saved under its id. */
export function compare<T extends { id: string }>(incoming: T, existing: T[]): ImportState {
  const mine = existing.find((x) => x.id === incoming.id);
  if (!mine) return "new";
  return stable(mine) === stable(incoming) ? "same" : "changed";
}

/** JSON with object keys sorted at every level, so key order doesn't count as a change. */
function stable(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x) ?? "null";
}
