// A terminal pane: its own xterm, Tailscale banner, login prompts, and Connection.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import { api, type BannerLink, type Prompt, type PromptAnswer } from "./api";
import { ansi, Connection } from "./connection";
import { checkbox, confirm, el, field, showModal } from "./modal";
import { FONT_FAMILY, kaliDark } from "./theme";

export interface PaneHost {
  fontSize(): number;
  /** The pane wants focus, e.g. to show a login prompt. */
  activate(pane: Pane): void;
  changed(pane: Pane): void;
  /** Lets the app handle its own shortcuts; returns true when it did. */
  shortcut(pane: Pane, e: KeyboardEvent): boolean;
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
  private termEl: HTMLElement;
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
    this.termEl = el("div", { class: "terminal" });
    this.el = el("div", { class: "pane" }, this.banner, this.termEl);

    this.term = new Terminal({
      theme: kaliDark,
      fontFamily: FONT_FAMILY,
      fontSize: host.fontSize(),
      fontWeight: "normal",
      fontWeightBold: "bold",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: false,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Ctrl/Cmd+click opens links, as in most terminals.
        if (event.ctrlKey || event.metaKey) this.openLink(uri);
      }),
    );

    this.conn = new Connection(api, {
      write: (data) => this.term.write(data),
      writeln: (text) => this.term.writeln(text),
      reset: () => this.term.reset(),
      size: () => ({ cols: this.term.cols, rows: this.term.rows }),
      fit: () => this.fit(),
      focus: () => this.focus(),
      showBanner: (text, links, autoOpened) => this.showBanner(text, links, autoOpened),
      hideBanner: () => (this.banner.hidden = true),
      prompt: (id, prompt) => this.prompt(id, prompt),
      closePrompts: () => this.closePrompts(),
      changed: () => host.changed(this),
    });

    this.term.onData((data) => this.conn.input(data));
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

  welcome() {
    this.term.reset();
    this.term.writeln(ansi.info("  GhostKey") + ansi.dim("  alpha"));
    this.term.writeln("");
    this.term.writeln("  Double-click a saved session, or type " + ansi.ok("user@host") + " in Quick connect.");
    this.term.writeln(ansi.dim("  Ctrl+Shift+T new tab, Ctrl+Shift+R split right, Ctrl+Shift+D split down."));
    this.term.writeln(ansi.dim("  Ctrl+Shift+C / Ctrl+Shift+V copy and paste. Ctrl+= and Ctrl+- change the font size."));
    this.term.writeln("");
  }

  copy() {
    if (this.term.hasSelection()) writeText(this.term.getSelection());
  }

  async paste() {
    try {
      const text = await readText();
      if (text) this.term.paste(text);
    } catch {
      // Clipboard empty or not text.
    }
  }

  /** Types text into the shell, then presses Enter if asked. Returns false when not connected. */
  sendText(text: string, enter: boolean): boolean {
    if (!this.conn.online) return false;
    // paste() turns newlines into Enter and uses bracketed paste when the shell asks for it.
    this.term.paste(text);
    if (enter) this.conn.input("\r");
    this.focus();
    return true;
  }

  dispose() {
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
    if (mod && e.shiftKey && e.code === "KeyC") {
      this.copy();
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
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
