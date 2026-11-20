// App preferences shown in Settings. Kept free of DOM code so it can be tested.

export type CursorStyle = "block" | "bar" | "underline";

export interface Prefs {
  theme: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
  showSidebar: boolean;
  showSnippetBar: boolean;
  /** Used by Quick connect when the address has no user, and for new sessions. */
  defaultUser: string;
  defaultPort: number;
  /** Reconnect on its own when a connection drops, e.g. after sleep or a network change. */
  autoReconnect: boolean;
  /** Program for File → New local terminal; empty for the system's default shell. */
  localShell: string;
}

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 32;
export const MIN_SCROLLBACK = 1000;
export const MAX_SCROLLBACK = 200000;

/** Bundled font first; the rest are used when installed. */
export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Fira Code (bundled)", value: '"Fira Code", "DejaVu Sans Mono", Consolas, monospace' },
  { label: "Cascadia Mono", value: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  { label: "Consolas", value: 'Consolas, "DejaVu Sans Mono", monospace' },
  { label: "DejaVu Sans Mono", value: '"DejaVu Sans Mono", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace' },
  { label: "System monospace", value: "monospace" },
];

export const DEFAULT_PREFS: Prefs = {
  theme: "kali-dark",
  fontFamily: FONT_CHOICES[0].value,
  // Kali's QTerminal default is Fira Code 10 pt, which is about 13.3 px.
  fontSize: 14,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  showSidebar: true,
  showSnippetBar: true,
  defaultUser: "",
  defaultPort: 22,
  autoReconnect: true,
  localShell: "",
};

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Fills in defaults and clamps anything out of range, so a damaged store never breaks the app. */
export function normalizePrefs(raw: unknown, themes: string[]): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    theme: typeof r.theme === "string" && themes.includes(r.theme) ? r.theme : d.theme,
    fontFamily: typeof r.fontFamily === "string" && FONT_CHOICES.some((f) => f.value === r.fontFamily) ? r.fontFamily : d.fontFamily,
    fontSize: int(r.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, d.fontSize),
    cursorStyle: r.cursorStyle === "bar" || r.cursorStyle === "underline" || r.cursorStyle === "block" ? r.cursorStyle : d.cursorStyle,
    cursorBlink: bool(r.cursorBlink, d.cursorBlink),
    scrollback: int(r.scrollback, MIN_SCROLLBACK, MAX_SCROLLBACK, d.scrollback),
    copyOnSelect: bool(r.copyOnSelect, d.copyOnSelect),
    showSidebar: bool(r.showSidebar, d.showSidebar),
    showSnippetBar: bool(r.showSnippetBar, d.showSnippetBar),
    defaultUser: typeof r.defaultUser === "string" ? r.defaultUser.trim().slice(0, 64) : d.defaultUser,
    defaultPort: int(r.defaultPort, 1, 65535, d.defaultPort),
    autoReconnect: bool(r.autoReconnect, d.autoReconnect),
    localShell: typeof r.localShell === "string" ? r.localShell.trim().slice(0, 512) : d.localShell,
  };
}

export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "ghostkey.prefs";

/** Reads saved prefs, carrying over the font size saved before Settings existed. */
export function loadPrefs(store: PrefStore | null, themes: string[]): Prefs {
  let raw: Record<string, unknown> = {};
  try {
    const text = store?.getItem(KEY);
    if (text) raw = JSON.parse(text);
    else {
      const old = store?.getItem("ghostkey.fontSize");
      if (old) raw = { fontSize: Number(old) };
    }
  } catch {
    // Damaged or unavailable storage: use the defaults.
  }
  return normalizePrefs(raw, themes);
}

export function savePrefs(store: PrefStore | null, prefs: Prefs) {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}
