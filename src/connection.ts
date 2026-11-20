// One SSH connection's lifecycle, kept free of DOM and xterm code so it can be
// tested on its own. Each pane owns one Connection and supplies the hooks.

import type { BannerLink, ConnEvent, ConnectRequest, Prompt } from "./api";
import type { TunnelStatus } from "./tunnels";
import { Trace } from "./diagnostics";

export type ConnState = "idle" | "busy" | "online" | "error";
export type BaseRequest = Omit<ConnectRequest, "cols" | "rows">;

export interface ConnApi {
  connect(request: ConnectRequest, onEvent: (e: ConnEvent) => void, onOutput: (data: Uint8Array) => void): Promise<number>;
  disconnect(id: number): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  sendInput(id: number, data: string): Promise<void>;
  startLog(id: number): Promise<void>;
  stopLog(id: number): Promise<void>;
}

export interface ConnHooks {
  write(data: Uint8Array | string): void;
  writeln(text: string): void;
  reset(): void;
  size(): { cols: number; rows: number };
  /** Re-measure the terminal; called once the shell is open. */
  fit(): void;
  focus(): void;
  showBanner(text: string, links: BannerLink[], autoOpened: string | null): void;
  hideBanner(): void;
  prompt(id: number, prompt: Prompt): void;
  closePrompts(): void;
  /** Title, status, or log state changed. */
  changed(): void;
  /** Whether to reconnect on its own after the connection drops. Off when not given. */
  autoReconnect?(): boolean;
  /** The time in ms, for diagnostics timings. Defaults to Date.now. */
  now?(): number;
  /** Runs `fn` after `ms` and returns a function that cancels it. Defaults to setTimeout. */
  schedule?(fn: () => void, ms: number): () => void;
}

/** Seconds to wait before each automatic reconnect attempt. */
export const RECONNECT_DELAYS = [2, 4, 8, 16, 30];

// ANSI helpers in Kali-Dark colors, for GhostKey's own messages in the terminal.
export const ansi = {
  info: (s: string) => `\x1b[1;34m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  err: (s: string) => `\x1b[1;31m${s}\x1b[0m`,
};

export class Connection {
  request: BaseRequest | null = null;
  title = "Not connected";
  state: ConnState = "idle";
  status = "";
  id: number | null = null;
  connected = false;
  closed = true;
  /** Path of the log being written, if any. */
  logPath: string | null = null;
  /** This connection's tunnels, as the backend last reported them. */
  tunnels: TunnelStatus[] = [];
  /** The latest connection attempt's stages, for diagnostics. */
  trace = new Trace();
  private gen = 0;
  /** While reconnecting on its own: the attempt being waited for or made (1-based), else 0. */
  private attempt = 0;
  private cancelWait: (() => void) | null = null;

  constructor(
    private api: ConnApi,
    private hooks: ConnHooks,
  ) {}

  /** Waiting to reconnect after the connection dropped. */
  get recovering() {
    return this.cancelWait !== null;
  }

  /** Connecting, connected, or waiting to reconnect. */
  get active() {
    return this.request !== null && (!this.closed || this.recovering);
  }

  get canRetry() {
    return this.request !== null && this.closed;
  }

  get retryLabel() {
    if (this.recovering) return "Reconnect now";
    return this.connected ? "Reconnect" : "Retry connection";
  }

  get stopLabel() {
    return this.connected && !this.closed ? "Disconnect" : "Cancel";
  }

  get online() {
    return this.connected && !this.closed && this.id !== null;
  }

  private now() {
    return this.hooks.now?.() ?? Date.now();
  }

  private set(state: ConnState, status: string) {
    this.state = state;
    this.status = status;
    this.hooks.changed();
  }

  async connect(req: BaseRequest, title: string) {
    if (this.active) this.disconnect();
    this.attempt = 0;
    await this.open(req, title);
  }

  /** Starts one connection attempt. `resume` keeps the terminal's text, for automatic reconnects. */
  private async open(req: BaseRequest, title: string, resume = false) {
    this.stopWaiting();
    const myGen = ++this.gen;
    const current = () => this.gen === myGen && !this.closed;
    this.request = { ...req };
    this.title = title;
    this.id = null;
    this.connected = false;
    this.closed = false;
    this.logPath = null;
    this.tunnels = [];
    this.trace.start({ host: req.host, port: req.port, username: req.username, jump: req.jump?.host ?? null }, this.now());
    if (resume) this.hooks.writeln(ansi.dim(`Reconnecting (try ${this.attempt} of ${RECONNECT_DELAYS.length})…`));
    else this.hooks.reset();
    this.hooks.hideBanner();
    this.set("busy", resume ? "Reconnecting…" : "Connecting…");
    this.hooks.focus();

    const { cols, rows } = this.hooks.size();
    try {
      const id = await this.api.connect(
        { ...req, cols, rows },
        (e) => {
          if (current()) this.onEvent(e);
        },
        (data) => {
          if (current()) this.hooks.write(data);
        },
      );
      if (!current()) {
        await this.api.disconnect(id);
        return;
      }
      this.id = id;
      if (this.connected) this.sendSize();
    } catch (e) {
      if (!current()) return;
      this.hooks.closePrompts();
      this.hooks.hideBanner();
      this.hooks.writeln(ansi.err(`Couldn't start the connection: ${e}`));
      this.trace.closed(String(e), false, this.now());
      this.closed = true;
      if (this.attempt > 0) this.retryLater();
      else this.set("error", "Failed");
    }
  }

  private stopWaiting() {
    this.cancelWait?.();
    this.cancelWait = null;
  }

  /** Waits, then makes the next automatic attempt, or gives up after the last one. */
  private retryLater() {
    if (!this.request) return;
    if (this.attempt >= RECONNECT_DELAYS.length) {
      this.attempt = 0;
      this.hooks.writeln(ansi.err(`Gave up reconnecting after ${RECONNECT_DELAYS.length} tries. Press Reconnect to try again.`));
      this.set("error", "Couldn't reconnect");
      return;
    }
    this.attempt++;
    const delay = RECONNECT_DELAYS[this.attempt - 1];
    const req = this.request;
    const title = this.title;
    const schedule = this.hooks.schedule ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.cancelWait = schedule(() => {
      this.cancelWait = null;
      void this.open(req, title, true);
    }, delay * 1000);
    this.set("busy", `Connection lost. Reconnecting in ${delay} s (try ${this.attempt} of ${RECONNECT_DELAYS.length})`);
  }

  disconnect() {
    if (!this.active) return;
    if (this.recovering) {
      this.stopWaiting();
      this.attempt = 0;
      this.hooks.writeln(ansi.dim("Stopped reconnecting."));
      this.set("idle", "Disconnected");
      return;
    }
    this.attempt = 0;
    this.closed = true;
    if (this.id !== null) this.api.disconnect(this.id);
    this.logPath = null;
    this.tunnels = [];
    this.hooks.closePrompts();
    this.hooks.hideBanner();
    this.hooks.writeln(`\r\n${ansi.dim("Disconnected.")}`);
    this.set("idle", "Disconnected");
  }

  retry() {
    if (!this.canRetry || !this.request) return;
    // "Reconnect now" skips the wait but keeps counting tries.
    if (this.recovering) void this.open(this.request, this.title, true);
    else void this.connect(this.request, this.title);
  }

  input(data: string) {
    if (this.online) this.api.sendInput(this.id!, data);
  }

  resize(cols: number, rows: number) {
    if (this.online) this.api.resize(this.id!, cols, rows);
  }

  /** Starts or stops the session log. The change shows when the backend confirms it. */
  toggleLog() {
    if (!this.online) return;
    if (this.logPath) this.api.stopLog(this.id!);
    else this.api.startLog(this.id!);
  }

  private sendSize() {
    const { cols, rows } = this.hooks.size();
    this.resize(cols, rows);
  }

  private onEvent(e: ConnEvent) {
    switch (e.type) {
      case "status":
        this.hooks.writeln(ansi.dim(e.message));
        this.set("busy", e.message);
        break;
      case "banner":
        this.hooks.showBanner(e.text, e.links, e.autoOpened);
        if (e.links.some((l) => l.tailscale)) this.set("busy", "Waiting for Tailscale approval");
        break;
      case "prompt":
        this.hooks.prompt(e.id, e.prompt);
        break;
      case "step":
        this.trace.step(e, this.now());
        break;
      case "connected":
        this.trace.connected(this.now());
        this.connected = true;
        this.hooks.hideBanner();
        if (this.attempt > 0) this.hooks.writeln(ansi.ok("Reconnected. This is a new shell; programs from the old one are gone."));
        this.attempt = 0;
        this.set("online", "Connected");
        this.hooks.fit();
        this.sendSize();
        this.hooks.focus();
        break;
      case "logging":
        this.logPath = e.path;
        if (e.error) this.hooks.writeln(`\r\n${ansi.err(e.error)}`);
        this.hooks.changed();
        break;
      case "tunnels":
        this.tunnels = e.tunnels;
        this.hooks.changed();
        break;
      case "closed":
        this.trace.closed(e.error, !!e.lost, this.now());
        this.closed = true;
        this.logPath = null;
        this.tunnels = [];
        this.hooks.closePrompts();
        this.hooks.hideBanner();
        if (e.lost && this.hooks.autoReconnect?.()) {
          this.hooks.writeln(`\r\n${ansi.err(e.error ?? "The connection was lost.")}`);
          this.attempt = 0;
          this.retryLater();
        } else if (this.attempt > 0) {
          this.hooks.writeln(ansi.err(e.error ?? "The connection closed."));
          if (e.retryable) this.retryLater();
          else {
            // A refused or cancelled login won't fix itself by trying again.
            this.attempt = 0;
            this.set("error", "Couldn't reconnect");
          }
        } else if (e.error) {
          this.hooks.writeln(`\r\n${ansi.err(e.error)}`);
          const advice = this.trace.advice();
          if (advice) this.hooks.writeln(ansi.warn(advice));
          this.set("error", e.lost ? "Connection lost" : (this.trace.summary ?? "Connection closed with an error"));
        } else {
          this.hooks.writeln(`\r\n${ansi.dim("Connection closed.")}`);
          this.set("idle", "Disconnected");
        }
        break;
    }
  }
}
