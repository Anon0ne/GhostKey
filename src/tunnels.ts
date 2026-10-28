// Port-forward rules: how they read, and what makes one valid. Kept free of DOM code so it can be tested.

export type ForwardKind = "local" | "remote" | "dynamic";

export interface Forward {
  id: string;
  kind: ForwardKind;
  /** Where to listen: here for local and dynamic, on the server for remote. */
  bindHost: string;
  bindPort: number;
  /** Where connections go; unused for dynamic. */
  destHost: string;
  destPort: number;
  /** Start when the session connects. */
  autoStart: boolean;
}

export type TunnelState = "starting" | "listening" | "failed";

export interface TunnelStatus {
  forward: Forward;
  state: TunnelState;
  bound: string | null;
  error: string | null;
  connections: number;
}

export const KIND_LABELS: Record<ForwardKind, string> = {
  local: "Local (-L): a port here reaches a host via the server",
  remote: "Remote (-R): a port on the server reaches a host via here",
  dynamic: "SOCKS proxy (-D): a proxy here; the server makes the connections",
};

export function newForward(kind: ForwardKind = "local"): Forward {
  return { id: crypto.randomUUID(), kind, bindHost: "127.0.0.1", bindPort: 0, destHost: "", destPort: 0, autoStart: true };
}

/** Loopback addresses, which only this computer (or the server itself, for remote) can reach. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function hostPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** One line such as "127.0.0.1:8080 → db:5432". */
export function describe(f: Forward): string {
  const bind = hostPort(f.bindHost, f.bindPort);
  switch (f.kind) {
    case "local":
      return `${bind} → ${hostPort(f.destHost, f.destPort)}`;
    case "remote":
      return `server ${bind} → ${hostPort(f.destHost, f.destPort)}`;
    case "dynamic":
      return `SOCKS on ${bind}`;
  }
}

const validPort = (p: number, allowZero = false) => Number.isInteger(p) && p >= (allowZero ? 0 : 1) && p <= 65535;

export function forwardProblem(f: Forward): string | null {
  if (!f.bindHost.trim() || /\s/.test(f.bindHost)) return "Enter a listen address, such as 127.0.0.1.";
  if (!validPort(f.bindPort, f.kind === "remote")) return "The listen port must be between 1 and 65535.";
  if (f.kind !== "dynamic") {
    if (!f.destHost.trim() || /\s/.test(f.destHost)) return "Enter a destination host.";
    if (!validPort(f.destPort)) return "The destination port must be between 1 and 65535.";
  }
  return null;
}

/** Reads OpenSSH-style specs: "-L [bind:]port:host:hostport", "-R …", "-D [bind:]port". */
export function parseSpec(text: string): Forward | null {
  const m = /^\s*-?([LRD])\s*(.+?)\s*$/i.exec(text);
  if (!m) return null;
  const kind: ForwardKind = ({ L: "local", R: "remote", D: "dynamic" } as const)[m[1].toUpperCase() as "L" | "R" | "D"];
  // Split on colons outside [IPv6] brackets.
  const parts = m[2].match(/\[[^\]]*\]|[^:]+/g)?.map((p) => p.replace(/^\[|\]$/g, "")) ?? [];
  const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : NaN);
  const f = newForward(kind);
  if (kind === "dynamic") {
    if (parts.length === 1) f.bindPort = num(parts[0]);
    else if (parts.length === 2) [f.bindHost, f.bindPort] = [parts[0], num(parts[1])];
    else return null;
  } else {
    let rest = parts;
    if (parts.length === 4) {
      f.bindHost = parts[0];
      rest = parts.slice(1);
    } else if (parts.length !== 3) return null;
    [f.bindPort, f.destHost, f.destPort] = [num(rest[0]), rest[1], num(rest[2])];
  }
  if (f.bindHost === "*" ) f.bindHost = "0.0.0.0";
  return forwardProblem(f) ? null : f;
}
