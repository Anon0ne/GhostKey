import type { ITheme } from "@xterm/xterm";

/**
 * Kali-Dark, from Kali's QTerminal color scheme
 * (kali-themes: share/qtermwidget6/color-schemes/Kali-Dark.colorscheme).
 */
export const kaliDark: ITheme = {
  background: "#23252E",
  foreground: "#FFFFFF",
  cursor: "#FFFFFF",
  cursorAccent: "#23252E",
  selectionBackground: "#367BF066",
  black: "#1F2229",
  red: "#D41919",
  green: "#5EBDAB",
  yellow: "#FEA44C",
  blue: "#367BF0",
  magenta: "#9755B3",
  cyan: "#49AEE6",
  white: "#E6E6E6",
  brightBlack: "#198388",
  brightRed: "#EC0101",
  brightGreen: "#47D4B9",
  brightYellow: "#FF8A18",
  brightBlue: "#277FFF",
  brightMagenta: "#962AC3",
  brightCyan: "#05A1F7",
  brightWhite: "#FFFFFF",
};

/** Kali's QTerminal default is Fira Code 10 pt, which is about 13.3 px. */
export const DEFAULT_FONT_SIZE = 14;
export const FONT_FAMILY = '"Fira Code", "DejaVu Sans Mono", Consolas, monospace';
