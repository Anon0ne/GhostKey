// Path and formatting rules for the SFTP file panel. Kept free of DOM code so it can be tested.

export type Kind = "dir" | "file" | "link" | "other";

export interface Entry {
  name: string;
  kind: Kind;
  /** For a symlink, whether it points at a directory. */
  linkDir: boolean;
  size: number;
  /** Seconds since the Unix epoch. */
  modified: number | null;
  permissions: number | null;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export type TransferEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "failed"; error: string };

/** Whether double-clicking opens the entry as a folder. */
export function isDir(e: Entry): boolean {
  return e.kind === "dir" || (e.kind === "link" && e.linkDir);
}

/** Folders first, then by name, ignoring case. */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const d = Number(isDir(b)) - Number(isDir(a));
    return d || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });
}

/** Remote paths always use `/`, whatever the local OS. */
export function remoteJoin(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function remoteParent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** The last part of a local path, with either separator. */
export function localName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** Joins a local folder and a name with the folder's own separator. */
export function localJoin(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Makes a remote file name safe to save on Windows as well as Linux. */
export function safeLocalName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe || "download";
}

/** A name for a new file or folder: one path part, not "." or "..". */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return "Enter a name";
  if (name.includes("/")) return "A name can't contain /";
  if (name === "." || name === "..") return "Choose another name";
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** `rwxr-xr-x` style permissions, with the type letter first. */
export function formatMode(e: Entry): string {
  if (e.permissions == null) return "";
  const type = e.kind === "dir" ? "d" : e.kind === "link" ? "l" : "-";
  let s = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (e.permissions >> shift) & 7;
    s += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
  }
  return type + s;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.floor((done / total) * 100));
}
