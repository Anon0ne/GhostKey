import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";

import { api, type SavedSession } from "./api";
import { ansi, type BaseRequest } from "./connection";
import { clampRatio, leaf, nearest, panes, remove, split, type Dir, type Direction, type LayoutNode } from "./layout";
import { planRows, problem, toSessions, type Row, type Scan } from "./importPlan";
import { grouped, lineCount, needsPreview, payload, risky, type Snippet } from "./snippets";
import { pastePreview } from "./paste";
import { checkbox, confirm, el, field, showModal } from "./modal";
import { Pane, type PaneHost } from "./pane";
import { openTunnels, savedTunnelsEditor, tunnelsChanged } from "./tunnelUi";
import { Broadcast } from "./broadcast";
import { openKeyManager } from "./keyManager";
import { ENVIRONMENTS, envBadge, envInfo, isProduction, matchesSearch, parseTags, type Environment } from "./hostLabels";
import { report, stageLabel, type Step } from "./diagnostics";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MenuBar, type Menu } from "./menu";
import { jumpChain, jumpChoices, routeText } from "./jumps";
import { describeTmux, tmuxNameProblem } from "./tmux";
import { suggestRedaction, toJson, toMarkdown, NOT_FORENSIC, type Bookmark } from "./bookmarks";
import { capture, cleanWorkspace, leaves, preview, restore, type Workspace } from "./workspace";
import { buildProfile, compare, parseProfile, type ParseResult } from "./profile";
import { DEFAULT_PREFS, FONT_CHOICES, loadPrefs, MAX_FONT_SIZE, MIN_FONT_SIZE, normalizePrefs, savePrefs, type CursorStyle, type Prefs } from "./prefs";
import { THEME_IDS, THEMES, themeById } from "./theme";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

let sessions: SavedSession[] = [];
let snippets: Snippet[] = [];
let prefs: Prefs = loadPrefs(storage(), THEME_IDS);

function termOptions() {
  return {
    theme: themeById(prefs.theme).term,
    fontFamily: prefs.fontFamily,
    cursorStyle: prefs.cursorStyle,
    cursorBlink: prefs.cursorBlink,
    scrollback: prefs.scrollback,
  };
}

/** Applies prefs to the app shell and every terminal, and saves them. */
function setPrefs(next: Prefs) {
  prefs = next;
  savePrefs(storage(), prefs);
  const theme = themeById(prefs.theme);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.chrome)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.dark ? "dark" : "light";
  root.style.setProperty("--mono", prefs.fontFamily);
  $("app").classList.toggle("no-sidebar", !prefs.showSidebar);
  $("snippet-bar").hidden = !prefs.showSnippetBar;
  const options = { ...termOptions(), fontSize: prefs.fontSize };
  for (const tab of tabs) panes(tab.root).forEach((p) => p.applyOptions(options));
}

// ---------------------------------------------------------------- tabs and panes

interface Tab {
  root: LayoutNode<Pane>;
  active: Pane;
  el: HTMLElement;
}

const tabs: Tab[] = [];
let current: Tab;
const broadcast = new Broadcast<Pane>();

const host: PaneHost = {
  fontSize: () => prefs.fontSize,
  termOptions,
  copyOnSelect: () => prefs.copyOnSelect,
  autoReconnect: () => prefs.autoReconnect,
  input: (pane, data) => {
    for (const p of broadcast.targets(pane)) p.conn.input(data);
  },
  destinations: (pane) => broadcast.targets(pane),
  label: (pane) => paneLabel(pane),
  production: (pane) => isProduction(paneEnv(pane)),
  activate: (pane) => focusPane(pane, false),
  changed: (pane) => {
    renderTabs();
    if (pane === activePane()) renderToolbar();
    renderBroadcast();
  },
  shortcut: (_pane, e) => shortcut(e),
  close: (pane) => void closePane(pane),
  canFocus: (pane) => pane === activePane() && !document.querySelector(".backdrop"),
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
    // The new shell shares the server but not the tunnels, whose ports are taken.
    requestAnimationFrame(() => pane.conn.connect({ ...req, log: false, forwards: [], tmux: null }, from.conn.title));
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
  broadcast.drop(pane);
  pane.dispose();
  renderBroadcast();
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
  panes(tab.root).forEach((p) => {
    broadcast.drop(p);
    p.dispose();
  });
  renderBroadcast();
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

/** Moves a pane, still connected, into another tab (split beside its active pane) or a new tab. */
function movePane(pane: Pane, to: Tab | null) {
  const from = tabOf(pane);
  if (!from || to === from || (!to && panes(from.root).length === 1)) return;
  const rest = remove(from.root, pane);
  let target: Tab;
  if (to) {
    to.root = split(to.root, to.active, pane, "row");
    to.active = pane;
    target = to;
  } else {
    target = { root: leaf(pane), active: pane, el: el("div", { class: "tab-body", hidden: true }) };
    $("workspace").append(target.el);
    tabs.splice(tabs.indexOf(from) + 1, 0, target);
  }
  if (rest) {
    from.root = rest;
    if (from.active === pane) from.active = panes(rest)[0];
    renderLayout(from);
  } else {
    tabs.splice(tabs.indexOf(from), 1);
    from.el.remove();
  }
  renderLayout(target);
  selectTab(target);
  focusPane(pane);
  renderBroadcast();
}

function tabLabel(tab: Tab): string {
  const names = panes(tab.root).map((p) => (p.conn.request ? p.conn.title : "empty"));
  return `Tab ${tabs.indexOf(tab) + 1}: ${names.join(", ")}`;
}

async function chooseMoveTarget() {
  const pane = activePane();
  const others = tabs.filter((t) => t !== current);
  if (!others.length) return;
  const picker = el("select", { "aria-label": "Tab" }, ...others.map((t, i) => el("option", { value: String(i), text: tabLabel(t) })));
  const ok = await showModal<boolean>({
    title: "Move pane to tab",
    body: [
      el("p", { text: `Moves ${pane.conn.request ? pane.conn.title : "this pane"} into another tab, beside its active pane. The connection stays open.` }),
      field("Tab", picker),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Move", value: () => true, primary: true },
    ],
    onDismiss: () => false,
  }).result;
  if (ok) movePane(pane, others[Number(picker.value)]);
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
      // The worst environment in the tab, so production is never hidden behind a split.
      badgeEl(all.some((x) => isProduction(paneEnv(x))) ? "production" : paneEnv(p)),
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
  const envNode = $("conn-env");
  const env = paneEnv(activePane());
  envNode.hidden = !env;
  envNode.className = `env-badge env-${env}`;
  envNode.textContent = envBadge(env);
  envNode.title = env ? `${envInfo(env)?.label} system` : "";
  $("conn-status").textContent = conn.status;
  const stop = $<HTMLButtonElement>("disconnect");
  stop.hidden = !conn.active;
  stop.textContent = conn.stopLabel;
  $("diagnostics").hidden = !(conn.state === "error" && conn.trace.outcome !== "none");
  const retry = $<HTMLButtonElement>("reconnect");
  retry.hidden = !conn.canRetry;
  retry.textContent = conn.retryLabel;
  const log = $<HTMLButtonElement>("log-toggle");
  log.hidden = !conn.online;
  log.textContent = conn.logPath ? "Stop log" : "Start log";
  const rec = $("log-indicator");
  rec.hidden = !conn.logPath;
  rec.title = conn.logPath ? `Logging to ${conn.logPath}` : "";
  for (const b of document.querySelectorAll<HTMLButtonElement>("#snippet-favorites button")) b.disabled = !conn.online;
  $("files-toggle").setAttribute("aria-pressed", String(activePane().filesOpen));
  const tunnels = $<HTMLButtonElement>("tunnels");
  tunnels.hidden = !conn.online;
  const failed = conn.tunnels.some((t) => t.state === "failed");
  tunnels.textContent = conn.tunnels.length ? `Tunnels (${conn.tunnels.length})` : "Tunnels";
  tunnels.classList.toggle("warn", failed);
  tunnels.title = conn.tunnels.length
    ? conn.tunnels.map((t) => `${t.state}: ${t.bound ?? ""} ${t.error ?? ""}`.trim()).join("\n")
    : "Port forwarding for this connection";
  tunnelsChanged();
}

function shortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.shiftKey && !e.altKey) {
    if (key === "=" || key === "+") return setFontSize(prefs.fontSize + 1);
    if (key === "-") return setFontSize(prefs.fontSize - 1);
    if (key === "0") return setFontSize(DEFAULT_PREFS.fontSize);
    if (key === ",") {
      void openSettings();
      return true;
    }
    if (key === "PageUp" || key === "PageDown") {
      const i = tabs.indexOf(current) + (key === "PageUp" ? -1 : 1);
      selectTab(tabs[(i + tabs.length) % tabs.length]);
      return true;
    }
  }
  if (mod && e.shiftKey && !e.altKey) {
    switch (e.code) {
      case "KeyF":
        activePane().openSearch();
        return true;
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
      case "KeyS":
        openSnippets();
        return true;
      case "KeyE":
        activePane().toggleFiles();
        return true;
      case "KeyB":
        setPrefs({ ...prefs, showSidebar: !prefs.showSidebar });
        return true;
      case "KeyI":
        if (broadcast.on) stopBroadcast();
        else void chooseBroadcast();
        return true;
      case "KeyM":
        void bookmarkSelection();
        return true;
    }
  }
  // Not from the terminal: htop, mc and others use F10 themselves.
  const inTerminal = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
  if (e.key === "F10" && !mod && !e.altKey && !e.shiftKey && !inTerminal) {
    menuBar.focusFirst();
    return true;
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
  const fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  prefs = { ...prefs, fontSize };
  savePrefs(storage(), prefs);
  for (const tab of tabs) panes(tab.root).forEach((p) => p.setFontSize(fontSize));
  return true;
}

// ---------------------------------------------------------------- import

async function importSessions() {
  let scan: Scan;
  try {
    scan = await api.scanImports();
  } catch (e) {
    await confirm("Couldn't look for sessions", String(e), "OK");
    return;
  }
  let rows: Row[] = planRows(scan.candidates, sessions);
  const folder = el("input", { value: "Imported", spellcheck: "false" });
  const summary = el("div", { class: "import-sources" });
  const table = el("div", { class: "import-list" });

  const renderSources = () => {
    summary.replaceChildren();
    for (const s of scan.sources) {
      const count = scan.candidates.filter((c) => c.source === s.label).length;
      const status = s.error ? `couldn't read: ${s.error}` : !s.found ? "not found" : `${count} ${count === 1 ? "session" : "sessions"}`;
      summary.append(el("div", { class: `import-source${s.error ? " bad" : ""}` }, el("strong", { text: s.label }), el("span", { text: ` ${status}` })));
      for (const note of s.notes) summary.append(el("div", { class: "import-note", text: note }));
    }
  };

  const renderRows = () => {
    table.replaceChildren();
    if (rows.length === 0) {
      table.append(el("p", { class: "empty", text: "No sessions found. Try choosing a config file." }));
      return;
    }
    for (const row of rows) {
      const c = row.candidate;
      const pick = el("input", { type: "checkbox", checked: row.selected, "aria-label": `Import ${c.name}` });
      const name = el("input", { value: row.name, spellcheck: "false", "aria-label": "Name" });
      const user = el("input", { value: row.username, placeholder: "user", spellcheck: "false", "aria-label": "User" });
      pick.addEventListener("change", () => (row.selected = pick.checked));
      name.addEventListener("input", () => (row.name = name.value));
      user.addEventListener("input", () => {
        row.username = user.value;
        if (user.value.trim() && !row.existing) pick.checked = row.selected = true;
      });
      const where = `${c.host}${c.port === 22 ? "" : `:${c.port}`}`;
      const details = el(
        "div",
        { class: "import-details" },
        el("div", { class: "import-target" }, user, el("span", { class: "session-host", text: `@${where}` })),
        el("small", { class: "hint", text: [c.source, c.keyPath ? `key ${c.keyPath}` : "password login"].join(" · ") }),
        ...c.notes.map((n) => el("small", { class: "import-note", text: n })),
      );
      if (row.existing) {
        const action = el(
          "select",
          { "aria-label": "Already saved" },
          el("option", { value: "skip", text: `Skip: already saved as "${row.existing.name}"` }),
          el("option", { value: "update", text: `Update "${row.existing.name}"` }),
          el("option", { value: "add", text: "Add as a new session" }),
        );
        action.value = row.action;
        action.addEventListener("change", () => {
          row.action = action.value as Row["action"];
          pick.checked = row.selected = row.action !== "skip";
        });
        details.append(action);
      }
      table.append(el("div", { class: "import-row" }, pick, el("div", { class: "import-main" }, name, details)));
    }
  };

  const choose = el("button", { class: "btn", type: "button", text: "Choose a config file…" });
  choose.addEventListener("click", async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, title: "Choose an OpenSSH config file" });
    if (typeof picked !== "string") return;
    const extra = await api.scanSshConfig(picked);
    scan = { candidates: [...scan.candidates, ...extra.candidates], sources: [...scan.sources, ...extra.sources] };
    rows = [...rows, ...planRows(extra.candidates, sessions)];
    renderSources();
    renderRows();
  });

  renderSources();
  renderRows();
  const ok = await showModal<boolean>({
    title: "Import sessions",
    wide: true,
    body: [
      el("p", { class: "hint", text: "Found in your SSH config and PuTTY. Nothing is changed in those files, and no commands in them are run. Passwords are never imported." }),
      summary,
      table,
      el("div", { class: "grid" }, field("Put new sessions in folder", folder), el("div", { class: "import-choose" }, choose)),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Import", value: () => true, primary: true },
    ],
    onDismiss: () => false,
    validate: () => problem(rows),
  }).result;
  if (!ok) return;

  const chosen = toSessions(rows, folder.value, () => crypto.randomUUID(), sessions);
  const failed: string[] = [];
  for (const s of chosen) {
    try {
      await api.saveSession(s);
    } catch (e) {
      failed.push(`${s.name}: ${e}`);
    }
  }
  await refreshSessions();
  if (failed.length) await confirm("Some sessions weren't imported", failed.join("\n"), "OK");
}

// ---------------------------------------------------------------- snippets

async function refreshSnippets() {
  try {
    snippets = await api.listSnippets();
  } catch (e) {
    snippets = [];
    activePane().term.writeln(ansi.err(`Couldn't load snippets: ${e}`));
  }
  renderSnippetBar();
}

function renderSnippetBar() {
  const bar = $("snippet-favorites");
  bar.replaceChildren();
  const favorites = snippets.filter((s) => s.favorite);
  if (favorites.length === 0) {
    bar.append(el("span", { class: "hint", text: "Star a snippet to put it here." }));
  }
  for (const s of favorites) {
    const b = el("button", { class: `bar-btn${s.run ? " run" : ""}`, type: "button", title: snippetTitle(s), text: s.run ? `${s.name} ⏎` : s.name });
    b.addEventListener("click", () => sendSnippet(s));
    bar.append(b);
  }
  renderToolbar();
}

function snippetTitle(s: Snippet): string {
  const how = s.run ? "Runs" : "Types in (you press Enter)";
  return `${how}: ${pastePreview(payload(s).text)}`;
}

/** The saved session a pane connected from, looked up live so edits show at once. */
function savedFor(pane: Pane): SavedSession | undefined {
  const id = pane.conn.request?.sessionId;
  return id ? sessions.find((s) => s.id === id) : undefined;
}

function paneEnv(pane: Pane): Environment {
  return pane.conn.request ? (savedFor(pane)?.environment ?? "") : "";
}

function badgeEl(env: Environment): HTMLElement | null {
  const e = envInfo(env);
  return e ? el("span", { class: `env-badge env-${e.value}`, title: `${e.label} system`, text: envBadge(env) }) : null;
}

function destination(pane: Pane): string {
  const r = pane.conn.request;
  if (!r) return pane.title;
  return `${pane.conn.title} (${r.username}@${r.host}${r.port === 22 ? "" : `:${r.port}`})`;
}

/** Names a pane by its tab and position too, so two panes on one host can be told apart. */
function paneLabel(pane: Pane): string {
  const ti = tabs.findIndex((t) => panes(t.root).includes(pane));
  if (ti < 0) return destination(pane);
  const list = panes(tabs[ti].root);
  const where = list.length > 1 ? `Tab ${ti + 1}, pane ${list.indexOf(pane) + 1}` : `Tab ${ti + 1}`;
  const badge = envBadge(paneEnv(pane));
  return `${where}: ${badge ? `${badge} ` : ""}${destination(pane)}`;
}

/** Sends a snippet to the focused pane. Running it, or anything a paste would
 * review (several lines, control characters), is previewed first. The pane and
 * its connection are fixed before the preview, so changing focus or reconnecting
 * meanwhile can't redirect it. This preview replaces the paste review, so only
 * one is shown. */
async function sendSnippet(s: Snippet) {
  const pane = activePane();
  if (!pane.conn.online) {
    await confirm("Not connected", "Connect this pane to a server before sending a snippet.", "OK");
    return;
  }
  const bound = { id: pane.conn.id, request: pane.conn.request };
  const { text, enter } = payload(s);
  const targets = pane.destinations();
  // Sending to several servers, or to production, always gets a second look.
  const prod = targets.filter((p) => isProduction(paneEnv(p)));
  if (needsPreview(s) || targets.length > 1 || prod.length) {
    const lines = lineCount(s);
    const careful = risky(s);
    const ok = await showModal<boolean>({
      title: enter ? `Run "${s.name}"?` : `Type in "${s.name}"?`,
      body: [
        targets.length > 1
          ? el("div", { class: "fingerprint" }, el("span", { text: `Broadcast to ${targets.length} terminals` }), ...targets.map((p) => el("code", { text: paneLabel(p) })))
          : el("div", { class: "fingerprint" }, el("span", { text: "Destination" }), el("code", { text: paneLabel(pane) })),
        prod.length ? el("p", { class: "prod-warning", text: `⚠ This goes to ${prod.length === 1 ? "a production system" : `${prod.length} production systems`}.` }) : el("span"),
        el("pre", { class: "snippet-preview", text: pastePreview(text) }),
        el("p", {
          class: "hint",
          text: [
            `${lines} ${lines === 1 ? "line" : "lines"}.`,
            enter ? "Enter is pressed after the text." : "Nothing runs until you press Enter.",
            lines > 1 ? "If the server's shell doesn't support bracketed paste, each line may run as it arrives." : "",
            pastePreview(text) !== text ? "Control characters other than line feed are shown as Unicode escapes." : "",
          ]
            .filter(Boolean)
            .join(" "),
        }),
      ],
      // Like the paste review, Enter cancels when the text could run more than one command.
      buttons: [
        { label: "Cancel", value: () => false, primary: careful || prod.length > 0 },
        { label: enter ? "Run" : "Type in", value: () => true, primary: !careful && !prod.length, danger: prod.length > 0 },
      ],
      onDismiss: () => false,
    }).result;
    if (!ok) {
      pane.focus();
      return;
    }
  }
  if (!pane.sendText(text, enter, bound)) {
    await confirm("Not sent", `${pane.conn.title} disconnected or reconnected before the snippet was sent.`, "OK");
  }
}

async function openSnippets() {
  const list = el("div", { class: "snippet-list" });
  if (snippets.length === 0) list.append(el("p", { class: "empty", text: "No snippets yet. Add one for commands you type often." }));
  let next: (() => void) | null = null;
  const modal = showModal<null>({
    title: "Snippets",
    wide: true,
    body: [list],
    buttons: [
      { label: "New snippet", value: () => ((next = () => editSnippet()), null) },
      { label: "Close", value: () => null, primary: true },
    ],
    onDismiss: () => null,
  });
  const online = activePane().conn.online;
  for (const [group, items] of grouped(snippets)) {
    if (group) list.append(el("div", { class: "folder-head", text: group }));
    for (const s of items) {
      const send = el("button", { class: "row-btn", type: "button", title: online ? (s.run ? "Run" : "Type in") : "Connect first", text: "▶" });
      send.disabled = !online;
      const edit = el("button", { class: "row-btn", type: "button", title: "Edit", text: "✎" });
      const del = el("button", { class: "row-btn", type: "button", title: "Delete", text: "✕" });
      send.addEventListener("click", () => {
        next = () => sendSnippet(s);
        modal.close();
      });
      edit.addEventListener("click", () => {
        next = () => editSnippet(s);
        modal.close();
      });
      del.addEventListener("click", () => {
        next = async () => {
          if (await confirm("Delete snippet?", `Delete "${s.name}"?`, "Delete", true)) {
            await api.deleteSnippet(s.id);
            await refreshSnippets();
          }
          openSnippets();
        };
        modal.close();
      });
      list.append(
        el(
          "div",
          { class: "snippet-row" },
          el(
            "div",
            { class: "snippet-text" },
            el("span", { class: "session-name", text: `${s.favorite ? "★ " : ""}${s.name}` }),
            el("code", { class: "snippet-command", text: payload(s).text.split("\n").join("  ↵  ") }),
          ),
          el("span", { class: `snippet-mode${s.run ? " run" : ""}`, text: s.run ? "Runs" : "Types in" }),
          send,
          edit,
          del,
        ),
      );
    }
  }
  await modal.result;
  (next as (() => void) | null)?.();
}

async function editSnippet(existing?: Snippet) {
  const s: Snippet = existing ?? { id: crypto.randomUUID(), name: "", group: "", command: "", run: false, favorite: true };
  const name = el("input", { value: s.name, placeholder: "List listening ports", spellcheck: "false" });
  const groups = [...new Set(snippets.map((x) => x.group).filter(Boolean))];
  const groupList = el("datalist", { id: "snippet-groups" }, ...groups.map((g) => el("option", { value: g })));
  const group = el("input", { value: s.group, placeholder: "Optional, e.g. Recon", list: "snippet-groups", spellcheck: "false" });
  const command = el("textarea", { class: "snippet-input", rows: "5", spellcheck: "false", placeholder: "ss -tulpn" });
  command.value = s.command;
  const mode = el(
    "select",
    {},
    el("option", { value: "insert", text: "Type it in; I press Enter myself" }),
    el("option", { value: "run", text: "Type it in and press Enter (asks first)" }),
  );
  mode.value = s.run ? "run" : "insert";
  const [favRow, favorite] = checkbox("Show on the button bar", s.favorite);
  const read = (): Snippet => ({ ...s, name: name.value.trim(), group: group.value.trim(), command: command.value, run: mode.value === "run", favorite: favorite.checked });
  const save = await showModal<boolean>({
    title: existing ? "Edit snippet" : "New snippet",
    body: [
      groupList,
      el("div", { class: "grid" }, field("Name", name), field("Group", group)),
      field("Command", command, "Several lines are fine; they're shown to you before they're sent."),
      field("When used", mode),
      favRow,
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save", value: () => true, primary: true },
    ],
    onDismiss: () => false,
    validate: () => {
      const v = read();
      if (!v.name) return "Give the snippet a name.";
      if (!v.command.trim()) return "Enter a command.";
      return null;
    },
  }).result;
  if (!save) return;
  try {
    await api.saveSnippet(read());
  } catch (e) {
    await confirm("Couldn't save", String(e), "OK");
    return;
  }
  await refreshSnippets();
}

// ---------------------------------------------------------------- settings

function select<T extends string>(options: { label: string; value: T }[], value: T): HTMLSelectElement {
  const node = el("select", {}, ...options.map((o) => el("option", { value: o.value, text: o.label })));
  node.value = value;
  return node;
}

async function openSettings() {
  const before = prefs;
  let dir = await api.getLogDir().catch((e) => String(e));
  let reset = false;

  const theme = select(THEMES.map((t) => ({ label: t.label, value: t.id })), prefs.theme);
  const font = select(FONT_CHOICES, prefs.fontFamily);
  const size = el("input", { type: "number", min: String(MIN_FONT_SIZE), max: String(MAX_FONT_SIZE), value: String(prefs.fontSize) });
  const cursor = select<CursorStyle>(
    [
      { label: "Block", value: "block" },
      { label: "Bar", value: "bar" },
      { label: "Underline", value: "underline" },
    ],
    prefs.cursorStyle,
  );
  const [blinkRow, blink] = checkbox("Blinking cursor", prefs.cursorBlink);
  const scrollback = el("input", { type: "number", min: "1000", max: "200000", step: "1000", value: String(prefs.scrollback) });
  const [copyRow, copySelect] = checkbox("Copy text as soon as it's selected", prefs.copyOnSelect);
  const [sidebarRow, sidebar] = checkbox("Show the session list (Ctrl+Shift+B)", prefs.showSidebar);
  const [barRow, bar] = checkbox("Show the snippet bar", prefs.showSnippetBar);
  const user = el("input", { value: prefs.defaultUser, placeholder: "e.g. kali", spellcheck: "false" });
  const port = el("input", { type: "number", min: "1", max: "65535", value: String(prefs.defaultPort) });
  const [reconnectRow, reconnect] = checkbox("Reconnect on its own when a connection drops", prefs.autoReconnect);

  const read = (): Prefs =>
    normalizePrefs(
      {
        ...prefs,
        theme: theme.value,
        fontFamily: font.value,
        fontSize: Number(size.value),
        cursorStyle: cursor.value,
        cursorBlink: blink.checked,
        scrollback: Number(scrollback.value),
        copyOnSelect: copySelect.checked,
        showSidebar: sidebar.checked,
        showSnippetBar: bar.checked,
        defaultUser: user.value,
        defaultPort: Number(port.value),
        autoReconnect: reconnect.checked,
      },
      THEME_IDS,
    );
  // Show changes as they are made; Cancel puts everything back.
  for (const input of [theme, font, size, cursor, blink, sidebar, bar]) input.addEventListener("change", () => setPrefs(read()));

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

  const section = (title: string, ...children: HTMLElement[]) => el("fieldset", { class: "settings-section" }, el("legend", { text: title }), ...children);
  const choice = await showModal<boolean>({
    title: "Settings",
    wide: true,
    body: [
      el(
        "div",
        { class: "settings-grid" },
        section("Appearance", field("Theme", theme), field("Font", font, "Fonts other than Fira Code are used when installed."), field("Font size", size, "Ctrl+= and Ctrl+- also change it.")),
        section("Terminal", field("Cursor", cursor), blinkRow, field("Scrollback lines", scrollback, "Lines kept per terminal for scrolling and Find."), copyRow),
        section("Window", sidebarRow, barRow),
        section(
          "Connections",
          field("Default user", user, "Quick connect uses it when the address has no user@."),
          field("Default port", port),
          reconnectRow,
          el("small", { class: "hint", text: "Tries 5 times over about a minute, after sleep or a network change. Each reconnect starts a new shell." }),
        ),
      ),
      section(
        "Session logs",
        field("Folder", el("div", { class: "inline" }, path, browse), "Logs are plain text with colors removed. They hold everything the server prints, which can include secrets."),
        el("div", { class: "inline links" }, resetBtn, openBtn),
      ),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save", value: () => true, primary: true },
    ],
    onDismiss: () => false,
  }).result;
  if (!choice) {
    setPrefs(before);
    return;
  }
  setPrefs(read());
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
    return new Set(JSON.parse(storage()?.getItem("ghostkey.collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function renderSessions() {
  const list = $("session-list");
  const query = $<HTMLInputElement>("search").value.trim().toLowerCase();
  const collapsed = collapsedFolders();
  const shown = sessions.filter((s) => !query || matchesSearch(s, query));

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
        try {
          storage()?.setItem("ghostkey.collapsed", JSON.stringify([...set]));
        } catch {
          // Collapsed folders are a convenience.
        }
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
    el(
      "div",
      { class: "session-text" },
      el("span", { class: "session-name" }, badgeEl(s.environment), el("span", { text: s.name })),
      el("span", { class: "session-host", text: `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}` }),
      s.tags.length ? el("span", { class: "session-tags" }, ...s.tags.map((t) => el("span", { class: "tag", text: `#${t}` }))) : null,
    ),
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
  const chain = jumpChain(s, sessions);
  if (!chain.ok) {
    void confirm("Can't reach this session", chain.error, "OK");
    return;
  }
  const req = requestFor(s);
  if (req) openSession(req, s.name);
}

/** The connection settings for a saved session, or null when its jump hosts can't be used. */
function requestFor(s: SavedSession): BaseRequest | null {
  const chain = jumpChain(s, sessions);
  if (!chain.ok) return null;
  const jumps = chain.hops.map((j) => ({ sessionId: j.id, host: j.host, port: j.port, username: j.username, auth: j.auth, keyPath: j.keyPath }));
  return (
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
      forwards: s.forwards ?? [],
      jumps,
      tmux: s.tmux || null,
    }
  );
}

async function editSession(existing?: Partial<SavedSession>) {
  const isNew = !existing?.id;
  const s: SavedSession = {
    id: existing?.id ?? crypto.randomUUID(),
    name: existing?.name ?? "",
    folder: existing?.folder ?? "",
    host: existing?.host ?? "",
    port: existing?.port ?? prefs.defaultPort,
    username: existing?.username ?? prefs.defaultUser,
    auth: existing?.auth ?? "password",
    keyPath: existing?.keyPath ?? null,
    autoOpenTailscale: existing?.autoOpenTailscale ?? false,
    autoLog: existing?.autoLog ?? false,
    forwards: existing?.forwards ?? [],
    jumpSession: existing?.jumpSession ?? null,
    tags: existing?.tags ?? [],
    environment: existing?.environment ?? "",
    tmux: existing?.tmux ?? "",
  };

  const name = el("input", { value: s.name, placeholder: "Kali lab", spellcheck: "false" });
  const folders = [...new Set(sessions.map((x) => x.folder).filter(Boolean))];
  const folderList = el("datalist", { id: "folder-options" }, ...folders.map((f) => el("option", { value: f })));
  const folder = el("input", { value: s.folder, placeholder: "Optional, e.g. Work/Lab", list: "folder-options", spellcheck: "false" });
  const host = el("input", { value: s.host, placeholder: "192.168.1.10 or myhost.tailnet.ts.net", spellcheck: "false" });
  const port = el("input", { value: String(s.port), type: "number", min: "1", max: "65535" });
  const user = el("input", { value: s.username, placeholder: "kali", spellcheck: "false" });
  const auth = el("select", {}, el("option", { value: "password", text: "Password" }), el("option", { value: "key", text: "Private key" }), el("option", { value: "agent", text: "SSH agent / Pageant" }));
  auth.value = s.auth;
  const keyPath = el("input", { value: s.keyPath ?? "", placeholder: "~/.ssh/id_ed25519 or a .ppk file", spellcheck: "false" });
  const browse = el("button", { class: "btn", type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const picked = await openFileDialog({ multiple: false, directory: false, title: "Choose a private key" });
    if (typeof picked === "string") keyPath.value = picked;
  });
  const keyField = field("Key file", el("div", { class: "inline" }, keyPath, browse), "OpenSSH or PuTTY (.ppk) format. You'll be asked for the passphrase if it has one. File → SSH keys can create one.");
  const syncKey = () => (keyField.hidden = auth.value !== "key");
  auth.addEventListener("change", syncKey);
  syncKey();
  const [autoRow, autoOpen] = checkbox("Open Tailscale sign-in links automatically", s.autoOpenTailscale);
  const [logRow, autoLog] = checkbox("Log this session to a file automatically", s.autoLog);
  const logHint = el("small", { class: "hint", text: "Logs hold everything the server prints, which can include secrets. Change the folder in Settings." });
  // A jump host can have its own jump host, as long as the route doesn't loop back here.
  const choices = jumpChoices(s, sessions);
  const jump = el(
    "select",
    {},
    el("option", { value: "", text: "None, connect directly" }),
    ...choices.map((x) => el("option", { value: x.id, text: `${x.name} (${x.username}@${x.host})` })),
  );
  jump.value = choices.some((x) => x.id === s.jumpSession) ? s.jumpSession! : "";
  const route = el("small", { class: "hint route" });
  const syncRoute = () => {
    const via = choices.find((x) => x.id === jump.value);
    const chain = via ? jumpChain(via, sessions) : null;
    route.textContent = via && chain?.ok ? `Route: ${routeText([...chain.hops, via], "this server")}` : "";
  };
  jump.addEventListener("change", syncRoute);
  syncRoute();
  const jumpField = field("Jump host", el("div", {}, jump, route), "Connect through another saved session first, like ssh -J. If it has its own jump host, GhostKey goes through that too. Each server's host key is checked.");
  const tunnels = savedTunnelsEditor(s.forwards);

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

  const env = el("select", {}, ...ENVIRONMENTS.map((e) => el("option", { value: e.value, text: e.label })));
  env.value = s.environment ?? "";
  const tags = el("input", { value: s.tags.map((t) => `#${t}`).join(" "), placeholder: "#web #client-a", spellcheck: "false" });
  const tmux = el("input", { value: s.tmux ?? "", placeholder: "e.g. work (empty for a plain shell)", spellcheck: "false" });

  const read = (): SavedSession => ({
    ...s,
    environment: env.value as Environment,
    tags: parseTags(tags.value),
    tmux: tmux.value.trim(),
    name: name.value.trim(),
    folder: folder.value.trim().replace(/^\/+|\/+$/g, ""),
    host: host.value.trim(),
    port: Number(port.value),
    username: user.value.trim(),
    auth: auth.value as SavedSession["auth"],
    keyPath: auth.value === "key" ? keyPath.value.trim() || null : null,
    autoOpenTailscale: autoOpen.checked,
    autoLog: autoLog.checked,
    forwards: tunnels.read(),
    jumpSession: jump.value || null,
  });

  const choice = await showModal<"cancel" | "save" | "connect">({
    title: isNew ? "New session" : "Edit session",
    body: [
      folderList,
      el("div", { class: "grid" }, field("Name", name), field("Folder", folder)),
      el("div", { class: "grid host-row" }, field("Host", host), field("Port", port)),
      el("div", { class: "grid" }, field("Username", user), field("Login with", auth)),
      el(
        "div",
        { class: "grid" },
        field("Environment", env, "Production gets a badge everywhere and a warning before snippets, pastes and broadcast."),
        field("Tags", tags, "Separate with spaces or commas. Search with #tag."),
      ),
      keyField,
      jumpField,
      field("tmux session", tmux, "Attach to this tmux session on the server when connecting, creating it if needed, so programs keep running if the connection drops. Uses a plain shell if tmux isn't installed. GhostKey never closes tmux sessions."),
      autoRow,
      logRow,
      logHint,
      tunnels.el,
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
      return tmuxNameProblem(v.tmux);
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
  const port = m[3] ? Number(m[3]) : prefs.defaultPort;
  if (port < 1 || port > 65535) return null;
  return { user: m[1] ?? prefs.defaultUser, host: m[2].replace(/^\[|\]$/g, ""), port };
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
    { sessionId: null, host: parsed.host, port: parsed.port, username: parsed.user, auth: "password", keyPath: null, autoOpenTailscale: false, log: false, label: title, forwards: [], jumps: [], tmux: null },
    title,
  );
});
$("quick-input").addEventListener("input", (e) => (e.target as HTMLElement).classList.remove("invalid"));

// ---------------------------------------------------------------- workspaces and profiles

/** What a pane points at, for saving it in a workspace. */
function describePane(pane: Pane): { session: string | null; label: string } {
  const req = pane.conn.request;
  const saved = req?.sessionId ? sessions.find((s) => s.id === req.sessionId) : undefined;
  return { session: saved?.id ?? null, label: saved?.name ?? (req ? pane.conn.title : "") };
}

async function loadWorkspaces(): Promise<Workspace[]> {
  const raw = await api.listWorkspaces();
  return raw.map((w) => cleanWorkspace(w)).filter((w): w is Workspace => w !== null);
}

async function saveWorkspaceDialog() {
  let existing: Workspace[] = [];
  try {
    existing = await loadWorkspaces();
  } catch (e) {
    await confirm("Couldn't read workspaces", String(e), "OK");
    return;
  }
  const saved = tabs.map((t) => capture(t.root, describePane));
  const paneCount = saved.reduce((n, t) => n + leaves(t).length, 0);
  const unsaved = saved.flatMap(leaves).filter((l) => l.session === null && l.label).length;
  const name = el("input", { value: "", placeholder: "e.g. Client A lab", spellcheck: "false" });
  const ok = await showModal<boolean>({
    title: "Save workspace",
    body: [
      el("p", { text: `Saves ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"} and ${paneCount} ${paneCount === 1 ? "pane" : "panes"}, with the saved session each pane uses.` }),
      field("Name", name, "Saving under an existing name replaces that workspace."),
      ...(unsaved ? [el("p", { class: "hint", text: `${unsaved} ${unsaved === 1 ? "pane uses" : "panes use"} Quick connect, not a saved session, so ${unsaved === 1 ? "it opens" : "they open"} empty.` })] : []),
      el("p", { class: "hint", text: "A workspace holds no passwords, and opening one connects nothing until you choose." }),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save", value: () => true, primary: true },
    ],
    validate: () => (name.value.trim() ? null : "Give the workspace a name."),
    onDismiss: () => false,
  }).result;
  if (!ok) return;
  const same = existing.find((w) => w.name.toLowerCase() === name.value.trim().toLowerCase());
  try {
    await api.saveWorkspace({ id: same?.id ?? crypto.randomUUID(), name: name.value.trim(), tabs: saved });
  } catch (e) {
    await confirm("Couldn't save the workspace", String(e), "OK");
  }
}

async function openWorkspaceDialog() {
  let list: Workspace[];
  try {
    list = await loadWorkspaces();
  } catch (e) {
    await confirm("Couldn't read workspaces", String(e), "OK");
    return;
  }
  if (!list.length) {
    await confirm("Open workspace", "No saved workspaces yet. Arrange tabs and splits, then use File → Save workspace….", "OK");
    return;
  }
  const ids = new Set(sessions.map((s) => s.id));
  const picker = el("select", { "aria-label": "Workspace" }, ...list.map((w) => el("option", { value: w.id, text: w.name })));
  const detail = el("div", { class: "ws-preview" });
  let boxes: { leaf: { session: string | null; label: string }; box: HTMLInputElement }[] = [];
  const chosen = () => list.find((w) => w.id === picker.value) ?? list[0];
  const render = () => {
    detail.replaceChildren();
    boxes = [];
    for (const tab of preview(chosen(), ids)) {
      const rows = tab.panes.map((p) => {
        const s = p.session ? sessions.find((x) => x.id === p.session) : undefined;
        const text = s ? `${envBadge(s.environment) ? `${envBadge(s.environment)} ` : ""}${s.name}  ${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}` : p.missing ? `${p.label || "A session"} (no longer saved)` : "Empty pane";
        const [row, box] = checkbox(text, !!s && !isProduction(s.environment));
        box.disabled = !s;
        if (p.missing) row.classList.add("missing");
        boxes.push({ leaf: p, box });
        return row;
      });
      detail.append(el("div", { class: "ws-tab" }, el("strong", { text: `Tab ${tab.tab}` }), ...rows));
    }
  };
  picker.addEventListener("change", render);
  render();
  const choice = await showModal<"cancel" | "open" | "connect" | "delete">({
    title: "Open workspace",
    wide: true,
    body: [
      field("Workspace", picker),
      el("p", { class: "hint", text: "Opens in new tabs. Tick the panes to connect now; the rest wait with a Connect button. Production sessions start unticked." }),
      detail,
    ],
    buttons: [
      { label: "Delete", value: () => "delete" },
      { label: "Cancel", value: () => "cancel" },
      { label: "Open", value: () => "open" },
      { label: "Open and connect ticked", value: () => "connect", primary: true },
    ],
    onDismiss: () => "cancel",
  }).result;
  const w = chosen();
  if (choice === "cancel") return;
  if (choice === "delete") {
    if (await confirm("Delete workspace", `Delete the workspace "${w.name}"? Its sessions stay saved.`, "Delete", true)) {
      await api.deleteWorkspace(w.id).catch((e) => confirm("Couldn't delete the workspace", String(e), "OK"));
    }
    return;
  }
  const connectNow = new Set(choice === "connect" ? boxes.filter((b) => b.box.checked).map((b) => b.leaf) : []);
  const queue = [...boxes.map((b) => b.leaf)];
  const toConnect: Pane[] = [];
  for (const saved of w.tabs) {
    const root = restore(saved, () => {
      const leafInfo = queue.shift();
      const pane = new Pane(host);
      const s = leafInfo?.session ? sessions.find((x) => x.id === leafInfo.session) : undefined;
      const req = s ? requestFor(s) : null;
      if (s && req) {
        pane.conn.prepare(req, s.name);
        pane.waiting(s.name);
        if (leafInfo && connectNow.has(leafInfo)) toConnect.push(pane);
      } else {
        pane.welcome();
      }
      return pane;
    });
    const first = panes(root)[0];
    const tab: Tab = { root, active: first, el: el("div", { class: "tab-body", hidden: true }) };
    $("workspace").append(tab.el);
    tabs.push(tab);
    renderLayout(tab);
    selectTab(tab);
  }
  // Connect after layout, so each terminal knows its size.
  requestAnimationFrame(() => toConnect.forEach((p) => p.conn.retry()));
}

async function exportProfile() {
  let data: { sessions: SavedSession[]; snippets: Snippet[]; workspaces: Workspace[] };
  try {
    data = { sessions: await api.listSessions(), snippets: await api.listSnippets(), workspaces: await loadWorkspaces() };
  } catch (e) {
    await confirm("Couldn't read your settings", String(e), "OK");
    return;
  }
  const ok = await confirm(
    "Export profile",
    `Saves ${data.sessions.length} sessions, ${data.snippets.length} snippets and ${data.workspaces.length} workspaces to one file you can import on another computer.\n\nPasswords and passphrases are never exported. Host names, usernames and snippet commands are, so keep the file somewhere private.`,
    "Choose where to save…",
  );
  if (!ok) return;
  const path = await saveFileDialog({ title: "Export GhostKey profile", defaultPath: "ghostkey-profile.json", filters: [{ name: "GhostKey profile", extensions: ["json"] }] });
  if (!path) return;
  let home = "";
  try {
    home = await homeDir();
  } catch {
    // Without a home folder, key paths are written as they are.
  }
  try {
    await api.writeTextFile(path, JSON.stringify(buildProfile(data, home), null, 2));
    await confirm("Profile exported", `Saved to ${path}.`, "OK");
  } catch (e) {
    await confirm("Couldn't export the profile", String(e), "OK");
  }
}

async function importProfile() {
  const path = await openFileDialog({ multiple: false, directory: false, title: "Import GhostKey profile", filters: [{ name: "GhostKey profile", extensions: ["json"] }] });
  if (typeof path !== "string") return;
  let parsed: ParseResult;
  let mine: { sessions: SavedSession[]; snippets: Snippet[]; workspaces: Workspace[] };
  try {
    parsed = parseProfile(await api.readTextFile(path));
    mine = { sessions: await api.listSessions(), snippets: await api.listSnippets(), workspaces: await loadWorkspaces() };
  } catch (e) {
    await confirm("Couldn't read the profile", String(e), "OK");
    return;
  }
  if (!parsed.ok) {
    await confirm("Couldn't import the profile", parsed.error, "OK");
    return;
  }
  const p = parsed.profile;
  const count = <T extends { id: string }>(items: T[], existing: T[]) => {
    const states = items.map((x) => compare(x, existing));
    return { items, states, new: states.filter((s) => s === "new").length, changed: states.filter((s) => s === "changed").length, same: states.filter((s) => s === "same").length };
  };
  const parts = [
    { label: "Sessions", ...count(p.sessions, mine.sessions), save: (x: SavedSession) => api.saveSession(x) },
    { label: "Snippets", ...count(p.snippets, mine.snippets), save: (x: Snippet) => api.saveSnippet(x) },
    { label: "Workspaces", ...count(p.workspaces, mine.workspaces), save: (x: Workspace) => api.saveWorkspace(x) },
  ] as const;
  const anyChanged = parts.some((x) => x.changed > 0);
  const [replaceRow, replace] = checkbox("Replace my changed items with the imported ones");
  replaceRow.hidden = !anyChanged;
  const table = el(
    "div",
    { class: "profile-summary" },
    ...parts.map((x) => el("div", { class: "profile-row" }, el("strong", { text: x.label }), el("span", { text: `${x.new} new · ${x.changed} different from yours · ${x.same} already the same` }))),
  );
  const missingKeys = p.sessions.filter((s) => s.auth === "key").length;
  const ok = await showModal<boolean>({
    title: "Import profile",
    wide: true,
    body: [
      el("p", { text: p.exportedAt ? `Exported ${new Date(p.exportedAt).toLocaleString()}.` : "Exported at an unknown time." }),
      table,
      replaceRow,
      ...(parsed.skipped.length ? [el("p", { class: "hint", text: `Skipped because they're damaged: ${parsed.skipped.join("; ")}` })] : []),
      ...(missingKeys ? [el("p", { class: "hint", text: "Key files aren't in the profile. Copy them to the same place on this computer (paths under your home folder are written as ~/…)." })] : []),
      el("p", { class: "hint", text: "Nothing you have is deleted. Passwords aren't in the file, so GhostKey asks for them on first connect." }),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Import", value: () => true, primary: true },
    ],
    onDismiss: () => false,
  }).result;
  if (!ok) return;
  const failed: string[] = [];
  let done = 0;
  for (const part of parts) {
    for (let i = 0; i < part.items.length; i++) {
      const state = part.states[i];
      if (state === "same" || (state === "changed" && !replace.checked)) continue;
      const item = part.items[i];
      try {
        await (part.save as (x: typeof item) => Promise<void>)(item);
        done++;
      } catch (e) {
        failed.push(`${(item as { name: string }).name}: ${e}`);
      }
    }
  }
  await refreshSessions();
  await refreshSnippets();
  await confirm(failed.length ? "Profile partly imported" : "Profile imported", `${done} ${done === 1 ? "item" : "items"} added or updated.${failed.length ? `\n\nNot imported:\n${failed.join("\n")}` : ""}`, "OK");
}

// ---------------------------------------------------------------- evidence bookmarks

const MAX_EXCERPT = 256 * 1024;

/** Saves the active pane's selection with a note and where it came from. */
async function bookmarkSelection() {
  const pane = activePane();
  const text = pane.selectedText();
  if (!text) {
    await confirm("Bookmark selection", "Select some text in the terminal first, then bookmark it.", "OK");
    return;
  }
  const req = pane.conn.request;
  const saved = savedFor(pane);
  const source = {
    name: saved?.name ?? (req ? pane.conn.title : "Not connected"),
    username: req?.username ?? "",
    host: req?.host ?? "",
    port: req?.port ?? 22,
    sessionId: saved?.id ?? null,
    environment: saved?.environment ?? "",
  };
  const createdAt = new Date().toISOString();
  const tooLong = new TextEncoder().encode(text).length > MAX_EXCERPT;
  const note = el("textarea", { rows: "3", placeholder: "What this shows", spellcheck: "true" });
  const ok = await showModal<boolean>({
    title: "Bookmark selection",
    wide: true,
    body: [
      el("p", { class: "hint", text: `${source.name}${req ? ` (${source.username}@${source.host})` : ""} · ${new Date(createdAt).toLocaleString()}` }),
      el("pre", { class: "bookmark-excerpt", text }),
      field("Note", note),
      el("p", { class: "hint", text: "The excerpt is saved exactly as selected, even after it scrolls out of the terminal. It can include secrets that were on screen; you can make a redacted copy for export in Edit → Bookmarks." }),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save bookmark", value: () => true, primary: true },
    ],
    validate: () => (tooLong ? "The selection is too long to bookmark (at most 256 KB)." : null),
    onDismiss: () => false,
  }).result;
  if (ok) {
    try {
      await api.saveBookmark({ id: crypto.randomUUID(), createdAt, source, note: note.value, original: text, redacted: null });
    } catch (e) {
      await confirm("Couldn't save the bookmark", String(e), "OK");
    }
  }
  pane.focus();
}

/** Edits a bookmark's note and redacted copy. The original stays as it was. */
async function editBookmark(b: Bookmark): Promise<boolean> {
  const note = el("textarea", { rows: "3", spellcheck: "true" });
  note.value = b.note;
  const redacted = el("textarea", { rows: "8", class: "bookmark-redacted", spellcheck: "false" });
  redacted.value = b.redacted ?? b.original;
  const suggest = el("button", { class: "btn", type: "button", text: "Suggest redactions" });
  suggest.addEventListener("click", () => (redacted.value = suggestRedaction(redacted.value)));
  const ok = await showModal<boolean>({
    title: "Edit bookmark",
    wide: true,
    body: [
      field("Note", note),
      el("p", { class: "hint", text: "Original (kept unchanged):" }),
      el("pre", { class: "bookmark-excerpt", text: b.original }),
      field("Redacted copy, used when you export redacted", redacted, "Edit it by hand. Suggestions hide values after words like password or token, bearer tokens and private keys; check what's left."),
      el("div", {}, suggest),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Save", value: () => true, primary: true },
    ],
    onDismiss: () => false,
  }).result;
  if (!ok) return false;
  const copy = redacted.value === b.original ? null : redacted.value;
  try {
    await api.saveBookmark({ ...b, note: note.value, redacted: copy });
    return true;
  } catch (e) {
    await confirm("Couldn't save the bookmark", String(e), "OK");
    return false;
  }
}

async function openBookmarks() {
  let list: Bookmark[];
  try {
    list = await api.listBookmarks();
  } catch (e) {
    await confirm("Couldn't read bookmarks", String(e), "OK");
    return;
  }
  if (!list.length) {
    await confirm("Bookmarks", "No bookmarks yet. Select text in a terminal and press Ctrl+Shift+M (or Edit → Bookmark selection…).", "OK");
    return;
  }
  const chosen = new Set(list.map((b) => b.id));
  const box = el("div", { class: "bookmark-list" });
  const render = () => {
    box.replaceChildren();
    for (const b of [...list].reverse()) {
      const [pickRow, pick] = checkbox(`${b.source.name} · ${new Date(b.createdAt).toLocaleString()}${b.redacted !== null ? " · redacted copy made" : ""}`, chosen.has(b.id));
      pick.addEventListener("change", () => (pick.checked ? chosen.add(b.id) : chosen.delete(b.id)));
      const edit = el("button", { class: "btn", type: "button", text: "Edit…" });
      const del = el("button", { class: "btn danger", type: "button", text: "Delete" });
      edit.addEventListener("click", async () => {
        if (await editBookmark(b)) {
          list = await api.listBookmarks().catch(() => list);
          render();
        }
      });
      del.addEventListener("click", async () => {
        if (!(await confirm("Delete bookmark", "Delete this bookmark? Its excerpt and note can't be recovered.", "Delete", true))) return;
        await api.deleteBookmark(b.id).catch((e) => confirm("Couldn't delete the bookmark", String(e), "OK"));
        list = list.filter((x) => x.id !== b.id);
        chosen.delete(b.id);
        render();
      });
      const preview = b.original.split("\n").slice(0, 3).join("\n");
      box.append(
        el(
          "div",
          { class: "bookmark-item" },
          el("div", { class: "bookmark-head" }, pickRow, el("span", { class: "bookmark-actions" }, edit, del)),
          ...(b.note.trim() ? [el("p", { class: "bookmark-note", text: b.note })] : []),
          el("pre", { class: "bookmark-excerpt short", text: preview }),
        ),
      );
    }
  };
  render();
  const format = select([{ label: "Markdown (.md)", value: "md" }, { label: "JSON (.json)", value: "json" }], "md");
  const [redRow, useRedacted] = checkbox("Use redacted copies where I made them", true);
  const choice = await showModal<"close" | "export">({
    title: "Bookmarks",
    wide: true,
    body: [
      box,
      el("div", { class: "grid" }, field("Export as", format), el("div", { class: "import-choose" }, redRow)),
      el("p", { class: "hint", text: `${NOT_FORENSIC} Bookmarks are kept in bookmarks.json in the app folder, readable only by you.` }),
    ],
    buttons: [
      { label: "Close", value: () => "close" },
      { label: "Export chosen…", value: () => "export", primary: true },
    ],
    validate: () => (chosen.size ? null : "Tick at least one bookmark to export."),
    onDismiss: () => "close",
  }).result;
  if (choice !== "export") return;
  const picked = list.filter((b) => chosen.has(b.id));
  const ext = format.value === "json" ? "json" : "md";
  const path = await saveFileDialog({ title: "Export bookmarks", defaultPath: `ghostkey-bookmarks.${ext}`, filters: [{ name: ext === "json" ? "JSON" : "Markdown", extensions: [ext] }] });
  if (!path) return;
  const opts = { redacted: useRedacted.checked };
  try {
    await api.writeTextFile(path, ext === "json" ? toJson(picked, opts) : toMarkdown(picked, opts));
    await confirm("Bookmarks exported", `${picked.length} ${picked.length === 1 ? "bookmark" : "bookmarks"} saved to ${path}.`, "OK");
  } catch (e) {
    await confirm("Couldn't export bookmarks", String(e), "OK");
  }
}

// ---------------------------------------------------------------- tmux

/** Lists the server's tmux sessions and opens the chosen one in a new tab. Never kills any. */
async function openTmux() {
  const pane = activePane();
  const id = pane.conn.id;
  const req = pane.conn.request;
  if (id == null || !req) return;
  let list;
  try {
    list = await api.listTmux(id);
  } catch (e) {
    await confirm("Couldn't list tmux sessions", String(e), "OK");
    return;
  }
  if (!list.installed) {
    await confirm("tmux sessions", `tmux isn't installed on ${pane.conn.title}, so there's nothing to attach to. Ordinary sessions still work.`, "OK");
    return;
  }
  let picked: string | null = null;
  const rows = list.sessions.map((s) => {
    const open = el("button", { class: "btn", type: "button", text: "Open in new tab" });
    open.addEventListener("click", () => {
      picked = s.name;
      close();
    });
    return el("div", { class: "tmux-row" }, el("div", {}, el("strong", { text: s.name }), el("small", { class: "hint", text: describeTmux(s) })), open);
  });
  const name = el("input", { placeholder: "new session name", spellcheck: "false", "aria-label": "New tmux session name" });
  const { result, close } = showModal<"cancel" | "new">({
    title: `tmux on ${pane.conn.title}`,
    wide: true,
    body: [
      rows.length ? el("div", { class: "tmux-list" }, ...rows) : el("p", { class: "empty", text: "No tmux sessions are running." }),
      field("Or start a new one", name, "Letters, digits, - and _. If it already exists, you attach to it."),
      el("p", { class: "hint", text: "Attaching to a session someone else is using shares it: they see what you type, and you see their screen. Closing the tab detaches; the session keeps running until it's ended on the server." }),
    ],
    buttons: [
      { label: "Close", value: () => "cancel" },
      { label: "Start new session", value: () => "new", primary: true },
    ],
    validate: () => (name.value.trim() ? tmuxNameProblem(name.value.trim()) : "Enter a name, or open a session from the list."),
    onDismiss: () => "cancel",
  });
  const choice = await result;
  const target = picked ?? (choice === "new" ? name.value.trim() : null);
  if (!target) return;
  const tab = newTab();
  tab.conn.connect({ ...req, log: false, forwards: [], tmux: target }, `${pane.conn.title} · tmux ${target}`);
}

// ---------------------------------------------------------------- menu bar

const REPO_URL = "https://github.com/Anon0ne/GhostKey";

function focusQuickConnect() {
  if (!prefs.showSidebar) setPrefs({ ...prefs, showSidebar: true });
  const input = $<HTMLInputElement>("quick-input");
  input.focus();
  input.select();
}

async function quit() {
  const live = tabs.flatMap((t) => panes(t.root)).filter((p) => p.conn.active);
  if (live.length) {
    const ok = await confirm("Quit GhostKey?", `${live.length === 1 ? "A session is" : `${live.length} sessions are`} still connected. Disconnect and quit?`, "Quit", true);
    if (!ok) return;
  }
  await getCurrentWindow().close();
}

async function showShortcuts() {
  const rows: [string, string][] = [
    ["Ctrl+Shift+T", "New tab"],
    ["Ctrl+Shift+W", "Close pane"],
    ["Ctrl+Shift+R / D", "Split right / down"],
    ["Alt+Arrow", "Move between panes"],
    ["Alt+1…9, Ctrl+PgUp/PgDn", "Switch tabs"],
    ["Ctrl+Shift+C / V", "Copy / paste (right-click also works)"],
    ["Ctrl+Shift+F", "Find in terminal"],
    ["Ctrl+Shift+S", "Snippets"],
    ["Ctrl+Shift+E", "Files (SFTP)"],
    ["Ctrl+Shift+L", "Start or stop the session log"],
    ["Ctrl+Shift+B", "Show or hide the session list"],
    ["Ctrl+Shift+I", "Broadcast input to several terminals, or stop"],
    ["Ctrl+Shift+M", "Bookmark the selected text as evidence"],
    ["Ctrl+= / - / 0", "Font size"],
    ["Ctrl+,", "Settings"],
    ["F10", "Open the menu bar (outside the terminal)"],
  ];
  await showModal<null>({
    title: "Keyboard shortcuts",
    body: [el("table", { class: "shortcut-table" }, ...rows.map(([k, v]) => el("tr", {}, el("th", { text: k }), el("td", { text: v }))))],
    buttons: [{ label: "Close", value: () => null, primary: true }],
    onDismiss: () => null,
  }).result;
}

async function showAbout() {
  const version = await getVersion().catch(() => "");
  const link = el("button", { class: "link-btn", type: "button", text: REPO_URL });
  link.addEventListener("click", () => void api.openLink(REPO_URL).catch(() => {}));
  await showModal<null>({
    title: "About GhostKey",
    body: [
      el("p", { text: `GhostKey ${version}`.trim() }),
      el("p", { class: "hint", text: "An SSH client for Windows and Linux with the Kali QTerminal look." }),
      link,
    ],
    buttons: [{ label: "Close", value: () => null, primary: true }],
    onDismiss: () => null,
  }).result;
}

const conn = () => activePane().conn;
const menus: Menu[] = [
  {
    label: "File",
    items: [
      { label: "New tab", shortcut: "Ctrl+Shift+T", run: () => newTab() },
      { label: "New session…", run: () => editSession() },
      { label: "Quick connect", run: focusQuickConnect },
      { label: "Import sessions…", run: () => void importSessions() },
      { label: "SSH keys…", run: () => void openKeyManager() },
      "-",
      { label: "Open workspace…", run: () => void openWorkspaceDialog() },
      { label: "Save workspace…", run: () => void saveWorkspaceDialog() },
      { label: "Export profile…", run: () => void exportProfile() },
      { label: "Import profile…", run: () => void importProfile() },
      "-",
      { label: "Settings…", shortcut: "Ctrl+,", run: () => void openSettings() },
      "-",
      { label: "Close pane", shortcut: "Ctrl+Shift+W", run: () => void closePane(activePane()) },
      { label: "Close tab", run: () => void closeTab(current) },
      { label: "Quit", run: () => void quit() },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Copy", shortcut: "Ctrl+Shift+C", run: () => activePane().copy(), enabled: () => !!activePane().selectedText() },
      { label: "Paste", shortcut: "Ctrl+Shift+V", run: () => void activePane().paste(), enabled: () => conn().online },
      { label: "Select all", run: () => activePane().term.selectAll() },
      "-",
      { label: "Find…", shortcut: "Ctrl+Shift+F", run: () => activePane().openSearch() },
      { label: "Snippets…", shortcut: "Ctrl+Shift+S", run: () => openSnippets() },
      "-",
      { label: "Bookmark selection…", shortcut: "Ctrl+Shift+M", run: () => void bookmarkSelection(), enabled: () => !!activePane().selectedText() },
      { label: "Bookmarks…", run: () => void openBookmarks() },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Session list", shortcut: "Ctrl+Shift+B", checked: () => prefs.showSidebar, run: () => setPrefs({ ...prefs, showSidebar: !prefs.showSidebar }) },
      { label: "Snippet bar", checked: () => prefs.showSnippetBar, run: () => setPrefs({ ...prefs, showSnippetBar: !prefs.showSnippetBar }) },
      "-",
      { label: "Zoom in", shortcut: "Ctrl+=", run: () => setFontSize(prefs.fontSize + 1) },
      { label: "Zoom out", shortcut: "Ctrl+-", run: () => setFontSize(prefs.fontSize - 1) },
      { label: "Actual size", shortcut: "Ctrl+0", run: () => setFontSize(DEFAULT_PREFS.fontSize) },
      "-",
      { label: "Split right", shortcut: "Ctrl+Shift+R", run: () => splitPane("row") },
      { label: "Split down", shortcut: "Ctrl+Shift+D", run: () => splitPane("column") },
      { label: "Move pane to new tab", run: () => movePane(activePane(), null), enabled: () => panes(current.root).length > 1 },
      { label: "Move pane to tab…", run: () => void chooseMoveTarget(), enabled: () => tabs.length > 1 },
      { label: "Next tab", shortcut: "Ctrl+PgDn", run: () => selectTab(tabs[(tabs.indexOf(current) + 1) % tabs.length]), enabled: () => tabs.length > 1 },
      { label: "Previous tab", shortcut: "Ctrl+PgUp", run: () => selectTab(tabs[(tabs.indexOf(current) - 1 + tabs.length) % tabs.length]), enabled: () => tabs.length > 1 },
    ],
  },
  {
    label: "Session",
    items: [
      { label: "Reconnect", run: () => conn().retry(), enabled: () => conn().canRetry },
      { label: "Disconnect", run: () => conn().disconnect(), enabled: () => conn().active },
      "-",
      { label: "Session log", shortcut: "Ctrl+Shift+L", checked: () => !!conn().logPath, run: () => conn().toggleLog(), enabled: () => conn().online },
      { label: "Files", shortcut: "Ctrl+Shift+E", checked: () => activePane().filesOpen, run: () => activePane().toggleFiles() },
      { label: "Tunnels…", run: () => void openTunnels(conn()), enabled: () => conn().online },
      { label: "Connection diagnostics…", run: () => void showDiagnostics() },
      { label: "tmux sessions…", run: () => void openTmux(), enabled: () => conn().online },
      "-",
      { label: "Broadcast input…", shortcut: "Ctrl+Shift+I", run: () => void chooseBroadcast() },
      { label: "Stop broadcasting", run: stopBroadcast, enabled: () => broadcast.on },
    ],
  },
  {
    label: "Help",
    items: [
      { label: "Keyboard shortcuts", run: () => void showShortcuts() },
      { label: "GhostKey on GitHub", run: () => void api.openLink(REPO_URL).catch(() => {}) },
      { label: "About GhostKey", run: () => void showAbout() },
    ],
  },
];
const menuBar = new MenuBar($("menubar"), menus);

// ---------------------------------------------------------------- broadcast input

/** Shows who broadcast reaches: a bar above the panes and an outline on each one. */
function renderBroadcast() {
  broadcast.prune();
  const members = broadcast.members();
  for (const tab of tabs) for (const p of panes(tab.root)) p.setBroadcast(members.includes(p));
  const bar = $("broadcast-bar");
  bar.hidden = members.length === 0;
  if (!members.length) return;
  const change = el("button", { class: "btn", type: "button", text: "Change…" });
  change.addEventListener("click", () => void chooseBroadcast());
  const stop = el("button", { class: "btn danger", type: "button", text: "Stop (Ctrl+Shift+I)" });
  stop.addEventListener("click", stopBroadcast);
  bar.replaceChildren(
    el("strong", { text: `Broadcasting to ${members.length} terminals:` }),
    members.some((p) => isProduction(paneEnv(p))) ? el("span", { class: "env-badge env-production", text: "⚠ Includes production" }) : "",
    el("span", { class: "broadcast-list", text: members.map((p) => paneLabel(p)).join(" · "), title: members.map((p) => paneLabel(p)).join("\n") }),
    el("span", { class: "spacer" }),
    change,
    stop,
  );
}

function stopBroadcast() {
  broadcast.stop();
  renderBroadcast();
}

/** Lets the user pick connected panes, from every tab, to type into at once. */
async function chooseBroadcast() {
  const live = tabs.flatMap((t) => panes(t.root)).filter((p) => p.conn.online);
  if (live.length < 2) {
    await confirm("Broadcast input", "Broadcast needs at least two connected terminals. Connect another session or split this one first.", "OK");
    return;
  }
  const already = broadcast.members();
  const inTab = panes(current.root);
  const rows = live.map((p) => {
    // Start from the current group, or from this tab's panes.
    const [row, box] = checkbox(paneLabel(p), already.length ? already.includes(p) : inTab.includes(p));
    return { p, box, row };
  });
  const [prodRow, prodOk] = checkbox("I mean to type into production systems");
  prodRow.classList.add("prod-warning");
  const syncProd = () => (prodRow.hidden = !rows.some((r) => r.box.checked && isProduction(paneEnv(r.p))));
  for (const r of rows) r.box.addEventListener("change", syncProd);
  syncProd();
  const ok = await showModal<boolean>({
    title: "Broadcast input",
    body: [
      el("p", { text: "What you type in any chosen terminal goes to all of them. Pastes and snippets show every destination first." }),
      el("div", { class: "broadcast-choices" }, ...rows.map((r) => r.row)),
      prodRow,
      el("p", { class: "hint", text: "A terminal that disconnects or reconnects leaves the group and has to be chosen again. Login prompts are never broadcast." }),
    ],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: "Broadcast", value: () => true, primary: true },
    ],
    validate: () => {
      const chosen = rows.filter((r) => r.box.checked);
      if (chosen.length < 2) return "Choose at least two terminals.";
      if (chosen.some((r) => isProduction(paneEnv(r.p))) && !prodOk.checked) return "Confirm that you mean to type into production.";
      return null;
    },
    onDismiss: () => false,
  }).result;
  if (!ok) return;
  broadcast.choose(rows.filter((r) => r.box.checked).map((r) => r.p));
  renderBroadcast();
  activePane().focus();
}

// ---------------------------------------------------------------- diagnostics

function stepRow(s: Step): HTMLElement {
  const mark = s.state === "ok" ? "✓" : s.state === "failed" ? "✗" : "…";
  return el(
    "li",
    { class: `diag-step ${s.state}` },
    el("span", { class: "diag-mark", text: mark, "aria-label": s.state }),
    el("span", { class: "diag-label", text: stageLabel(s) }),
    el("span", { class: "diag-detail", text: s.detail ?? "" }),
    el("span", { class: "diag-ms", text: s.ms === null ? "" : `${s.ms} ms` }),
  );
}

/** Shows how far the active pane's last connection got, and lets the user copy a report. */
async function showDiagnostics() {
  const pane = activePane();
  const trace = pane.conn.trace;
  if (trace.outcome === "none") {
    await confirm("Connection diagnostics", "This pane hasn't connected yet. Connect to a server, then open diagnostics to see each stage.", "OK");
    return;
  }
  const version = await getVersion().catch(() => "");
  const platform = navigator.userAgent.includes("Windows") ? "Windows" : navigator.userAgent.includes("Mac") ? "macOS" : "Linux";
  const [hostRow, includeHost] = checkbox("Include host names, user names and addresses");
  const preview = el("pre", { class: "diag-report" });
  const update = () => {
    preview.textContent = report(trace, { includeHost: includeHost.checked, version, platform });
  };
  includeHost.addEventListener("change", update);
  update();
  const copied = el("span", { class: "hint", role: "status" });
  const copy = el("button", { class: "btn", type: "button", text: "Copy diagnostics" });
  copy.addEventListener("click", () => {
    Promise.resolve(writeText(preview.textContent ?? ""))
      .then(() => (copied.textContent = "Copied."))
      .catch((e) => (copied.textContent = `Couldn't copy: ${e}`));
  });
  const outcome: Record<string, string> = {
    connecting: "Still connecting.",
    connected: "Connected.",
    failed: trace.summary ?? "The connection failed.",
    lost: "Connected, then the connection was lost.",
    closed: "The connection closed.",
  };
  const advice = trace.advice();
  await showModal<void>({
    title: "Connection diagnostics",
    wide: true,
    body: [
      el("p", { text: `${pane.conn.title}: ${outcome[trace.outcome] ?? ""}` }),
      el("ol", { class: "diag-steps" }, ...trace.steps.map(stepRow)),
      trace.error ? el("p", { class: "diag-error", text: trace.error }) : el("span"),
      advice ? el("p", { class: "diag-advice", text: advice }) : el("span"),
      el("h3", { text: "Report" }),
      el("p", { class: "hint", text: "Review it before you share it. Sign-in tokens and your local account name are always removed." }),
      hostRow,
      preview,
      el("div", { class: "diag-copy" }, copy, copied),
    ],
    buttons: [
      ...(pane.conn.canRetry ? [{ label: pane.conn.retryLabel, value: () => pane.conn.retry() }] : []),
      { label: "Close", value: () => undefined, primary: true },
    ],
    onDismiss: () => undefined,
  }).result;
}

// ---------------------------------------------------------------- network recovery

// After sleep or a network change, check every connection at once instead of
// waiting for keepalives to notice a dead link. A long gap between timer ticks
// means the computer was asleep.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 20_000) void api.probeConnections().catch(() => {});
  lastTick = now;
}, 5_000);
window.addEventListener("online", () => void api.probeConnections().catch(() => {}));

// ---------------------------------------------------------------- wiring

$("search").addEventListener("input", renderSessions);
$("new-session").addEventListener("click", () => editSession());
$("import-sessions").addEventListener("click", importSessions);
$("snippets-open").addEventListener("click", () => openSnippets());
$("settings").addEventListener("click", openSettings);
$("new-tab").addEventListener("click", () => newTab());
$("disconnect").addEventListener("click", () => activePane().conn.disconnect());
$("reconnect").addEventListener("click", () => activePane().conn.retry());
$("diagnostics").addEventListener("click", () => void showDiagnostics());
$("log-toggle").addEventListener("click", () => activePane().conn.toggleLog());
$("terminal-find").addEventListener("click", () => activePane().openSearch());
$("files-toggle").addEventListener("click", () => activePane().toggleFiles());
$("tunnels").addEventListener("click", () => void openTunnels(activePane().conn));
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
  setPrefs(prefs);
  newTab();
  await Promise.all([refreshSessions(), refreshSnippets()]);
}

start();
