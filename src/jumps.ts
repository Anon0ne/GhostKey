// Chains of jump hosts: a saved session can go through another saved session,
// which can go through another, like `ssh -J a,b`. Kept free of DOM code so it
// can be tested.

export const MAX_JUMPS = 5;

interface Hop {
  id: string;
  name: string;
  jumpSession: string | null;
  /** Only SSH sessions can be jump hosts. Missing means SSH. */
  protocol?: string;
}

export type Chain<T> = { ok: true; hops: T[] } | { ok: false; error: string };

/** The jump hosts to go through for `s`, outermost first, or why there's no usable route. */
export function jumpChain<T extends Hop>(s: T, all: T[]): Chain<T> {
  const hops: T[] = [];
  const seen = new Set([s.id]);
  let cur: T = s;
  while (cur.jumpSession) {
    const next = all.find((x) => x.id === cur.jumpSession);
    if (!next) return { ok: false, error: `"${cur.name}" connects through a saved session that no longer exists. Choose another jump host in its settings.` };
    if ((next.protocol ?? "ssh") !== "ssh") return { ok: false, error: `"${cur.name}" connects through "${next.name}", which isn't an SSH session. Choose another jump host in its settings.` };
    if (seen.has(next.id)) return { ok: false, error: `The jump hosts for "${s.name}" go round in a loop through "${next.name}". Change one of them in its settings.` };
    if (hops.length === MAX_JUMPS) return { ok: false, error: `"${s.name}" goes through more than ${MAX_JUMPS} jump hosts.` };
    seen.add(next.id);
    hops.unshift(next);
    cur = next;
  }
  return { ok: true, hops };
}

/** Sessions that `s` may use as its jump host: SSH, not itself, and not one that already goes through `s`. */
export function jumpChoices<T extends Hop>(s: { id: string }, all: T[]): T[] {
  return all.filter((x) => {
    if (x.id === s.id || (x.protocol ?? "ssh") !== "ssh") return false;
    const c = jumpChain(x, all);
    return c.ok && !c.hops.some((h) => h.id === s.id) && c.hops.length < MAX_JUMPS;
  });
}

/** "bastion → inner → server", for showing a route. */
export function routeText(hops: { name: string }[], target: string): string {
  return [...hops.map((h) => h.name), target].join(" → ");
}
