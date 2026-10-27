// What sending a snippet does. Kept free of DOM code so it can be tested.

export interface Snippet {
  id: string;
  name: string;
  group: string;
  command: string;
  /** Press Enter after the text. Off means the text is only typed in. */
  run: boolean;
  /** Show on the button bar. */
  favorite: boolean;
}

/** The text to paste and whether Enter follows. Trailing newlines are dropped,
 * so only the run setting decides whether a command executes. */
export function payload(s: Snippet): { text: string; enter: boolean } {
  return { text: s.command.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), enter: s.run };
}

export function lineCount(s: Snippet): number {
  return payload(s).text.split("\n").length;
}

/** Running a command, or pasting several lines, is shown first and confirmed. */
export function needsPreview(s: Snippet): boolean {
  return s.run || lineCount(s) > 1;
}

/** Snippets by group, ungrouped first, in the order given. */
export function grouped(snippets: Snippet[]): [string, Snippet[]][] {
  const groups = new Map<string, Snippet[]>();
  for (const s of snippets) {
    const g = groups.get(s.group) ?? [];
    g.push(s);
    groups.set(s.group, g);
  }
  return [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}
