// Workspace layouts: tabs and split panes that point at saved sessions, saved
// by name and opened later. Kept free of DOM code so it can be tested.
// A layout holds no secrets and no commands, and opening one connects nothing.

import { clampRatio, type Dir, type LayoutNode } from "./layout";

export type SavedNode =
  /** `session` is a saved session's id, or null for a pane that wasn't connected to one. */
  | { kind: "leaf"; session: string | null; label: string }
  | { kind: "split"; dir: Dir; ratio: number; a: SavedNode; b: SavedNode };

export interface Workspace {
  id: string;
  name: string;
  tabs: SavedNode[];
}

const MAX_TABS = 50;
const MAX_DEPTH = 12;
const MAX_LABEL = 120;

/** Turns a tab's live layout into a saved one, keeping only session references. */
export function capture<P>(node: LayoutNode<P>, describe: (pane: P) => { session: string | null; label: string }): SavedNode {
  if (node.kind === "leaf") {
    const d = describe(node.pane);
    return { kind: "leaf", session: d.session, label: d.label.slice(0, MAX_LABEL) };
  }
  return { kind: "split", dir: node.dir, ratio: clampRatio(node.ratio), a: capture(node.a, describe), b: capture(node.b, describe) };
}

/** Builds the live layout back, making a pane for each saved leaf. */
export function restore<P>(node: SavedNode, make: (leaf: { session: string | null; label: string }) => P): LayoutNode<P> {
  if (node.kind === "leaf") return { kind: "leaf", pane: make({ session: node.session, label: node.label }) };
  return { kind: "split", dir: node.dir, ratio: node.ratio, a: restore(node.a, make), b: restore(node.b, make) };
}

export function leaves(node: SavedNode): { session: string | null; label: string }[] {
  return node.kind === "leaf" ? [{ session: node.session, label: node.label }] : [...leaves(node.a), ...leaves(node.b)];
}

/** Checks a stored or imported layout, returning a clean copy, or null when it can't be used. */
export function cleanNode(raw: unknown, depth = 0): SavedNode | null {
  if (!raw || typeof raw !== "object" || depth > MAX_DEPTH) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "leaf") {
    const session = typeof r.session === "string" && r.session ? r.session : null;
    const label = typeof r.label === "string" ? r.label.slice(0, MAX_LABEL) : "";
    return { kind: "leaf", session, label };
  }
  if (r.kind === "split" && (r.dir === "row" || r.dir === "column")) {
    const a = cleanNode(r.a, depth + 1);
    const b = cleanNode(r.b, depth + 1);
    if (!a || !b) return null;
    const ratio = typeof r.ratio === "number" && Number.isFinite(r.ratio) ? clampRatio(r.ratio) : 0.5;
    return { kind: "split", dir: r.dir, ratio, a, b };
  }
  return null;
}

export function cleanWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || !r.name.trim() || !Array.isArray(r.tabs)) return null;
  const tabs = r.tabs.slice(0, MAX_TABS).map((t) => cleanNode(t));
  if (!tabs.length || tabs.some((t) => t === null)) return null;
  return { id: r.id, name: r.name.trim().slice(0, MAX_LABEL), tabs: tabs as SavedNode[] };
}

/** What opening a workspace will do: each pane, and whether its session still exists. */
export function preview(w: Workspace, sessionIds: Set<string>) {
  return w.tabs.map((t, i) => ({
    tab: i + 1,
    panes: leaves(t).map((l) => ({ ...l, missing: l.session !== null && !sessionIds.has(l.session) })),
  }));
}
