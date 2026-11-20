// Broadcast input: typing in one chosen pane goes to every chosen pane.
// Kept free of DOM code so it can be tested.

export interface Member {
  conn: { online: boolean; id: number | null };
}

/**
 * The panes chosen for broadcast, each tied to the connection it had when chosen.
 * A pane that reconnects or disconnects drops out, so a new connection never
 * joins without being chosen again.
 */
export class Broadcast<P extends Member> {
  private chosen = new Map<P, number>();

  get on(): boolean {
    return this.members().length > 0;
  }

  /** Replaces the group with `panes`. Panes that aren't connected are left out. */
  choose(panes: P[]) {
    this.chosen.clear();
    for (const p of panes) if (p.conn.online && p.conn.id !== null) this.chosen.set(p, p.conn.id);
    // One pane alone isn't a broadcast.
    if (this.chosen.size < 2) this.chosen.clear();
  }

  stop() {
    this.chosen.clear();
  }

  /** Forgets a pane, e.g. when it closes. */
  drop(pane: P) {
    this.chosen.delete(pane);
  }

  /** Chosen panes still on the connection they were chosen with. */
  members(): P[] {
    const live = [...this.chosen].filter(([p, id]) => p.conn.online && p.conn.id === id).map(([p]) => p);
    return live.length >= 2 ? live : [];
  }

  has(pane: P): boolean {
    return this.members().includes(pane);
  }

  /** Where input typed in `from` goes: every member when `from` is one, else just `from`. */
  targets(from: P): P[] {
    const members = this.members();
    return members.includes(from) ? members : [from];
  }

  /** Removes panes whose connection changed, so they don't come back on their own. */
  prune() {
    for (const [p, id] of [...this.chosen]) if (!p.conn.online || p.conn.id !== id) this.chosen.delete(p);
    if (this.chosen.size < 2) this.chosen.clear();
  }
}
