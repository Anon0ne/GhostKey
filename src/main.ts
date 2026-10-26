import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

import { api, type BannerLink, type ConnEvent, type ConnectRequest, type Prompt, type PromptAnswer, type SavedSession } from "./api";
import { checkbox, confirm, el, field, showModal } from "./modal";
import { DEFAULT_FONT_SIZE, FONT_FAMILY, kaliDark } from "./theme";

// ANSI helpers in Kali-Dark colors, for GhostKey's own messages in the terminal.
const ansi = {
  info: (s: string) => `\x1b[1;34m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  err: (s: string) => `\x1b[1;31m${s}\x1b[0m`,
};

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

// ---------------------------------------------------------------- terminal

const term = new Terminal({
  theme: kaliDark,
  fontFamily: FONT_FAMILY,
  fontSize: Number(loadPref("fontSize", String(DEFAULT_FONT_SIZE))) || DEFAULT_FONT_SIZE,
  fontWeight: "normal",
  fontWeightBold: "bold",
  cursorBlink: true,
  scrollback: 10000,
  allowProposedApi: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(
  new WebLinksAddon((event, uri) => {
    // Ctrl/Cmd+click opens links, as in most terminals.
    if (event.ctrlKey || event.metaKey) {
      api.openLink(uri).catch((e) => term.writeln(`\r\n${ansi.err(String(e))}`));
    }
  }),
);

// ---------------------------------------------------------------- state

interface Connection {
  gen: number;
  id: number | null;
  title: string;
  connected: boolean;
  closed: boolean;
}

let sessions: SavedSession[] = [];
let conn: Connection | null = null;
let gen = 0;
const openPrompts = new Set<() => void>();

function setStatus(state: "idle" | "busy" | "online" | "error", title: string, status = "") {
  $("status-dot").className = `dot ${state}`;
  $("conn-title").textContent = title;
  $("conn-status").textContent = status;
  $<HTMLButtonElement>("disconnect").hidden = !(conn && !conn.closed);
}

function welcome() {
  term.reset();
  term.writeln(ansi.info("  GhostKey") + ansi.dim("  alpha"));
  term.writeln("");
  term.writeln("  Double-click a saved session, or type " + ansi.ok("user@host") + " in Quick connect.");
  term.writeln(ansi.dim("  Ctrl+Shift+C / Ctrl+Shift+V copy and paste. Ctrl+= and Ctrl+- change the font size."));
  term.writeln("");
}

// ---------------------------------------------------------------- connecting

async function connectTo(req: Omit<ConnectRequest, "cols" | "rows">, title: string) {
  if (conn && !conn.closed) {
    const ok = await confirm("Disconnect?", `You're connected to ${conn.title}. Disconnect and connect to ${title}?`, "Disconnect");
    if (!ok) return;
    disconnect();
  }
  const myGen = ++gen;
  conn = { gen: myGen, id: null, title, connected: false, closed: false };
  term.reset();
  hideBanner();
  fit.fit();
  setStatus("busy", title, "Connecting…");
  term.focus();

  const full: ConnectRequest = { ...req, cols: term.cols, rows: term.rows };
  try {
    const id = await api.connect(
      full,
      (e) => {
        if (conn?.gen === myGen) onConnEvent(e);
      },
      (data) => {
        if (conn?.gen === myGen) term.write(data);
      },
    );
    if (conn?.gen === myGen) conn.id = id;
  } catch (e) {
    term.writeln(ansi.err(`Couldn't start the connection: ${e}`));
    if (conn?.gen === myGen) conn.closed = true;
    setStatus("error", title, "Failed");
  }
}

function disconnect() {
  if (!conn || conn.closed) return;
  conn.closed = true;
  if (conn.id !== null) api.disconnect(conn.id);
  closePrompts();
  hideBanner();
  term.writeln(`\r\n${ansi.dim("Disconnected.")}`);
  setStatus("idle", conn.title, "Disconnected");
}

function onConnEvent(e: ConnEvent) {
  if (!conn) return;
  switch (e.type) {
    case "status":
      setStatus("busy", conn.title, e.message);
      term.writeln(ansi.dim(e.message));
      break;
    case "banner":
      showBanner(e.text, e.links, e.autoOpened);
      break;
    case "prompt":
      handlePrompt(e.id, e.prompt);
      break;
    case "connected":
      conn.connected = true;
      hideBanner();
      setStatus("online", conn.title, "Connected");
      fit.fit();
      if (conn.id !== null) api.resize(conn.id, term.cols, term.rows);
      term.focus();
      break;
    case "closed": {
      const wasClosed = conn.closed;
      conn.closed = true;
      closePrompts();
      hideBanner();
      if (e.error) {
        term.writeln(`\r\n${ansi.err(e.error)}`);
        setStatus("error", conn.title, "Connection closed with an error");
      } else if (!wasClosed) {
        term.writeln(`\r\n${ansi.dim("Connection closed.")}`);
        setStatus("idle", conn.title, "Disconnected");
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- banners (Tailscale)

function showBanner(text: string, links: BannerLink[], autoOpened: string | null) {
  // Keep the banner in the scrollback too, so the link is never lost.
  for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) term.writeln(ansi.warn(line));

  $("banner-text").textContent = text.trim();
  const box = $("banner-links");
  box.replaceChildren();
  let tailscale = false;
  for (const link of links) {
    const row = el("div", { class: "banner-link" });
    row.append(el("code", { text: link.url }));
    if (link.tailscale) {
      tailscale = true;
      const label = autoOpened === link.url ? "Open again" : "Open in browser";
      const btn = el("button", { class: "btn primary", type: "button", text: label });
      btn.addEventListener("click", () => openLink(link.url));
      row.append(btn);
    } else {
      const btn = el("button", { class: "btn", type: "button", text: "Open link…" });
      btn.addEventListener("click", async () => {
        const ok = await confirm("Open this link?", `The server sent a link to a site outside Tailscale:\n\n${link.url}\n\nOnly open it if you trust this server.`, "Open");
        if (ok) openLink(link.url);
      });
      row.append(btn);
    }
    box.append(row);
  }
  if (autoOpened) box.append(el("p", { class: "hint", text: "Opened the sign-in page in your browser." }));
  $("banner-wait").hidden = !tailscale;
  $("banner").hidden = false;
  if (tailscale && conn) setStatus("busy", conn.title, "Waiting for Tailscale approval");
}

function hideBanner() {
  $("banner").hidden = true;
}

function openLink(url: string) {
  api.openLink(url).catch((e) => term.writeln(ansi.err(String(e))));
}

// ---------------------------------------------------------------- prompts

function closePrompts() {
  for (const close of [...openPrompts]) close();
  openPrompts.clear();
}

async function handlePrompt(id: number, prompt: Prompt) {
  const cancel: PromptAnswer = { accept: false, values: [], save: false };
  let modal: { result: Promise<PromptAnswer>; close: () => void };

  switch (prompt.kind) {
    case "hostKey": {
      const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
      modal = showModal<PromptAnswer>({
        title: "Trust this server?",
        body: [
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
      break;
    }
    case "password":
    case "passphrase": {
      const input = el("input", { type: "password", autocomplete: "off" });
      const [saveRow, save] = checkbox("Save in system keychain");
      const isPw = prompt.kind === "password";
      const label = isPw ? `Password for ${prompt.user}@${prompt.host}` : `Passphrase for ${prompt.keyPath}`;
      modal = showModal<PromptAnswer>({
        title: isPw ? "Password" : "Key passphrase",
        body: [
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
      break;
    }
    case "keyboardInteractive": {
      const inputs = prompt.fields.map((f) => el("input", { type: f.echo ? "text" : "password", autocomplete: "off" }));
      const [saveRow, save] = checkbox("Save in system keychain");
      modal = showModal<PromptAnswer>({
        title: prompt.name || "Server login",
        body: [
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
      break;
    }
  }

  openPrompts.add(modal.close);
  const answer = await modal.result;
  openPrompts.delete(modal.close);
  await api.answerPrompt(id, answer);
}

// ---------------------------------------------------------------- saved sessions

async function refreshSessions() {
  try {
    sessions = await api.listSessions();
  } catch (e) {
    sessions = [];
    term.writeln(ansi.err(`Couldn't load saved sessions: ${e}`));
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
  connectTo(
    {
      sessionId: s.id,
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      keyPath: s.keyPath,
      autoOpenTailscale: s.autoOpenTailscale,
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
  connectTo(
    { sessionId: null, host: parsed.host, port: parsed.port, username: parsed.user, auth: "password", keyPath: null, autoOpenTailscale: false },
    `${parsed.user}@${parsed.host}`,
  );
});
$("quick-input").addEventListener("input", (e) => (e.target as HTMLElement).classList.remove("invalid"));

// ---------------------------------------------------------------- wiring

$("search").addEventListener("input", renderSessions);
$("new-session").addEventListener("click", () => editSession());
$("disconnect").addEventListener("click", disconnect);
$("banner-cancel").addEventListener("click", disconnect);

term.onData((data) => {
  if (conn?.connected && !conn.closed && conn.id !== null) api.sendInput(conn.id, data);
});
term.onResize(({ cols, rows }) => {
  if (conn?.connected && !conn.closed && conn.id !== null) api.resize(conn.id, cols, rows);
});

function setFontSize(size: number) {
  const clamped = Math.max(9, Math.min(32, size));
  term.options.fontSize = clamped;
  savePref("fontSize", String(clamped));
  fit.fit();
}

async function paste() {
  try {
    const text = await readText();
    if (text) term.paste(text);
  } catch {
    // Clipboard empty or not text.
  }
}

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.code === "KeyC") {
    if (term.hasSelection()) writeText(term.getSelection());
    return false;
  }
  if (mod && e.shiftKey && e.code === "KeyV") {
    paste();
    return false;
  }
  if (mod && !e.shiftKey && (e.key === "=" || e.key === "+")) {
    setFontSize((term.options.fontSize ?? DEFAULT_FONT_SIZE) + 1);
    return false;
  }
  if (mod && !e.shiftKey && e.key === "-") {
    setFontSize((term.options.fontSize ?? DEFAULT_FONT_SIZE) - 1);
    return false;
  }
  if (mod && !e.shiftKey && e.key === "0") {
    setFontSize(DEFAULT_FONT_SIZE);
    return false;
  }
  return true;
});

// Right-click copies the selection, or pastes when nothing is selected.
$("terminal").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (term.hasSelection()) {
    writeText(term.getSelection());
    term.clearSelection();
  } else {
    paste();
  }
});

async function start() {
  // Load both weights first so bold prompts render in real bold from the start.
  await Promise.allSettled([document.fonts.load('14px "Fira Code"'), document.fonts.load('bold 14px "Fira Code"')]);
  term.open($("terminal"));
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe($("terminal"));
  welcome();
  setStatus("idle", "Not connected");
  await refreshSessions();
}

start();
