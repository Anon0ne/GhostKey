// The split tree inside one tab. Kept free of DOM code so it can be tested.

export type Dir = "row" | "column";

export type LayoutNode<P> =
  | { kind: "leaf"; pane: P }
  | { kind: "split"; dir: Dir; ratio: number; a: LayoutNode<P>; b: LayoutNode<P> };

export const MIN_RATIO = 0.1;

export function leaf<P>(pane: P): LayoutNode<P> {
  return { kind: "leaf", pane };
}

/** Panes in reading order: left to right, top to bottom. */
export function panes<P>(node: LayoutNode<P>): P[] {
  return node.kind === "leaf" ? [node.pane] : [...panes(node.a), ...panes(node.b)];
}

/** Splits `target` in two, putting `added` to its right (row) or below it (column). */
export function split<P>(node: LayoutNode<P>, target: P, added: P, dir: Dir): LayoutNode<P> {
  if (node.kind === "leaf") {
    return node.pane === target ? { kind: "split", dir, ratio: 0.5, a: node, b: leaf(added) } : node;
  }
  return { ...node, a: split(node.a, target, added, dir), b: split(node.b, target, added, dir) };
}

/** Removes `target`; its sibling takes the freed space. Returns null when the tree is empty. */
export function remove<P>(node: LayoutNode<P>, target: P): LayoutNode<P> | null {
  if (node.kind === "leaf") return node.pane === target ? null : node;
  const a = remove(node.a, target);
  const b = remove(node.b, target);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

export function clampRatio(ratio: number): number {
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Picks the pane next to `from` in a direction, from on-screen rectangles.
 * Prefers panes that overlap `from` across the direction of travel, then the closest.
 */
export function nearest(rects: Rect[], from: number, dir: Direction): number | null {
  const r = rects[from];
  if (!r) return null;
  const horizontal = dir === "left" || dir === "right";
  let best: number | null = null;
  let bestScore = Infinity;
  rects.forEach((o, i) => {
    if (i === from) return;
    const gap =
      dir === "left" ? r.left - (o.left + o.width)
      : dir === "right" ? o.left - (r.left + r.width)
      : dir === "up" ? r.top - (o.top + o.height)
      : o.top - (r.top + r.height);
    if (gap < -1) return;
    const overlap = horizontal
      ? Math.min(r.top + r.height, o.top + o.height) - Math.max(r.top, o.top)
      : Math.min(r.left + r.width, o.left + o.width) - Math.max(r.left, o.left);
    const score = gap + (overlap > 0 ? 0 : 100000);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
