// Connection diagnostics: which stages a connection got through, how long each
// took, where it stopped, and what to try next. Kept free of DOM code so it can
// be tested.

export type Stage = "dns" | "tcp" | "handshake" | "hostKey" | "auth" | "forward" | "shell";

export const STAGE_LABELS: Record<Stage, string> = {
  dns: "Look up the address",
  tcp: "Open a network connection",
  handshake: "SSH handshake",
  hostKey: "Check the server's identity",
  auth: "Log in",
  forward: "Reach the server through the jump host",
  shell: "Start the shell",
};

export interface StepEvent {
  stage: Stage;
  done: boolean;
  /** The jump host's name, for a stage there. */
  hop: string | null;
  detail: string | null;
}

export interface Step {
  stage: Stage;
  hop: string | null;
  state: "running" | "ok" | "failed";
  detail: string | null;
  started: number;
  /** How long the stage took, once it finished or failed. */
  ms: number | null;
}

export type Outcome = "none" | "connecting" | "connected" | "failed" | "lost" | "closed";

export function stageLabel(step: { stage: Stage; hop: string | null }): string {
  return step.hop ? `Jump host: ${STAGE_LABELS[step.stage].toLowerCase()}` : STAGE_LABELS[step.stage];
}

/** One connection attempt, from start to its outcome. A new attempt starts a new trace. */
export class Trace {
  steps: Step[] = [];
  outcome: Outcome = "none";
  error: string | null = null;
  started = 0;
  ended: number | null = null;
  target: { host: string; port: number; username: string; jump: string | null } | null = null;

  start(target: Trace["target"], now: number) {
    this.steps = [];
    this.outcome = "connecting";
    this.error = null;
    this.started = now;
    this.ended = null;
    this.target = target;
  }

  step(e: StepEvent, now: number) {
    if (!e.done) {
      this.steps.push({ stage: e.stage, hop: e.hop, state: "running", detail: e.detail, started: now, ms: null });
      return;
    }
    const s = [...this.steps].reverse().find((x) => x.stage === e.stage && x.hop === e.hop && x.state === "running");
    if (!s) return;
    s.state = "ok";
    s.ms = now - s.started;
    if (e.detail) s.detail = e.detail;
  }

  connected(now: number) {
    this.outcome = "connected";
    this.ended = now;
  }

  /** The connection ended. A stage still running is where it stopped. */
  closed(error: string | null, lost: boolean, now: number) {
    const running = this.steps.find((s) => s.state === "running");
    if (running) {
      running.state = "failed";
      running.ms = now - running.started;
    }
    this.error = error;
    if (this.outcome === "connected") this.outcome = lost ? "lost" : error ? "failed" : "closed";
    else this.outcome = error ? "failed" : "closed";
    this.ended = now;
  }

  get failedStep(): Step | undefined {
    return this.steps.find((s) => s.state === "failed");
  }

  /** A short summary for the toolbar, e.g. "Failed at Log in". */
  get summary(): string | null {
    const f = this.failedStep;
    return f ? `Failed: ${stageLabel(f).toLowerCase()}` : null;
  }

  /** What to try next, for the stage the connection stopped at. */
  advice(): string | null {
    if (this.outcome === "lost") {
      return "The connection dropped after it was up. This is usually the network (Wi-Fi change, sleep, VPN) or the server restarting. Reconnect when the network is back.";
    }
    const f = this.failedStep;
    if (!f) return null;
    const err = (this.error ?? "").toLowerCase();
    const port = this.target?.port ?? 22;
    switch (f.stage) {
      case "dns":
        return "The name couldn't be found. Check it for typos, and that you're on the network (VPN, Tailscale) that knows it.";
      case "tcp":
        if (err.includes("refused")) return `The server answered but nothing accepts connections on port ${port}. Check the port and that the SSH server is running.`;
        if (err.includes("timed out")) return "The server didn't answer. Check the address, any firewall, and that you're on the right network or VPN.";
        if (err.includes("unreachable")) return "There's no route to the server. Check your network connection and VPN.";
        return "The network connection couldn't be opened. Check the address, port and your network.";
      case "handshake":
        return "The server closed the connection before SSH could start. It may not be an SSH server, may only allow certain addresses, or may not support GhostKey's algorithms.";
      case "hostKey":
        if (err.includes("changed")) return "The server's identity has changed. Only trust it if you know why, for example the server was reinstalled. The message above says which line to remove.";
        if (err.includes("certificate")) return "This server uses host certificates, which GhostKey doesn't support yet.";
        return "The server's identity wasn't trusted, so GhostKey didn't log in. Connect again and check the fingerprint if you want to trust it.";
      case "auth":
        if (err.includes("cancel")) return "The login was cancelled. Connect again to enter your details.";
        if (err.includes("key file") || err.includes("passphrase")) return "The key file couldn't be used. Check its path and passphrase in the session's settings.";
        return "The server didn't accept the login. Check the user name, password or key. The server may also limit who can log in or how.";
      case "forward":
        return "The jump host logged you in but couldn't reach the server. Check the server's address as the jump host sees it.";
      case "shell":
        return "You logged in but the server didn't open a shell. The account may have no shell, a forced command, or a limit on sessions.";
    }
  }
}

/** Removes sign-in tokens, and the given names when asked, from diagnostics text. */
export function redact(text: string, names: string[] = []): string {
  let out = text
    // Tailscale and similar sign-in links carry a one-time token in the path.
    .replace(/(https?:\/\/login\.tailscale\.com\/a\/)[^\s"')]+/gi, "$1[token]")
    .replace(/([?&](?:token|code|key|auth|sig|signature|password|secret)=)[^\s&"']+/gi, "$1[removed]")
    // Home folders name the local account.
    .replace(/\/(home|Users)\/[^/\s]+/g, "~")
    .replace(/(^|[\s(])\/root(?=\/)/g, "$1~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~");
  const unique = [...new Set(names.filter((n) => n && n.length > 1))].sort((a, b) => b.length - a.length);
  unique.forEach((name) => {
    out = out.split(name).join("[host]");
  });
  return out;
}

function hidden(trace: Trace): string[] {
  const t = trace.target;
  if (!t) return [];
  const names = [t.host, t.username, t.jump ?? ""];
  // Addresses the lookup found, from details like "10.0.0.5" or "10.0.0.5:22".
  for (const s of trace.steps) {
    if ((s.stage === "dns" || s.stage === "tcp") && s.detail) {
      const ip = s.detail.replace(/ and \d+ more$/, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      names.push(s.detail, ip);
    }
  }
  return names;
}

/** Plain text to paste into a ticket or chat. Host details are left out unless `includeHost`. */
export function report(trace: Trace, opts: { includeHost: boolean; version: string; platform: string }): string {
  const lines: string[] = [];
  const t = trace.target;
  lines.push(`GhostKey ${opts.version || "(unknown version)"} on ${opts.platform || "unknown OS"}`);
  if (t) {
    const target = opts.includeHost ? `${t.username}@${t.host}:${t.port}` : `[user]@[host]:${t.port}`;
    lines.push(`Target: ${target}${t.jump ? (opts.includeHost ? ` via ${t.jump}` : " via a jump host") : ""}`);
  }
  lines.push(`Outcome: ${trace.outcome}${trace.ended !== null ? ` after ${trace.ended - trace.started} ms` : ""}`);
  lines.push("");
  for (const s of trace.steps) {
    const mark = s.state === "ok" ? "ok  " : s.state === "failed" ? "FAIL" : "... ";
    const ms = s.ms === null ? "" : ` (${s.ms} ms)`;
    lines.push(`[${mark}] ${stageLabel(s)}${ms}${s.detail ? `: ${s.detail}` : ""}`);
  }
  if (!trace.steps.length) lines.push("No stages recorded.");
  if (trace.error) lines.push("", `Error: ${trace.error}`);
  const advice = trace.advice();
  if (advice) lines.push("", `Next step: ${advice}`);
  const text = lines.join("\n");
  return redact(text, opts.includeHost ? [] : hidden(trace));
}
