// Terminals that aren't SSH: Telnet, serial ports and a local shell.
// Kept free of DOM code so it can be tested.

export type Protocol = "ssh" | "telnet" | "serial" | "local";
export type Parity = "none" | "odd" | "even";
export type Flow = "none" | "software" | "hardware";

export interface SerialSettings {
  /** e.g. /dev/ttyUSB0 or COM3. */
  path: string;
  baud: number;
  dataBits: number;
  parity: Parity;
  stopBits: number;
  flow: Flow;
}

/** The speeds most devices use, slowest first. Any speed can still be typed. */
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export const DEFAULT_SERIAL: SerialSettings = { path: "", baud: 115200, dataBits: 8, parity: "none", stopBits: 1, flow: "none" };

export const PROTOCOLS: { value: Exclude<Protocol, "local">; label: string; port: number }[] = [
  { value: "ssh", label: "SSH", port: 22 },
  { value: "telnet", label: "Telnet", port: 23 },
  { value: "serial", label: "Serial port", port: 0 },
];

export const TELNET_WARNING =
  "Telnet sends everything, passwords included, as plain text that anyone on the network can read. Use it only for old devices on a network you trust.";

/** Sessions saved before other protocols existed are SSH. */
export function protocolOf(x: { protocol?: Protocol | null } | null | undefined): Protocol {
  return x?.protocol ?? "ssh";
}

/** Files, tunnels and tmux work only over SSH. */
export function hasSshFeatures(x: { protocol?: Protocol | null } | null | undefined): boolean {
  return protocolOf(x) === "ssh";
}

/** Short line settings, like "115200 8N1". */
export function serialSummary(s: SerialSettings): string {
  const parity = s.parity === "odd" ? "O" : s.parity === "even" ? "E" : "N";
  const flow = s.flow === "hardware" ? " RTS/CTS" : s.flow === "software" ? " XON/XOFF" : "";
  return `${s.baud} ${s.dataBits}${parity}${s.stopBits}${flow}`;
}

export interface Target {
  protocol?: Protocol | null;
  host: string;
  port: number;
  username: string;
  serial?: SerialSettings | null;
}

/** Where a session or pane goes, for lists and labels. */
export function describeTarget(t: Target): string {
  switch (protocolOf(t)) {
    case "local":
      return "local shell";
    case "serial":
      return t.serial ? `${t.serial.path} ${serialSummary(t.serial)}` : "serial port";
    case "telnet":
      return `telnet ${t.host}${t.port === 23 ? "" : `:${t.port}`}`;
    default:
      return `${t.username}@${t.host}${t.port === 22 ? "" : `:${t.port}`}`;
  }
}

/** Mirrors the backend's check, so the editor can say what's wrong before saving. */
export function serialProblem(s: SerialSettings | null | undefined): string | null {
  if (!s || !s.path.trim()) return "Choose a serial port.";
  if (!Number.isInteger(s.baud) || s.baud < 50 || s.baud > 4_000_000) return "Speed must be between 50 and 4000000 baud.";
  if (![5, 6, 7, 8].includes(s.dataBits)) return "Data bits must be 5, 6, 7 or 8.";
  if (![1, 2].includes(s.stopBits)) return "Stop bits must be 1 or 2.";
  return null;
}

/** Reads serial settings from untrusted input (an imported profile), or null when they're unusable. */
export function normalizeSerial(raw: unknown): SerialSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s: SerialSettings = {
    path: typeof r.path === "string" ? r.path.trim().slice(0, 256) : "",
    baud: typeof r.baud === "number" ? r.baud : DEFAULT_SERIAL.baud,
    dataBits: typeof r.dataBits === "number" ? r.dataBits : 8,
    parity: r.parity === "odd" || r.parity === "even" ? r.parity : "none",
    stopBits: typeof r.stopBits === "number" ? r.stopBits : 1,
    flow: r.flow === "software" || r.flow === "hardware" ? r.flow : "none",
  };
  return serialProblem(s) ? null : s;
}

/** Reads a protocol from untrusted input. A local terminal is never a saved session. */
export function normalizeProtocol(raw: unknown): Exclude<Protocol, "local"> {
  return raw === "telnet" || raw === "serial" ? raw : "ssh";
}
