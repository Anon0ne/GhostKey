// A terminal pane: its own xterm, Tailscale banner, login prompts, and Connection.

import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import { api, type BannerLink, type Prompt, type PromptAnswer } from "./api";
import { ansi, Connection, type BaseRequest } from "./connection";
import { FilePanel } from "./filePanel";
import { checkbox, confirm, el, field, showModal } from "./modal";
import { needsPastePreview, pasteLineCount, pastePreview } from "./paste";
import { FONT_FAMILY, kaliDark } from "./theme";

export interface PaneHost {
  fontSize(): number;
  /** Theme, font, cursor and scrollback from Settings. */
  termOptions?(): ITerminalOptions;
  /** Copy the selection as soon as it is made. */
  copyOnSelect?(): boolean;
  /** Reconnect on its own when the connection drops. */
  autoReconnect?(): boolean;
  /** Sends what was typed in `pane`, to every broadcast pane when it is one of them. */
  input?(pane: Pane, data: string): void;
  /** The panes that input typed in `pane` reaches, itself included. */
  destinations?(pane: Pane): Pane[];
  /** A name for `pane` that tells it apart from others on the same host. */
  label?(pane: Pane): string;
  /** Whether `pane` is connected to a session marked as production. */
  production?(pane: Pane): boolean;
  /** The pane wants focus, e.g. to show a login prompt. */
  activate(pane: Pane): void;
  changed(pane: Pane): void;
  /** Lets the app handle its own shortcuts; returns true when it did. */
  shortcut(pane: Pane, e: KeyboardEvent): boolean;
  /** Disconnects and closes the pane, asking first if it's connected. */
  close(pane: Pane): void;
  /** Whether restoring input focus would stay in the selected pane, outside dialogs. */
  canFocus?(pane: Pane): boolean;
}

// One login dialog at a time, so two panes asking at once can't mix up answers.
let promptQueue: Promise<void> = Promise.resolve();

let nextPaneId = 1;

export class Pane {
  readonly key = nextPaneId++;
  readonly el: HTMLElement;
  readonly term: Terminal;
  readonly conn: Connection;
  private fitAddon = new FitAddon();
  private searchAddon = new SearchAddon();
  private searchBar: HTMLElement;
  private searchInput: HTMLInputElement;
  private searchStatus: HTMLElement;
  private pastePending = false;
  private termEl: HTMLElement;
  private body: HTMLElement;
  private files: FilePanel | null = null;
  private banner: HTMLElement;
  private bannerText: HTMLElement;
  private bannerLinks: HTMLElement;
  private bannerWait: HTMLElement;
  private openPrompts = new Set<() => void>();
  private observer: ResizeObserver;
  private disposed = false;

  constructor(private host: PaneHost) {
    this.bannerText = el("pre", { class: "banner-text" });
    this.bannerLinks = el("div");
    const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
    cancel.addEventListener("click", () => this.conn.disconnect());
    this.bannerWait = el(
      "div",
      { class: "banner-wait", hidden: true },
      el("span", { class: "spinner" }),
      el("span", { text: "Waiting for Tailscale approval in your browser…" }),
      cancel,
    );
    this.banner = el("section", { class: "banner", hidden: true }, this.bannerText, this.bannerLinks, this.bannerWait);
    this.searchInput = el("input", { placeholder: "Find in this terminal", "aria-label": "Find in this terminal", spellcheck: "false" });
    this.searchStatus = el("span", { role: "status", "aria-live": "polite" });
    const previous = el("button", { class: "btn", type: "button", text: "Previous", title: "Previous match (Shift+Enter)" });
    const next = el("button", { class: "btn", type: "button", text: "Next", title: "Next match (Enter)" });
    const closeSearch = el("button", { class: "btn", type: "button", text: "Close", "aria-label": "Close terminal search" });
    this.searchBar = el("div", { class: "terminal-search", hidden: true, role: "search" }, this.searchInput, this.searchStatus, previous, next, closeSearch);
    this.searchInput.addEventListener("input", () => this.find(false, true));
    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.find(e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.closeSearch();
      }
    });
    previous.addEventListener("click", () => this.find(true));
    next.addEventListener("click", () => this.find(false));
    closeSearch.addEventListener("click", () => this.closeSearch());
    this.termEl = el("div", { class: "terminal-container" });
    this.body = el("div", { class: "pane-body" }, this.termEl);
    // Shown only when the tab is split; a single pane closes with its tab.
    const closePane = el("button", { class: "pane-close", type: "button", text: "×", title: "Close this pane (Ctrl+Shift+W)", "aria-label": "Close this pane" });
    closePane.addEventListener("click", () => host.close(this));
    this.el = el("div", { class: "pane" }, this.searchBar, closePane, this.banner, this.body);

    this.term = new Terminal({
      theme: kaliDark,
      fontFamily: FONT_FAMILY,
      fontWeight: "normal",
      fontWeightBold: "bold",
      cursorBlink: true,
      scrollback: 10000,
      ...host.termOptions?.(),
      fontSize: host.fontSize(),
      allowProposedApi: false,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Ctrl/Cmd+click opens links, as in most terminals.
        if (event.ctrlKey || event.metaKey) this.openLink(uri);
      }),
    );

    this.conn = new Connection(api, {
      write: (data) => this.term.write(data),
      writeln: (text) => this.term.writeln(text),
      reset: () => {
        this.searchAddon.clearDecorations();
        this.searchStatus.textContent = "";
        this.term.reset();
      },
      size: () => ({ cols: this.term.cols, rows: this.term.rows }),
      fit: () => this.fit(),
      focus: () => this.focus(),
      showBanner: (text, links, autoOpened) => this.showBanner(text, links, autoOpened),
      hideBanner: () => (this.banner.hidden = true),
      prompt: (id, prompt) => this.prompt(id, prompt),
      closePrompts: () => this.closePrompts(),
      changed: () => {
        this.files?.sync();
        host.changed(this);
      },
      autoReconnect: () => host.autoReconnect?.() ?? false,
    });

    this.term.onData((data) => this.send(data));
    this.term.onSelectionChange?.(() => {
      if (host.copyOnSelect?.() && this.term.hasSelection()) void Promise.resolve(writeText(this.term.getSelection())).catch(() => {});
    });
    this.term.onResize(({ cols, rows }) => this.conn.resize(cols, rows));
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.el.addEventListener("mousedown", () => host.activate(this));
    this.termEl.addEventListener("contextmenu", (e) => {
      // Right-click copies the selection, or pastes when nothing is selected.
      e.preventDefault();
      if (this.term.hasSelection()) {
        writeText(this.term.getSelection());
        this.term.clearSelection();
      } else {
        this.paste();
      }
    });

    // Capture before xterm's own paste listener, including Ctrl+V and Shift+Insert.
    this.termEl.addEventListener("paste", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      void this.pasteText(e.clipboardData?.getData("text/plain") ?? "");
    }, true);
    this.term.open(this.termEl);
    this.term.textarea?.addEventListener("focus", () => host.activate(this));
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.termEl);
  }

  get title() {
    return this.conn.request ? this.conn.title : "New tab";
  }

  fit() {
    // A hidden pane (background tab) measures as zero; fit when it is shown.
    if (this.disposed || this.termEl.offsetWidth === 0 || this.termEl.offsetHeight === 0) return;
    this.fitAddon.fit();
  }

  focus() {
    this.term.focus();
  }

  setFontSize(size: number) {
    this.term.options.fontSize = size;
    this.fit();
  }

  /** Applies changed Settings to this terminal. */
  applyOptions(options: ITerminalOptions) {
    Object.assign(this.term.options, options);
    this.fit();
  }

  welcome() {
    this.term.reset();
    this.term.writeln(ansi.info("  GhostKey") + ansi.dim("  alpha"));
    this.term.writeln("");
    this.term.writeln("  Double-click a saved session, or type " + ansi.ok("user@host") + " in Quick connect.");
    this.term.writeln(ansi.dim("  Ctrl+Shift+T new tab, Ctrl+Shift+R split right, Ctrl+Shift+D split down."));
    this.term.writeln(ansi.dim("  Ctrl+Shift+C / Ctrl+Shift+V copy and paste. Ctrl+= and Ctrl+- change the font size."));
    this.term.writeln("");
  }

  /** Shown in a workspace pane that hasn't connected yet. */
  waiting(name: string) {
    this.term.reset();
    this.term.writeln(ansi.info(`  ${name}`));
    this.term.writeln(ansi.dim("  From a workspace. Not connected yet: press Connect above when you're ready."));
  }

  copy() {
    if (this.term.hasSelection()) writeText(this.term.getSelection());
  }

  async paste() {
    // Capture the destination before waiting for the OS clipboard.
    const request = this.conn.request;
    const id = this.conn.id;
    try {
      const text = await readText();
      if (this.conn.request === request && this.conn.id === id) await this.pasteText(text ?? "");
    } catch {
      // Clipboard unavailable; no terminal input was sent.
    }
  }

  /** Types an already approved snippet into the shell, then presses Enter if asked.
   * Returns false when the pane disconnected or reconnected since `bound` was taken,
   * so an approval never carries over to another connection. */
  sendText(text: string, enter: boolean, bound: { id: number | null; request: BaseRequest | null }): boolean {
    if (this.disposed || !this.conn.online || this.conn.id !== bound.id || this.conn.request !== bound.request) return false;
    // paste() turns newlines into Enter and uses bracketed paste when the shell asks for it.
    this.term.paste(text);
    if (enter) this.send("\r");
    this.focus();
    return true;
  }

  /** Input from this pane: its own connection, or every broadcast pane. */
  private send(data: string) {
    if (this.host.input) this.host.input(this, data);
    else this.conn.input(data);
  }

  /** Where input typed here goes, this pane included. */
  destinations(): Pane[] {
    return this.host.destinations?.(this) ?? [this];
  }

  /** Marks the pane as one that broadcast input reaches. */
  setBroadcast(on: boolean) {
    this.el.classList.toggle("broadcast", on);
  }

  /** All programmatic pastes (including future snippets) must use this entry point. */
  async pasteText(text: string) {
    if (!text || this.disposed || !this.conn.online || this.pastePending) return;
    const request = this.conn.request!;
    const id = this.conn.id;
    const targets = this.destinations();
    const where = (p: Pane) => this.host.label?.(p) ?? `${p.conn.request?.username}@${p.conn.request?.host}:${p.conn.request?.port} (${p.title})`;
    const prod = targets.filter((p) => this.host.production?.(p));
    this.pastePending = true;
    try {
      // Pasting into several servers at once always gets a second look.
      if (needsPastePreview(text) || targets.length > 1) {
        const modal = showModal<boolean>({
          title: targets.length > 1 ? `Review paste to ${targets.length} terminals` : "Review terminal paste",
          wide: true,
          body: [
            targets.length > 1
              ? el("div", { class: "paste-targets" }, el("p", { text: "Broadcast is on. This goes to every one of:" }), el("ul", {}, ...targets.map((p) => el("li", { text: where(p) }))))
              : el("p", { text: `Destination: ${where(this)}` }),
            prod.length
              ? el("p", { class: "prod-warning", text: `⚠ This goes to ${prod.length === 1 ? "a production system" : `${prod.length} production systems`}.` })
              : el("span"),
            el("p", { text: `${pasteLineCount(text)} lines. Newlines or control characters may execute commands immediately. Control characters other than line feed are shown as Unicode escapes.` }),
            el("pre", { class: "paste-preview", text: pastePreview(text) }),
          ],
          // Enter dismisses safely instead of approving a dangerous paste by accident.
          buttons: [
            { label: "Cancel", value: () => false, primary: true },
            { label: targets.length > 1 ? `Paste to all ${targets.length}` : "Paste to this terminal", value: () => true },
          ],
          onDismiss: () => false,
        });
        this.openPrompts.add(modal.close);
        const approved = await modal.result;
        this.openPrompts.delete(modal.close);
        if (!approved) return;
      }
      // Focus changes cannot redirect this paste; reconnects or a changed
      // broadcast group invalidate approval.
      const same = (a: Pane[], b: Pane[]) => a.length === b.length && a.every((p) => b.includes(p));
      if (!this.disposed && this.conn.online && this.conn.id === id && this.conn.request === request && same(targets, this.destinations())) {
        this.term.paste(text);
      }
    } finally {
      this.pastePending = false;
      // Closing a paste dialog removes the focused button. Give Enter back to
      // this terminal, without stealing focus after a pane switch or reconnect.
      if (!this.disposed && this.conn.online && this.conn.id === id && this.conn.request === request && this.host.canFocus?.(this) !== false) {
        this.focus();
      }
    }
  }

  openSearch() {
    this.searchBar.hidden = false;
    this.searchInput.focus();
    this.searchInput.select();
    this.fit();
  }

  private closeSearch() {
    this.searchBar.hidden = true;
    this.searchAddon.clearDecorations();
    this.searchStatus.textContent = "";
    this.fit();
    this.focus();
  }

  private find(previous: boolean, incremental = false) {
    const text = this.searchInput.value;
    if (!text) {
      this.searchAddon.clearDecorations();
      this.searchStatus.textContent = "";
      return;
    }
    const found = previous
      ? this.searchAddon.findPrevious(text, { regex: false })
      : this.searchAddon.findNext(text, { regex: false, incremental });
    this.searchStatus.textContent = found ? "Match selected" : "No matches";
  }

  get filesOpen() {
    return this.files !== null;
  }

  /** Shows or hides the SFTP file panel beside the terminal. */
  toggleFiles() {
    if (this.files) {
      this.files.dispose();
      this.files = null;
      this.focus();
    } else {
      this.files = new FilePanel(this.conn, () => this.toggleFiles());
      this.body.append(this.files.el);
      this.files.focus();
    }
    this.fit();
    this.host.changed(this);
  }

  dispose() {
    this.files?.dispose();
    this.disposed = true;
    this.conn.disconnect();
    this.closePrompts();
    this.observer.disconnect();
    this.term.dispose();
    this.el.remove();
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === "KeyF") {
      e.preventDefault();
      this.openSearch();
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyC") {
      this.copy();
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      e.preventDefault();
      this.paste();
      return false;
    }
    if (this.host.shortcut(this, e)) {
      e.preventDefault();
      return false;
    }
    return true;
  }

  private openLink(url: string) {
    api.openLink(url).catch((e) => this.term.writeln(`\r\n${ansi.err(String(e))}`));
  }

  // ------------------------------------------------------------ banners (Tailscale)

  private showBanner(text: string, links: BannerLink[], autoOpened: string | null) {
    // Keep the banner in the scrollback too, so the link is never lost.
    for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) this.term.writeln(ansi.warn(line));

    this.bannerText.textContent = text.trim();
    this.bannerLinks.replaceChildren();
    let tailscale = false;
    for (const link of links) {
      const row = el("div", { class: "banner-link" });
      row.append(el("code", { text: link.url }));
      if (link.tailscale) {
        tailscale = true;
        const label = autoOpened === link.url ? "Open again" : "Open in browser";
        const btn = el("button", { class: "btn primary", type: "button", text: label });
        btn.addEventListener("click", () => this.openLink(link.url));
        row.append(btn);
      } else {
        const btn = el("button", { class: "btn", type: "button", text: "Open link…" });
        btn.addEventListener("click", async () => {
          const ok = await confirm("Open this link?", `The server sent a link to a site outside Tailscale:\n\n${link.url}\n\nOnly open it if you trust this server.`, "Open");
          if (ok) this.openLink(link.url);
        });
        row.append(btn);
      }
      this.bannerLinks.append(row);
    }
    if (autoOpened) this.bannerLinks.append(el("p", { class: "hint", text: "Opened the sign-in page in your browser." }));
    this.bannerWait.hidden = !tailscale;
    this.banner.hidden = false;
    this.fit();
  }

  // ------------------------------------------------------------ prompts

  private closePrompts() {
    for (const close of [...this.openPrompts]) close();
    this.openPrompts.clear();
  }

  private prompt(id: number, prompt: Prompt) {
    const cancel: PromptAnswer = { accept: false, values: [], save: false };
    let cancelled = false;
    // Cancels the prompt while it is still waiting in the queue.
    const drop = () => (cancelled = true);
    this.openPrompts.add(drop);
    promptQueue = promptQueue.then(async () => {
      this.openPrompts.delete(drop);
      if (cancelled || this.disposed) {
        await api.answerPrompt(id, cancel).catch(() => {});
        return;
      }
      this.host.activate(this);
      const modal = this.showPrompt(prompt, cancel);
      this.openPrompts.add(modal.close);
      const answer = await modal.result;
      this.openPrompts.delete(modal.close);
      await api.answerPrompt(id, answer).catch(() => {});
    });
  }

  private showPrompt(prompt: Prompt, cancel: PromptAnswer) {
    // Name the session, since prompts can come from any pane.
    const who = el("p", { class: "hint", text: `Session: ${this.conn.title}` });
    switch (prompt.kind) {
      case "hostKey": {
        const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
        return showModal<PromptAnswer>({
          title: "Trust this server?",
          body: [
            who,
            el("p", { text: `This is your first connection to ${where}. Check that the fingerprint below matches the server's before you trust it.` }),
            el("div", { class: "fingerprint" }, el("span", { text: prompt.algorithm }), el("code", { text: prompt.fingerprint })),
            el("p", { class: "hint", text: "On the server, run: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" }),
          ],
          buttons: [
            { label: "Cancel", value: () => cancel },
            { label: "Trust and connect", value: () => ({ accept: true, values: [], save: false }), primary: true },
          ],
          onDismiss: () => cancel,
        });
      }
      case "password":
      case "passphrase": {
        const input = el("input", { type: "password", autocomplete: "off" });
        const [saveRow, save] = checkbox("Save in system keychain");
        const isPw = prompt.kind === "password";
        const label = isPw ? `Password for ${prompt.user}@${prompt.host}` : `Passphrase for ${prompt.keyPath}`;
        return showModal<PromptAnswer>({
          title: isPw ? "Password" : "Key passphrase",
          body: [
            who,
            prompt.retry ? el("p", { class: "modal-error", text: isPw ? "That password didn't work. Try again." : "Wrong passphrase. Try again." }) : el("span"),
            field(label, input),
            prompt.canSave ? saveRow : el("span"),
          ],
          buttons: [
            { label: "Cancel", value: () => cancel },
            { label: "Log in", value: () => ({ accept: true, values: [input.value], save: save.checked }), primary: true },
          ],
          onDismiss: () => cancel,
        });
      }
      case "keyboardInteractive": {
        const inputs = prompt.fields.map((f) => el("input", { type: f.echo ? "text" : "password", autocomplete: "off" }));
        const [saveRow, save] = checkbox("Save in system keychain");
        return showModal<PromptAnswer>({
          title: prompt.name || "Server login",
          body: [
            who,
            prompt.instructions ? el("p", { text: prompt.instructions }) : el("span"),
            ...prompt.fields.map((f, i) => field(f.label.trim() || "Response", inputs[i])),
            prompt.canSave ? saveRow : el("span"),
          ],
          buttons: [
            { label: "Cancel", value: () => cancel },
            { label: "Continue", value: () => ({ accept: true, values: inputs.map((i) => i.value), save: save.checked }), primary: true },
          ],
          onDismiss: () => cancel,
        });
      }
    }
  }
}
