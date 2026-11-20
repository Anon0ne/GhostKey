// Evidence bookmarks: export and redaction helpers. Kept free of DOM code so
// they can be tested. Excerpts are copies of what was on screen; they are not
// a forensic record, and exports say so.

export interface BookmarkSource {
  name: string;
  username: string;
  host: string;
  port: number;
  sessionId: string | null;
  environment: string;
}

export interface Bookmark {
  id: string;
  /** When the bookmark was made (ISO 8601), not when the text was printed. */
  createdAt: string;
  source: BookmarkSource;
  note: string;
  /** The text exactly as selected. Never changed after saving. */
  original: string;
  /** A copy with secrets removed by hand, if one was made. */
  redacted: string | null;
}

export const NOT_FORENSIC =
  "Copied from GhostKey's terminal screen. Times are when each excerpt was bookmarked, not when it was printed. This is not a forensic record.";

/**
 * Suggests a redacted copy: hides values after words like password or token,
 * bearer tokens, private key blocks and common cloud key formats. The result
 * is a starting point for the user to check, never applied on its own.
 */
export function suggestRedaction(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b([A-Za-z0-9_.-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth))(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED GITHUB TOKEN]");
}

function where(s: BookmarkSource): string {
  return `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}`;
}

/** A code fence longer than any run of backticks in `text`, so the excerpt can't end it early. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export interface ExportOptions {
  /** Use each redacted copy where one was made, instead of the original. */
  redacted: boolean;
  exportedAt?: Date;
}

/** The text an export uses for `b`, and which version it is. */
export function excerptFor(b: Bookmark, opts: ExportOptions): { text: string; version: "original" | "redacted" } {
  return opts.redacted && b.redacted !== null ? { text: b.redacted, version: "redacted" } : { text: b.original, version: "original" };
}

export function toMarkdown(list: Bookmark[], opts: ExportOptions): string {
  const at = (opts.exportedAt ?? new Date()).toISOString();
  const out = [`# GhostKey bookmarks`, "", `Exported ${at}. ${NOT_FORENSIC}`, ""];
  if (opts.redacted) out.push("Excerpts marked *redacted copy* were edited by hand to remove secrets; the others are the original text.", "");
  for (const b of list) {
    const { text, version } = excerptFor(b, opts);
    const f = fence(text);
    out.push(`## ${b.source.name || where(b.source)} · ${b.createdAt}`, "");
    out.push(`- Session: ${b.source.name} (${where(b.source)})${b.source.environment ? `, ${b.source.environment}` : ""}`);
    out.push(`- Bookmarked: ${b.createdAt}`);
    out.push(`- Excerpt: ${version === "redacted" ? "*redacted copy*" : "original"}`);
    if (b.note.trim()) out.push("", ...b.note.trim().split("\n").map((l) => `> ${l}`));
    out.push("", f, text.replace(/\n$/, ""), f, "");
  }
  return out.join("\n");
}

export function toJson(list: Bookmark[], opts: ExportOptions): string {
  return JSON.stringify(
    {
      format: "ghostkey-bookmarks",
      version: 1,
      exportedAt: (opts.exportedAt ?? new Date()).toISOString(),
      notice: NOT_FORENSIC,
      bookmarks: list.map((b) => {
        const { text, version } = excerptFor(b, opts);
        return { id: b.id, bookmarkedAt: b.createdAt, source: b.source, note: b.note, excerpt: text, excerptVersion: version };
      }),
    },
    null,
    2,
  );
}
