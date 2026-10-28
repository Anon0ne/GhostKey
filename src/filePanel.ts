// The SFTP file panel beside a pane's terminal. It uses the pane's own SSH
// connection, so there is no second login, and an SFTP failure stays in here.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { api } from "./api";
import type { Connection } from "./connection";
import {
  formatMode,
  formatSize,
  isDir,
  localJoin,
  localName,
  nameProblem,
  percent,
  remoteJoin,
  remoteParent,
  safeLocalName,
  sortEntries,
  type Entry,
  type TransferEvent,
} from "./files";
import { checkbox, confirm, el, field, showModal } from "./modal";

/** Last folder chosen for downloads, shared by all panels this run. */
let downloadDir: string | null = null;

const panels = new Set<FilePanel>();
let dropListener: Promise<unknown> | null = null;

/** Files dropped from the desktop go to the panel under the pointer. */
function listenForDrops() {
  dropListener ??= getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      const at = (p: { x: number; y: number }) => {
        const x = p.x / window.devicePixelRatio;
        const y = p.y / window.devicePixelRatio;
        return [...panels].find((panel) => panel.contains(x, y)) ?? null;
      };
      if (payload.type === "over" || payload.type === "enter") {
        const target = at(payload.position);
        for (const panel of panels) panel.setDropTarget(panel === target);
      } else if (payload.type === "drop") {
        for (const panel of panels) panel.setDropTarget(false);
        at(payload.position)?.uploadPaths(payload.paths);
      } else {
        for (const panel of panels) panel.setDropTarget(false);
      }
    })
    .catch(() => null);
}

type Conflict = "ask" | "replace" | "skip";

interface Transfer {
  id: number | null;
  row: HTMLElement;
  bar: HTMLElement;
  info: HTMLElement;
  action: HTMLButtonElement;
  finished: boolean;
}

export class FilePanel {
  readonly el: HTMLElement;
  private pathInput: HTMLInputElement;
  private list: HTMLElement;
  private message: HTMLElement;
  private transfersEl: HTMLElement;
  private actions: Record<"download" | "rename" | "remove", HTMLButtonElement>;
  private toolButtons: HTMLButtonElement[];
  private path = "";
  private entries: Entry[] = [];
  private selected = new Set<string>();
  private anchor: string | null = null;
  /** The connection the listing came from; a reconnect reloads it. */
  private connId: number | null = null;
  private loading = 0;
  private transfers: Transfer[] = [];
  private rows = new Map<string, HTMLElement>();

  constructor(
    private conn: Connection,
    private onClose: () => void,
  ) {
    this.pathInput = el("input", { class: "files-path", spellcheck: "false", "aria-label": "Remote folder" });
    this.pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.load(this.pathInput.value.trim());
      if (e.key === "Escape") this.pathInput.value = this.path;
    });
    const tool = (text: string, title: string, run: () => void) => {
      const b = el("button", { class: "icon-btn", type: "button", text, title, "aria-label": title });
      b.addEventListener("click", run);
      return b;
    };
    const up = tool("↑", "Up one folder", () => void this.load(remoteParent(this.path)));
    const refresh = tool("⟳", "Refresh", () => void this.load(this.path));
    const mkdir = tool("+", "New folder", () => void this.newFolder());
    const upload = tool("⇧", "Upload files…", () => void this.chooseUploads());
    const close = tool("×", "Close files (Ctrl+Shift+E)", () => this.onClose());
    this.toolButtons = [up, refresh, mkdir, upload];

    this.list = el("div", { class: "files-list", role: "listbox", "aria-multiselectable": "true", tabindex: "0" });
    this.list.addEventListener("keydown", (e) => this.onListKey(e));
    this.message = el("div", { class: "files-message", hidden: true });

    const action = (text: string, run: () => void, danger = false) => {
      const b = el("button", { class: danger ? "btn danger" : "btn", type: "button", text });
      b.addEventListener("click", run);
      return b;
    };
    this.actions = {
      download: action("Download…", () => void this.downloadSelected()),
      rename: action("Rename", () => void this.renameSelected()),
      remove: action("Delete", () => void this.removeSelected(), true),
    };
    this.transfersEl = el("div", { class: "files-transfers" });

    this.el = el(
      "aside",
      { class: "files", "aria-label": "Remote files" },
      el("div", { class: "files-bar" }, up, this.pathInput, refresh, mkdir, upload, close),
      this.message,
      this.list,
      el("div", { class: "files-actions" }, this.actions.download, this.actions.rename, this.actions.remove),
      el("p", { class: "files-hint", text: "Drop files here to upload them to this folder." }),
      this.transfersEl,
    );
    panels.add(this);
    listenForDrops();
    this.sync();
  }

  contains(x: number, y: number): boolean {
    if (!this.el.isConnected || this.el.offsetWidth === 0) return false;
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  setDropTarget(on: boolean) {
    this.el.classList.toggle("drop-target", on && this.conn.online);
  }

  focus() {
    this.list.focus();
  }

  /** Follows the connection: loads after connecting or reconnecting, and disables when offline. */
  sync() {
    const online = this.conn.online;
    for (const b of this.toolButtons) b.disabled = !online;
    this.pathInput.disabled = !online;
    if (!online) {
      this.connId = null;
      this.showMessage(this.conn.request ? "Not connected." : "Connect to a server to browse its files.");
      this.entries = [];
      this.render();
      return;
    }
    if (this.connId !== this.conn.id) {
      this.connId = this.conn.id;
      void this.load(this.path);
    }
  }

  dispose() {
    panels.delete(this);
    for (const t of this.transfers) if (!t.finished && t.id != null) void api.sftpCancel(t.id);
    this.el.remove();
  }

  // ------------------------------------------------------------ listing

  private async load(path: string) {
    const id = this.conn.id;
    if (id == null || !this.conn.online) return;
    const ticket = ++this.loading;
    this.list.setAttribute("aria-busy", "true");
    try {
      const listing = await api.sftpList(id, path);
      if (ticket !== this.loading || id !== this.conn.id) return;
      if (listing.path !== this.path) {
        this.selected.clear();
        this.anchor = null;
      }
      this.path = listing.path;
      this.entries = sortEntries(listing.entries);
      this.showMessage(null);
    } catch (e) {
      if (ticket !== this.loading) return;
      this.showMessage(String(e), path !== this.path ? null : () => void this.load(path));
      if (!this.path) this.entries = [];
    } finally {
      if (ticket === this.loading) this.list.removeAttribute("aria-busy");
    }
    this.pathInput.value = this.path;
    this.render();
  }

  private showMessage(text: string | null, retry?: (() => void) | null) {
    this.message.replaceChildren();
    this.message.hidden = !text;
    if (!text) return;
    this.message.append(el("span", { text }));
    if (retry) {
      const b = el("button", { class: "btn", type: "button", text: "Try again" });
      b.addEventListener("click", retry);
      this.message.append(b);
    }
  }

  private render() {
    this.list.replaceChildren();
    this.rows.clear();
    const live = new Set(this.entries.map((e) => e.name));
    for (const name of [...this.selected]) if (!live.has(name)) this.selected.delete(name);
    if (this.conn.online && this.path && this.entries.length === 0) {
      this.list.append(el("p", { class: "empty", text: "This folder is empty." }));
    }
    for (const entry of this.entries) {
      const dir = isDir(entry);
      const row = el(
        "div",
        {
          class: "files-row",
          role: "option",
          title: [entry.name, formatMode(entry), entry.modified ? new Date(entry.modified * 1000).toLocaleString() : ""]
            .filter(Boolean)
            .join("\n"),
        },
        el("span", { class: dir ? "files-icon dir" : "files-icon", text: dir ? "▸" : entry.kind === "link" ? "↪" : "·" }),
        el("span", { class: "files-name", text: entry.name }),
        el("span", { class: "files-size", text: dir ? "" : formatSize(entry.size) }),
      );
      row.addEventListener("mousedown", (e) => {
        if (e.button === 0) this.select(entry.name, e.ctrlKey || e.metaKey, e.shiftKey);
      });
      row.addEventListener("dblclick", () => {
        if (dir) void this.load(remoteJoin(this.path, entry.name));
        else void this.download([entry]);
      });
      this.rows.set(entry.name, row);
      this.list.append(row);
    }
    this.showSelection();
  }

  /** Marks selected rows in place, so a double-click lands on the same element. */
  private showSelection() {
    for (const [name, row] of this.rows) {
      const on = this.selected.has(name);
      row.classList.toggle("selected", on);
      row.setAttribute("aria-selected", String(on));
    }
    this.updateActions();
  }

  private select(name: string, toggle: boolean, range: boolean) {
    if (range && this.anchor) {
      const names = this.entries.map((e) => e.name);
      const [a, b] = [names.indexOf(this.anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (!toggle) this.selected.clear();
      for (const n of names.slice(a, b + 1)) this.selected.add(n);
    } else if (toggle) {
      if (!this.selected.delete(name)) this.selected.add(name);
      this.anchor = name;
    } else {
      this.selected = new Set([name]);
      this.anchor = name;
    }
    this.showSelection();
  }

  private onListKey(e: KeyboardEvent) {
    const names = this.entries.map((x) => x.name);
    const current = this.anchor ? names.indexOf(this.anchor) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(names.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
      if (names[next]) this.select(names[next], false, e.shiftKey);
      this.list.querySelector(".files-row.selected")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const entry = this.entries.find((x) => x.name === this.anchor);
      if (entry && isDir(entry)) void this.load(remoteJoin(this.path, entry.name));
      else if (entry) void this.download([entry]);
    } else if (e.key === "Backspace") {
      void this.load(remoteParent(this.path));
    } else if (e.key === "Delete") {
      void this.removeSelected();
    } else if (e.key === "F2") {
      void this.renameSelected();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.selected = new Set(names);
      this.showSelection();
    }
  }

  private selection(): Entry[] {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  private updateActions() {
    const sel = this.selection();
    const online = this.conn.online;
    this.actions.download.disabled = !online || sel.length === 0 || sel.some(isDir);
    this.actions.download.title = sel.some(isDir) ? "Folder downloads aren't supported yet" : "";
    this.actions.rename.disabled = !online || sel.length !== 1;
    this.actions.remove.disabled = !online || sel.length === 0;
  }

  // ------------------------------------------------------------ file operations

  private async askName(title: string, label: string, initial: string, action: string): Promise<string | null> {
    const input = el("input", { value: initial, spellcheck: "false" });
    const modal = showModal<string | null>({
      title,
      body: [field(label, input)],
      buttons: [
        { label: "Cancel", value: () => null },
        { label: action, value: () => input.value.trim(), primary: true },
      ],
      onDismiss: () => null,
      validate: () => nameProblem(input.value.trim()),
    });
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    return modal.result;
  }

  private async run(what: () => Promise<void>) {
    try {
      await what();
    } catch (e) {
      await confirm("That didn't work", String(e), "OK");
    }
    await this.load(this.path);
    this.focus();
  }

  private async newFolder() {
    const id = this.conn.id;
    const dir = this.path;
    const name = await this.askName("New folder", `Name, in ${dir}`, "", "Create");
    if (name == null || id !== this.conn.id || id == null) return;
    await this.run(() => api.sftpMkdir(id, remoteJoin(dir, name)));
  }

  private async renameSelected() {
    const [entry] = this.selection();
    const id = this.conn.id;
    if (!entry || id == null || this.selected.size !== 1) return;
    const dir = this.path;
    const name = await this.askName(`Rename "${entry.name}"`, "New name", entry.name, "Rename");
    if (name == null || name === entry.name || id !== this.conn.id) return;
    await this.run(async () => {
      await api.sftpRename(id, remoteJoin(dir, entry.name), remoteJoin(dir, name));
      this.selected = new Set([name]);
      this.anchor = name;
    });
  }

  private async removeSelected() {
    const sel = this.selection();
    const id = this.conn.id;
    if (sel.length === 0 || id == null) return;
    const dir = this.path;
    const what = sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} items`;
    const dirs = sel.some((e) => e.kind === "dir");
    const ok = await confirm(
      `Delete ${what}?`,
      `This deletes from ${this.conn.title}:${dir} and can't be undone.${dirs ? " Folders must be empty." : ""}`,
      "Delete",
      true,
    );
    if (!ok || id !== this.conn.id || !this.conn.online) return;
    await this.run(async () => {
      const failed: string[] = [];
      for (const e of sel) {
        try {
          await api.sftpRemove(id, remoteJoin(dir, e.name), e.kind === "dir");
        } catch (err) {
          failed.push(`${e.name}: ${err}`);
        }
      }
      if (failed.length) throw new Error(failed.join("\n"));
    });
  }

  // ------------------------------------------------------------ transfers

  private async downloadSelected() {
    await this.download(this.selection());
  }

  private async download(entries: Entry[]) {
    const id = this.conn.id;
    const dir = this.path;
    const files = entries.filter((e) => !isDir(e));
    if (id == null || files.length === 0) return;
    const start = downloadDir ?? (await api.defaultDownloadDir().catch(() => null)) ?? undefined;
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: start, title: "Download to folder" });
    if (typeof picked !== "string" || id !== this.conn.id) return;
    downloadDir = picked;
    let policy: Conflict = "ask";
    for (const e of files) {
      const local = localJoin(picked, safeLocalName(e.name));
      const kind = await api.localKind(local).catch(() => "missing");
      let overwrite = false;
      if (kind === "dir") {
        this.addFailed(`↓ ${e.name}`, `${local} is a folder`);
        continue;
      }
      if (kind === "file") {
        const decision = await this.resolveConflict(policy, local, files.length > 1);
        if (decision.all) policy = decision.replace ? "replace" : "skip";
        if (!decision.replace) continue;
        overwrite = true;
      }
      if (id !== this.conn.id || !this.conn.online) return;
      this.startTransfer(id, `↓ ${e.name}`, { upload: false, local, remote: remoteJoin(dir, e.name), overwrite }, `Saved to ${picked}`);
    }
  }

  private async chooseUploads() {
    const id = this.conn.id;
    const dir = this.path;
    const picked = await openDialog({ multiple: true, directory: false, title: `Upload to ${this.path}` });
    if (!picked || id !== this.conn.id || dir !== this.path || !this.conn.online) return;
    await this.uploadPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async uploadPaths(paths: string[]) {
    const id = this.conn.id;
    const dir = this.path;
    if (id == null || !this.conn.online || !dir || paths.length === 0) return;
    let policy: Conflict = "ask";
    for (const local of paths) {
      const name = localName(local);
      const kind = await api.localKind(local).catch(() => "missing");
      if (kind !== "file") {
        this.addFailed(`↑ ${name}`, kind === "dir" ? "Folder uploads aren't supported yet" : "File not found");
        continue;
      }
      const remote = remoteJoin(dir, name);
      let overwrite = false;
      let exists = false;
      try {
        exists = await api.sftpExists(id, remote);
      } catch (e) {
        this.addFailed(`↑ ${name}`, String(e));
        continue;
      }
      if (exists) {
        const decision = await this.resolveConflict(policy, `${this.conn.title}:${remote}`, paths.length > 1);
        if (decision.all) policy = decision.replace ? "replace" : "skip";
        if (!decision.replace) continue;
        overwrite = true;
      }
      if (id !== this.conn.id) return;
      this.startTransfer(id, `↑ ${name}`, { upload: true, local, remote, overwrite }, `Uploaded to ${dir}`, () => {
        if (this.path === dir) void this.load(dir);
      });
    }
  }

  /** Asks before replacing a file, unless an earlier answer applies to all. */
  private async resolveConflict(policy: Conflict, target: string, several: boolean): Promise<{ replace: boolean; all: boolean }> {
    if (policy !== "ask") return { replace: policy === "replace", all: true };
    const [allRow, all] = checkbox("Do the same for the other files");
    const replace = await showModal<boolean>({
      title: "Replace existing file?",
      body: [el("p", { text: `${target} already exists.` }), several ? allRow : el("span")],
      // Enter keeps the existing file.
      buttons: [
        { label: "Skip", value: () => false, primary: true },
        { label: "Replace", value: () => true, danger: true },
      ],
      onDismiss: () => false,
    }).result;
    return { replace, all: several && all.checked };
  }

  private transferRow(label: string): Transfer {
    const bar = el("div", { class: "files-progress-bar" });
    const info = el("span", { class: "files-transfer-info", text: "Starting…" });
    const action = el("button", { class: "icon-btn", type: "button", text: "×", title: "Cancel", "aria-label": `Cancel ${label}` });
    const row = el(
      "div",
      { class: "files-transfer" },
      el("div", { class: "files-transfer-head" }, el("span", { class: "files-transfer-name", text: label, title: label }), action),
      el("div", { class: "files-progress" }, bar),
      info,
    );
    this.transfersEl.prepend(row);
    const t: Transfer = { id: null, row, bar, info, action, finished: false };
    this.transfers.push(t);
    action.addEventListener("click", () => {
      if (!t.finished && t.id != null) void api.sftpCancel(t.id);
      else if (t.finished) {
        row.remove();
        this.transfers = this.transfers.filter((x) => x !== t);
      }
    });
    return t;
  }

  private finish(t: Transfer, state: "done" | "failed" | "cancelled", text: string) {
    t.finished = true;
    t.row.classList.add(state);
    t.info.textContent = text;
    t.info.title = text;
    t.action.title = "Clear";
    t.action.setAttribute("aria-label", "Clear");
  }

  private addFailed(label: string, error: string) {
    this.finish(this.transferRow(label), "failed", error);
  }

  private startTransfer(
    id: number,
    label: string,
    spec: { upload: boolean; local: string; remote: string; overwrite: boolean },
    doneText: string,
    after?: () => void,
  ) {
    const t = this.transferRow(label);
    const onEvent = (e: TransferEvent) => {
      if (e.type === "progress") {
        const p = percent(e.done, e.total);
        t.bar.style.width = `${p}%`;
        t.info.textContent = `${p}%  ${formatSize(e.done)} of ${formatSize(e.total)}`;
        return;
      }
      if (e.type === "done") {
        t.bar.style.width = "100%";
        this.finish(t, "done", doneText);
      } else if (e.type === "cancelled") this.finish(t, "cancelled", "Cancelled");
      else this.finish(t, "failed", e.error);
      after?.();
    };
    api.sftpTransfer(id, spec, onEvent).then(
      (tid) => (t.id = tid),
      (e) => this.finish(t, "failed", String(e)),
    );
  }
}
