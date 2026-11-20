// Session tags and environment labels (production, staging, …). Kept free of
// DOM code so it can be tested.

export type Environment = "" | "production" | "staging" | "development" | "lab";

export const ENVIRONMENTS: { value: Environment; label: string; badge: string; icon: string }[] = [
  { value: "", label: "Not set", badge: "", icon: "" },
  { value: "production", label: "Production", badge: "PROD", icon: "⚠" },
  { value: "staging", label: "Staging", badge: "STAGING", icon: "◆" },
  { value: "development", label: "Development", badge: "DEV", icon: "●" },
  { value: "lab", label: "Lab", badge: "LAB", icon: "⚗" },
];

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

export function envInfo(env: string | null | undefined) {
  return ENVIRONMENTS.find((e) => e.value === env && e.value !== "") ?? null;
}

/** Badge text with its icon, e.g. "⚠ PROD", so it doesn't rely on color. */
export function envBadge(env: string | null | undefined): string {
  const e = envInfo(env);
  return e ? `${e.icon} ${e.badge}` : "";
}

export function isProduction(env: string | null | undefined): boolean {
  return env === "production";
}

/** Splits "web, db  #prod" into clean tags: trimmed, no leading #, no duplicates (ignoring case). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\s]+/)) {
    const tag = raw.replace(/^#+/, "").trim().slice(0, MAX_TAG_LENGTH);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

export interface Searchable {
  name: string;
  folder: string;
  host: string;
  username: string;
  tags?: string[];
  environment?: string;
}

/**
 * Whether a session matches the search box. Every word must match something.
 * "#web" matches only a tag; "prod" also matches the environment.
 */
export function matchesSearch(s: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tags = (s.tags ?? []).map((t) => t.toLowerCase());
  const env = envInfo(s.environment);
  const fields = [s.name, s.folder, s.host, s.username, ...tags, env?.label ?? "", env?.badge ?? ""].map((v) => v.toLowerCase());
  return words.every((w) => {
    if (w.startsWith("#")) {
      const t = w.slice(1);
      return t === "" || tags.some((x) => x.startsWith(t));
    }
    return fields.some((f) => f.includes(w));
  });
}
