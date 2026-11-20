// Update checks: what to tell people about a newer release. Kept free of DOM
// code so it can be tested; the GitHub request and the install are in Rust.

export interface Release {
  version: string;
  name: string;
  notes: string;
  url: string;
  published: string | null;
  prerelease: boolean;
  manifest: string | null;
}

export interface UpdateCheck {
  current: string;
  available: Release | null;
  canInstall: boolean;
  installNote: string | null;
}

export type UpdateProgress = { type: "progress"; done: number; total: number | null } | { type: "installing" };

const SKIP_KEY = "ghostkey.skipUpdate";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The version the user chose to skip, if any. */
export function skippedVersion(store: Store | null): string | null {
  try {
    return store?.getItem(SKIP_KEY) ?? null;
  } catch {
    return null;
  }
}

export function skipVersion(store: Store | null, version: string) {
  try {
    store?.setItem(SKIP_KEY, version);
  } catch {
    // A convenience; ignore storage failures.
  }
}

/** An automatic check speaks up only for a release that wasn't skipped. A check from the menu always answers. */
export function shouldNotify(check: UpdateCheck, skipped: string | null, manual: boolean): boolean {
  if (!check.available) return false;
  return manual || check.available.version !== skipped;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function progressText(p: UpdateProgress): string {
  if (p.type === "installing") return "Installing… GhostKey will restart.";
  if (!p.total) return `Downloaded ${mb(p.done)}`;
  const pct = Math.min(100, Math.round((p.done / p.total) * 100));
  return `Downloaded ${mb(p.done)} of ${mb(p.total)} (${pct}%)`;
}

/** "Released 20 Nov 2026", or "" when GitHub gave no date. */
export function releasedText(published: string | null, locale?: string): string {
  if (!published) return "";
  const d = new Date(published);
  if (Number.isNaN(d.getTime())) return "";
  return `Released ${d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
}
