import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { api, type SavedSession } from "./api";
import { ansi, type BaseRequest } from "./connection";
import { clampRatio, leaf, nearest, panes, remove, split, type Dir, type Direction, type LayoutNode } from "./layout";
import { checkbox, confirm, el, field, showModal } from "./modal";
import { Pane, type PaneHost } from "./pane";
import { DEFAULT_FONT_SIZE } from "./theme";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function loadPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`ghostkey.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`ghostkey.${key}`, value);
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}

let sessions: SavedSession[] = [];
let fontSize = Number(loadPref("fontSize", String(DEFAULT_FONT_SIZE))) || DEFAULT_FONT_SIZE;

// ---------------------------------------------------------------- tabs and panes

interface Tab {
  root: LayoutNode<Pane>;
  active: Pane;
  el: HTMLElement;
}

const tabs: Tab[] = [];
let current: Tab;

const host: PaneHost = {
  fontSize: () => fontSize,
  activate: (pane) => focusPane(pane, false),
  changed: (pane) => {
    renderTabs();
    if (pane === activePane()) renderToolbar();
  },
  shortcut: (_pane, e) => shortcut(e),
};

function activePane(): Pane {
  return current.active;
}

function tabOf(pane: Pane): Tab | undefined {
  return tabs.find((t) => panes(t.root).includes(pane));
}

function newTab(): Pane {
  const pane = new Pane(host);
  const tab: Tab = { root: leaf(pane), active: pane, el: el("div", { class: "tab-body", hidden: true }) };
  $("workspace").append(tab.el);
  tabs.push(tab);
  renderLayout(tab);
  selectTab(tab);
  pane.welcome();
  return pane;
}

function selectTab(tab: Tab) {
  current = tab;
  for (const t of tabs) t.el.hidden = t !== tab;
  // Background tabs measure as zero, so fit once this one is visible.
  requestAnimationFrame(() => panes(tab.root).forEach((p) => p.fit()));
  renderTabs();
  renderToolbar();
  tab.active.focus();
}

/** Makes `pane` the active one, switching tabs if needed. */
function focusPane(pane: Pane, focus = true) {
  const tab = tabOf(pane);
  if (!tab) return;
  const changed = tab.active !== pane;
  tab.active = pane;
  if (tab !== current) selectTab(tab);
  else if (changed) {
    renderTabs();
    renderToolbar();
  }
  for (const p of panes(tab.root)) p.el.classList.toggle("active", p === pane);
  if (focus) pane.focus();
}

/** Builds a tab's split tree as nested flex boxes. Panes keep their elements. */
function renderLayout(tab: Tab) {
  const build = (node: LayoutNode<Pane>, flex: number): HTMLElement => {
    if (node.kind === "leaf") {
      node.pane.el.style.flex = `${flex} 1 0px`;
      return node.pane.el;
    }
    const box = el("div", { class: `split ${node.dir}` });
    box.style.flex = `${flex} 1 0px`;
    const a = build(node.a, node.ratio);
    const b = build(node.b, 1 - node.ratio);
    const gutter = el("div", { class: "gutter", role: "separator" });
    gutter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      gutter.setPointerCapture(e.pointerId);
      const rect = box.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const ratio = node.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        node.ratio = clampRatio(ratio);
        a.style.flex = `${node.ratio} 1 0px`;
        b.style.flex = `${1 - node.ratio} 1 0px`;
      };
      const up = () => {
        gutter.removeEventListener("pointermove", move);
        gutter.removeEventListener("pointerup", up);
        gutter.focus();
      };
      gutter.addEventListener("pointermove", move);
      gutter.addEventListener("pointerup", up);
    });
    box.append(a, gutter, b);
    return box;
  };
  tab.el.replaceChildren(build(tab.root, 1));
  const all = panes(tab.root);
  tab.el.classList.toggle("multi", all.length > 1);
  for (const p of all) p.el.classList.toggle("active", p === tab.active);
  requestAnimationFrame(() => all.forEach((p) => p.fit()));
}

function splitPane(dir: Dir) {
  const tab = current;
  const from = tab.active;
  const pane = new Pane(host);
  tab.root = split(tab.root, from, pane, dir);
  renderLayout(tab);
  focusPane(pane);
  // A split opens another shell on the same server, like QTerminal and SecureCRT.
  if (from.conn.request) {
    const req = from.conn.request;
    requestAnimationFrame(() => pane.conn.connect({ ...req, log: false }, from.conn.title));
  } else {
    pane.welcome();
  }
}

async function closePane(pane: Pane) {
  const tab = tabOf(pane);
  if (!tab) return;
  if (pane.conn.active) {
    const ok = await confirm("Close this session?", `You're connected to ${pane.conn.title}. Disconnect and close it?`, "Close", true);
    if (!ok) return;
  }
  const root = remove(tab.root, pane);
  pane.dispose();
  if (!root) {
    removeTab(tab);
    return;
  }
  tab.root = root;
  if (tab.active === pane) tab.active = panes(root)[0];
  renderLayout(tab);
  if (tab === current) {
    focusPane(tab.active);
    renderToolbar();
  }
  renderTabs();
}

async function closeTab(tab: Tab) {
  const live = panes(tab.root).filter((p) => p.conn.active);
  if (live.length) {
    const names = live.map((p) => p.conn.title).join(", ");
    const ok = await confirm("Close this tab?", `This tab has ${live.length === 1 ? "an open session" : `${live.length} open sessions`} (${names}). Disconnect and close it?`, "Close", true);
    if (!ok) return;
  }
  panes(tab.root).forEach((p) => p.dispose());
  removeTab(tab);
}

function removeTab(tab: Tab) {
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  if (tabs.length === 0) newTab();
  else if (tab === current) selectTab(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

function moveFocus(dir: Direction) {
  const all = panes(current.root);
  const rects = all.map((p) => p.el.getBoundingClientRect());
  const next = nearest(rects, all.indexOf(current.active), dir);
  if (next !== null) focusPane(all[next]);
}

/** Opens a session in the active pane when it is free, otherwise in a new tab. */
function openSession(req: BaseRequest, title: string) {
  const pane = activePane().conn.active ? newTab() : activePane();
  pane.conn.connect(req, title);
}

function renderTabs() {
  const strip = $("tabs");
  strip.replaceChildren();
  for (const tab of tabs) {
    const all = panes(tab.root);
    const p = tab.active;
    const recording = all.some((x) => x.conn.logPath);
    const close = el("button", { class: "tab-close", type: "button", title: "Close tab", text: "✕" });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    const node = el(
      "div",
      { class: `tab${tab === current ? " current" : ""}`, role: "tab", "aria-selected": String(tab === current), title: p.title },
      el("span", { class: `dot ${p.conn.state}` }),
      el("span", { class: "tab-title", text: p.title }),
      all.length > 1 ? el("span", { class: "tab-count", text: String(all.length) }) : null,
      recording ? el("span", { class: "tab-rec", title: "Logging", text: "●" }) : null,
      close,
    );
    node.addEventListener("click", () => selectTab(tab));
    node.addEventListener("auxclick", (e) => {
      if (e.button === 1) closeTab(tab);
    });
    strip.append(node);
  }
}

function renderToolbar() {
  const conn = activePane().conn;
  $("status-dot").className = `dot ${conn.state}`;
  $("conn-title").textContent = conn.request ? conn.title : "Not connected";
  $("conn-status").textContent = conn.status;
  const stop = $<HTMLButtonElement>("disconnect");
  stop.hidden = !conn.active;
  stop.textContent = conn.stopLabel;
  const retry = $<HTMLButtonElement>("reconnect");
  retry.hidden = !conn.canRetry;
  retry.textContent = conn.retryLabel;
  const log = $<HTMLButtonElement>("log-toggle");
  log.hidden = !conn.online;
  log.textContent = conn.logPath ? "Stop log" : "Start log";
  const rec = $("log-indicator");
  rec.hidden = !conn.logPath;
  rec.title = conn.logPath ? `Logging to ${conn.logPath}` : "";
}

function shortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.shiftKey && !e.altKey) {
    if (key === "=" || key === "+") return setFontSize(fontSize + 1);
    if (key === "-") return setFontSize(fontSize - 1);
    if (key === "0") return setFontSize(DEFAULT_FONT_SIZE);
    if (key === "PageUp" || key === "PageDown") {
      const i = tabs.indexOf(current) + (key === "PageUp" ? -1 : 1);
      selectTab(tabs[(i + tabs.length) % tabs.length]);
      return true;
    }
  }
  if (mod && e.shiftKey && !e.altKey) {
    switch (e.code) {
      case "KeyT":
        newTab();
        return true;
      case "KeyW":
        closePane(activePane());
        return true;
      case "KeyR":
        splitPane("row");
        return true;
      case "KeyD":
        splitPane("column");
        return true;
      case "KeyL":
        activePane().conn.toggleLog();
        return true;
    }
  }
  if (e.altKey && !mod && !e.shiftKey) {
    const arrows: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (arrows[e.key]) {
      moveFocus(arrows[e.key]);
      return true;
    }
    const n = /^Digit([1-9])$/.exec(e.code);
    if (n && tabs[Number(n[1]) - 1]) {
      selectTab(tabs[Number(n[1]) - 1]);
      return true;
    }
  }
  return false;
}

function setFontSize(size: number): true {
  fontSize = Math.max(9, Math.min(32, size));
  savePref("fontSize", String(fontSize));
  for (const tab of tabs) panes(tab.root).forEach((p) => p.setFontSize(fontSize));
  return true;
}

// ---------------------------------------------------------------- settings

async function openSettings() {
  let dir = await api.getLogDir().catch((e) => String(e));
  let reset = false;
  const path = el("input", { value: dir, readonly: true, spellcheck: "false" });
  const browse = el("button", { class: "btn", type: "button", text: "Change…" });
  browse.addEventListener("click", async () => {
    const picked = await openFileDialog({ directory: true, multiple: false, title: "Choose a folder for session logs", defaultPath: dir });
    if (typeof picked === "string") {
      dir = picked;
      reset = false;
      path.value = picked;
    }
  });
  const resetBtn = el("button", { class: "link-btn", type: "button", text: "Use the default folder" });
  resetBtn.addEventListener("click", () => {
    reset = true;
    path.value = "Default (Documents/GhostKey Logs)";
  });
  const openBtn = el("button", { class: "link-btn", type: "button", text: "Open the log folder" });
  openBtn.addEventListener("click", () => api.openLogDir().catch((e) => confirm("Couldn't open the folder", String(e), "OK")));

  const choice = await showModal<boolean>({
    title: "Settings",
    body: [
      field("Session log folder", el("div", { class: "inline" }, path, browse), "Logs are plain text with colors removed. They hold everything the server prints, which can include secrets."),
      el("div", { class: "inline links" }, resetBtn, openBtn),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save", value: () => true, primary: true },
    ],
    onDismiss: () => false,
  }).result;
  if (!choice) return;
  try {
    await api.setLogDir(reset ? null : dir);
  } catch (e) {
    await confirm("Couldn't save settings", String(e), "OK");
  }
}

// ---------------------------------------------------------------- saved sessions

async function refreshSessions() {
  try {
    sessions = await api.listSessions();
  } catch (e) {
    sessions = [];
    activePane().term.writeln(ansi.err(`Couldn't load saved sessions: ${e}`));
  }
  renderSessions();
}

function collapsedFolders(): Set<string> {
  try {
    return new Set(JSON.parse(loadPref("collapsed", "[]")) as string[]);
  } catch {
    return new Set();
  }
}

function renderSessions() {
  const list = $("session-list");
  const query = $<HTMLInputElement>("search").value.trim().toLowerCase();
  const collapsed = collapsedFolders();
  const shown = sessions.filter((s) =>
    !query || [s.name, s.folder, s.host, s.username].some((v) => v.toLowerCase().includes(query)),
  );

  const groups = new Map<string, SavedSession[]>();
  for (const s of shown) {
    const g = groups.get(s.folder) ?? [];
    g.push(s);
    groups.set(s.folder, g);
  }

  list.replaceChildren();
  if (sessions.length === 0) {
    list.append(el("p", { class: "empty", text: "No saved sessions yet. Press + to add one." }));
    return;
  }
  if (shown.length === 0) {
    list.append(el("p", { class: "empty", text: "No sessions match your search." }));
    return;
  }

  for (const [folder, items] of groups) {
    const container = el("div", { class: "folder" });
    if (folder) {
      const isCollapsed = collapsed.has(folder) && !query;
      const head = el("button", { class: `folder-head${isCollapsed ? " collapsed" : ""}`, type: "button" }, el("span", { class: "chev", text: "▾" }), el("span", { text: folder }));
      head.addEventListener("click", () => {
        const set = collapsedFolders();
        if (set.has(folder)) set.delete(folder);
        else set.add(folder);
        savePref("collapsed", JSON.stringify([...set]));
        renderSessions();
      });
      container.append(head);
      if (isCollapsed) {
        list.append(container);
        continue;
      }
    }
    for (const s of items) container.append(sessionRow(s));
    list.append(container);
  }
}

function sessionRow(s: SavedSession): HTMLElement {
  const connectBtn = el("button", { class: "row-btn", type: "button", title: "Connect", text: "▶" });
  const editBtn = el("button", { class: "row-btn", type: "button", title: "Edit", text: "✎" });
  const delBtn = el("button", { class: "row-btn", type: "button", title: "Delete", text: "✕" });
  const row = el(
    "div",
    { class: "session", tabindex: "0" },
    el("div", { class: "session-text" }, el("span", { class: "session-name", text: s.name }), el("span", { class: "session-host", text: `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}` })),
    el("div", { class: "row-actions" }, connectBtn, editBtn, delBtn),
  );
  const go = () => connectSaved(s);
  row.addEventListener("dblclick", go);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  connectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    go();
  });
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    editSession(s);
  });
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (await confirm("Delete session?", `Delete "${s.name}" and any password saved for it?`, "Delete", true)) {
      await api.deleteSession(s.id);
      refreshSessions();
    }
  });
  return row;
}

function connectSaved(s: SavedSession) {
  openSession(
    {
      sessionId: s.id,
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      keyPath: s.keyPath,
      autoOpenTailscale: s.autoOpenTailscale,
      log: s.autoLog,
      label: s.name,
    },
    s.name,
  );
}

async function editSession(existing?: Partial<SavedSession>) {
  const isNew = !existing?.id;
  const s: SavedSession = {
    id: existing?.id ?? crypto.randomUUID(),
    name: existing?.name ?? "",
    folder: existing?.folder ?? "",
    host: existing?.host ?? "",
    port: existing?.port ?? 22,
    username: existing?.username ?? "",
    auth: existing?.auth ?? "password",
    keyPath: existing?.keyPath ?? null,
    autoOpenTailscale: existing?.autoOpenTailscale ?? false,
    autoLog: existing?.autoLog ?? false,
  };

  const name = el("input", { value: s.name, placeholder: "Kali lab", spellcheck: "false" });
  const folders = [...new Set(sessions.map((x) => x.folder).filter(Boolean))];
  const folderList = el("datalist", { id: "folder-options" }, ...folders.map((f) => el("option", { value: f })));
  const folder = el("input", { value: s.folder, placeholder: "Optional, e.g. Work/Lab", list: "folder-options", spellcheck: "false" });
  const host = el("input", { value: s.host, placeholder: "192.168.1.10 or myhost.tailnet.ts.net", spellcheck: "false" });
  const port = el("input", { value: String(s.port), type: "number", min: "1", max: "65535" });
  const user = el("input", { value: s.username, placeholder: "kali", spellcheck: "false" });
  const auth = el("select", {}, el("option", { value: "password", text: "Password" }), el("option", { value: "key", text: "Private key" }));
  auth.value = s.auth;
  const keyPath = el("input", { value: s.keyPath ?? "", placeholder: "~/.ssh/id_ed25519 or a .ppk file", spellcheck: "false" });
  const browse = el("button", { class: "btn", type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, title: "Choose a private key" });
    if (typeof picked === "string") keyPath.value = picked;
  });
  const keyField = field("Key file", el("div", { class: "inline" }, keyPath, browse), "OpenSSH or PuTTY (.ppk) format. You'll be asked for the passphrase if it has one.");
  const syncKey = () => (keyField.hidden = auth.value !== "key");
  auth.addEventListener("change", syncKey);
  syncKey();
  const [autoRow, autoOpen] = checkbox("Open Tailscale sign-in links automatically", s.autoOpenTailscale);
  const [logRow, autoLog] = checkbox("Log this session to a file automatically", s.autoLog);
  const logHint = el("small", { class: "hint", text: "Logs hold everything the server prints, which can include secrets. Change the folder in Settings." });

  let forget: HTMLElement = el("span");
  if (!isNew) {
    const b = el("button", { class: "link-btn", type: "button", text: "Forget saved password and passphrase" });
    b.addEventListener("click", async () => {
      await api.forgetSecrets(s.id);
      b.textContent = "Forgotten";
      b.setAttribute("disabled", "");
    });
    forget = b;
  }

  const read = (): SavedSession => ({
    ...s,
    name: name.value.trim(),
    folder: folder.value.trim().replace(/^\/+|\/+$/g, ""),
    host: host.value.trim(),
    port: Number(port.value),
    username: user.value.trim(),
    auth: auth.value as SavedSession["auth"],
    keyPath: auth.value === "key" ? keyPath.value.trim() || null : null,
    autoOpenTailscale: autoOpen.checked,
    autoLog: autoLog.checked,
  });

  const choice = await showModal<"cancel" | "save" | "connect">({
    title: isNew ? "New session" : "Edit session",
    body: [
      folderList,
      el("div", { class: "grid" }, field("Name", name), field("Folder", folder)),
      el("div", { class: "grid host-row" }, field("Host", host), field("Port", port)),
      el("div", { class: "grid" }, field("Username", user), field("Login with", auth)),
      keyField,
      autoRow,
      logRow,
      logHint,
      forget,
    ],
    buttons: [
      { label: "Cancel", value: () => "cancel" },
      { label: "Save", value: () => "save" },
      { label: "Save and connect", value: () => "connect", primary: true },
    ],
    onDismiss: () => "cancel",
    validate: () => {
      const v = read();
      if (!v.name) return "Give the session a name.";
      if (!v.host || /\s/.test(v.host)) return "Enter a host without spaces.";
      if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) return "Port must be between 1 and 65535.";
      if (!v.username) return "Enter a username.";
      if (v.auth === "key" && !v.keyPath) return "Choose a key file.";
      return null;
    },
  }).result;

  if (choice === "cancel") return;
  const saved = read();
  try {
    await api.saveSession(saved);
  } catch (e) {
    await confirm("Couldn't save", String(e), "OK");
    return;
  }
  await refreshSessions();
  if (choice === "connect") connectSaved(saved);
}

// ---------------------------------------------------------------- quick connect

function parseQuick(text: string): { user: string; host: string; port: number } | null {
  const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text.trim());
  if (!m) return null;
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) return null;
  return { user: m[1] ?? "", host: m[2].replace(/^\[|\]$/g, ""), port };
}

$("quick-connect").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("quick-input");
  const parsed = parseQuick(input.value);
  if (!parsed) {
    input.classList.add("invalid");
    return;
  }
  input.classList.remove("invalid");
  if (!parsed.user) {
    editSession({ host: parsed.host, port: parsed.port, name: parsed.host });
    return;
  }
  const title = `${parsed.user}@${parsed.host}`;
  openSession(
    { sessionId: null, host: parsed.host, port: parsed.port, username: parsed.user, auth: "password", keyPath: null, autoOpenTailscale: false, log: false, label: title },
    title,
  );
});
$("quick-input").addEventListener("input", (e) => (e.target as HTMLElement).classList.remove("invalid"));

// ---------------------------------------------------------------- wiring

$("search").addEventListener("input", renderSessions);
$("new-session").addEventListener("click", () => editSession());
$("settings").addEventListener("click", openSettings);
$("new-tab").addEventListener("click", () => newTab());
$("disconnect").addEventListener("click", () => activePane().conn.disconnect());
$("reconnect").addEventListener("click", () => activePane().conn.retry());
$("log-toggle").addEventListener("click", () => activePane().conn.toggleLog());
$("split-right").addEventListener("click", () => splitPane("row"));
$("split-down").addEventListener("click", () => splitPane("column"));

// App shortcuts also work when focus is outside the terminal, e.g. in the sidebar.
document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest?.(".xterm, .backdrop")) return;
  if (shortcut(e)) e.preventDefault();
});

async function start() {
  // Load both weights first so bold prompts render in real bold from the start.
  await Promise.allSettled([document.fonts.load('14px "Fira Code"'), document.fonts.load('bold 14px "Fira Code"')]);
  newTab();
  await refreshSessions();
}

start();
