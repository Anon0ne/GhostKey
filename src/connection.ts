// One SSH connection's lifecycle, kept free of DOM and xterm code so it can be
// tested on its own. Each pane owns one Connection and supplies the hooks.

import type { BannerLink, ConnEvent, ConnectRequest, Prompt } from "./api";

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
}

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
  private gen = 0;

  constructor(
    private api: ConnApi,
    private hooks: ConnHooks,
  ) {}

  /** Connecting or connected. */
  get active() {
    return this.request !== null && !this.closed;
  }

  get canRetry() {
    return this.request !== null && this.closed;
  }

  get retryLabel() {
    return this.connected ? "Reconnect" : "Retry connection";
  }

  get stopLabel() {
    return this.connected ? "Disconnect" : "Cancel";
  }

  get online() {
    return this.connected && !this.closed && this.id !== null;
  }

  private set(state: ConnState, status: string) {
    this.state = state;
    this.status = status;
    this.hooks.changed();
  }

  async connect(req: BaseRequest, title: string) {
    if (this.active) this.disconnect();
    const myGen = ++this.gen;
    const current = () => this.gen === myGen && !this.closed;
    this.request = { ...req };
    this.title = title;
    this.id = null;
    this.connected = false;
    this.closed = false;
    this.logPath = null;
    this.hooks.reset();
    this.hooks.hideBanner();
    this.set("busy", "Connecting…");
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
      this.closed = true;
      this.set("error", "Failed");
    }
  }

  disconnect() {
    if (!this.active) return;
    this.closed = true;
    if (this.id !== null) this.api.disconnect(this.id);
    this.logPath = null;
    this.hooks.closePrompts();
    this.hooks.hideBanner();
    this.hooks.writeln(`\r\n${ansi.dim("Disconnected.")}`);
    this.set("idle", "Disconnected");
  }

  retry() {
    if (this.canRetry && this.request) this.connect(this.request, this.title);
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
      case "connected":
        this.connected = true;
        this.hooks.hideBanner();
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
      case "closed":
        this.closed = true;
        this.logPath = null;
        this.hooks.closePrompts();
        this.hooks.hideBanner();
        if (e.error) {
          this.hooks.writeln(`\r\n${ansi.err(e.error)}`);
          this.set("error", "Connection closed with an error");
        } else {
          this.hooks.writeln(`\r\n${ansi.dim("Connection closed.")}`);
          this.set("idle", "Disconnected");
        }
        break;
    }
  }
}
