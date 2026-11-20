// tmux on the server: name checks that match the Rust side, and the text
// shown for each session. Kept free of DOM code so it can be tested.

export const MAX_TMUX_NAME = 64;

export interface TmuxSession {
  name: string;
  attached: number;
  windows: number;
  created: number | null;
}

export interface TmuxList {
  installed: boolean;
  sessions: TmuxSession[];
}

/** Why `name` can't be a tmux session name, or null when it can. Empty is allowed (no tmux). */
export function tmuxNameProblem(name: string): string | null {
  if (!name) return null;
  if (name.length > MAX_TMUX_NAME) return `A tmux session name can be at most ${MAX_TMUX_NAME} characters.`;
  if (!/^[A-Za-z0-9_@+=-]+$/.test(name)) return "A tmux session name can use letters, digits, - and _ only.";
  return null;
}

export function describeTmux(s: TmuxSession, now = Date.now()): string {
  const parts = [`${s.windows} ${s.windows === 1 ? "window" : "windows"}`];
  if (s.attached > 0) parts.push(`${s.attached} attached now`);
  if (s.created) {
    const mins = Math.max(0, Math.round((now / 1000 - s.created) / 60));
    parts.push(mins < 60 ? `started ${mins} min ago` : mins < 48 * 60 ? `started ${Math.round(mins / 60)} h ago` : `started ${Math.round(mins / 1440)} days ago`);
  }
  return parts.join(" · ");
}
