// Tunnel dialogs: the form for one forward, the list saved with a session,
// and the live tunnels of a connection.

import { api } from "./api";
import type { Connection } from "./connection";
import { checkbox, el, field, showModal } from "./modal";
import { describe, forwardProblem, isLoopback, KIND_LABELS, newForward, parseSpec, type Forward, type ForwardKind } from "./tunnels";

/** A form for one forward. `read` returns the forward, or a problem to show. */
function forwardForm(): { el: HTMLElement; read: () => Forward | string; reset: () => void } {
  const spec = el("input", { placeholder: "-L 8080:db.internal:5432", spellcheck: "false", "aria-label": "OpenSSH-style forward" });
  const kind = el("select", {}, ...(Object.keys(KIND_LABELS) as ForwardKind[]).map((k) => el("option", { value: k, text: KIND_LABELS[k] })));
  const bindHost = el("input", { value: "127.0.0.1", spellcheck: "false" });
  const bindPort = el("input", { type: "number", min: "0", max: "65535", placeholder: "8080" });
  const destHost = el("input", { placeholder: "db.internal", spellcheck: "false" });
  const destPort = el("input", { type: "number", min: "1", max: "65535", placeholder: "5432" });
  const [exposeRow, expose] = checkbox("Let other computers on my network use this tunnel");
  const exposeHint = el("small", { class: "hint" });
  const destRow = el("div", { class: "grid host-row" }, field("Destination host", destHost), field("Port", destPort));
  const bindLabel = el("span", { text: "Listen on" });
  const sync = () => {
    const k = kind.value as ForwardKind;
    destRow.hidden = k === "dynamic";
    bindLabel.textContent = k === "remote" ? "Listen on the server at" : "Listen on this computer at";
    const open = !isLoopback(bindHost.value);
    exposeRow.hidden = !open || k === "remote";
    exposeHint.hidden = !open;
    exposeHint.textContent =
      k === "remote"
        ? "The server decides whether others can reach this port (its GatewayPorts setting)."
        : "Anyone who can reach this computer could use the tunnel to reach the destination.";
  };
  // Typing an OpenSSH spec fills in the fields.
  spec.addEventListener("input", () => {
    const f = parseSpec(spec.value);
    if (!f) return;
    kind.value = f.kind;
    bindHost.value = f.bindHost;
    bindPort.value = String(f.bindPort);
    destHost.value = f.destHost;
    destPort.value = f.destPort ? String(f.destPort) : "";
    sync();
  });
  kind.addEventListener("change", sync);
  bindHost.addEventListener("input", sync);
  sync();

  const node = el(
    "div",
    { class: "tunnel-form" },
    field("Type", kind),
    el("div", { class: "grid host-row" }, el("label", { class: "field" }, bindLabel, bindHost), field("Port", bindPort)),
    destRow,
    exposeRow,
    exposeHint,
    field("Or paste an OpenSSH option", spec, "-L [address:]port:host:hostport, -R …, or -D [address:]port"),
  );
  return {
    el: node,
    read: () => {
      const f: Forward = {
        ...newForward(kind.value as ForwardKind),
        bindHost: bindHost.value.trim(),
        bindPort: Number(bindPort.value || "NaN"),
        destHost: destHost.value.trim(),
        destPort: Number(destPort.value || "0"),
      };
      if (f.kind === "remote" && !bindPort.value) f.bindPort = 0;
      if (f.kind === "dynamic") {
        f.destHost = "";
        f.destPort = 0;
      }
      const problem = forwardProblem(f);
      if (problem) return problem;
      if (f.kind !== "remote" && !isLoopback(f.bindHost) && !expose.checked) {
        return `${f.bindHost} can be reached from other computers. Tick the box to allow that, or use 127.0.0.1.`;
      }
      return f;
    },
    reset: () => {
      spec.value = "";
      bindPort.value = "";
      destHost.value = "";
      destPort.value = "";
      expose.checked = false;
    },
  };
}

/** The tunnels saved with a session, for the session editor. */
export function savedTunnelsEditor(initial: Forward[]): { el: HTMLElement; read: () => Forward[] } {
  let forwards = initial.map((f) => ({ ...f }));
  const list = el("div", { class: "tunnel-list" });
  const form = forwardForm();
  form.el.hidden = true;
  const error = el("p", { class: "modal-error", role: "alert" });
  const add = el("button", { class: "btn", type: "button", text: "Add tunnel" });
  const render = () => {
    list.replaceChildren();
    if (forwards.length === 0) list.append(el("p", { class: "hint", text: "No tunnels. Add one to forward ports whenever this session connects." }));
    for (const f of forwards) {
      const [autoRow, auto] = checkbox("Start on connect", f.autoStart);
      auto.addEventListener("change", () => (f.autoStart = auto.checked));
      const remove = el("button", { class: "icon-btn", type: "button", text: "×", title: "Remove", "aria-label": `Remove ${describe(f)}` });
      remove.addEventListener("click", () => {
        forwards = forwards.filter((x) => x !== f);
        render();
      });
      list.append(el("div", { class: "tunnel-row" }, el("code", { text: describe(f) }), autoRow, remove));
    }
  };
  add.addEventListener("click", () => {
    if (form.el.hidden) {
      form.el.hidden = false;
      add.textContent = "Add this tunnel";
      return;
    }
    const f = form.read();
    if (typeof f === "string") {
      error.textContent = f;
      return;
    }
    error.textContent = "";
    forwards.push(f);
    form.reset();
    form.el.hidden = true;
    add.textContent = "Add tunnel";
    render();
  });
  render();
  return {
    el: el("fieldset", { class: "tunnels-editor" }, el("legend", { text: "Tunnels" }), list, form.el, error, add),
    read: () => forwards,
  };
}

let refreshOpen: (() => void) | null = null;

/** Called when any connection changes, so an open tunnels dialog stays current. */
export function tunnelsChanged() {
  refreshOpen?.();
}

/** The live tunnels of a connection, with stop and retry, and a form for a temporary one. */
export async function openTunnels(conn: Connection) {
  const list = el("div", { class: "tunnel-list" });
  const form = forwardForm();
  const error = el("p", { class: "modal-error", role: "alert" });
  const add = el("button", { class: "btn primary", type: "button", text: "Start tunnel" });
  const id = conn.id;
  const render = () => {
    list.replaceChildren();
    if (!conn.online || conn.id !== id) {
      list.append(el("p", { class: "hint", text: "This session is no longer connected." }));
      add.disabled = true;
      return;
    }
    const running = new Set(conn.tunnels.map((t) => t.forward.id));
    const idle = (conn.request?.forwards ?? []).filter((f) => !running.has(f.id));
    if (conn.tunnels.length === 0 && idle.length === 0) list.append(el("p", { class: "hint", text: "No tunnels yet." }));
    for (const t of conn.tunnels) {
      const state =
        t.state === "listening"
          ? `Listening on ${t.bound}${t.connections ? `, ${t.connections} open` : ""}`
          : t.state === "starting"
            ? "Starting…"
            : "Failed";
      const stop = el("button", { class: "btn", type: "button", text: "Stop" });
      stop.addEventListener("click", () => void api.stopForward(id!, t.forward.id));
      const buttons = [stop];
      if (t.state === "failed") {
        const retry = el("button", { class: "btn", type: "button", text: "Retry" });
        retry.addEventListener("click", () => void api.startForward(id!, t.forward));
        buttons.unshift(retry);
      }
      list.append(
        el(
          "div",
          { class: `tunnel-row ${t.state}` },
          el("div", { class: "tunnel-main" }, el("code", { text: describe(t.forward) }), el("span", { class: "tunnel-state", text: state }), t.error ? el("span", { class: "tunnel-error", text: t.error }) : null),
          ...buttons,
        ),
      );
    }
    for (const f of idle) {
      const start = el("button", { class: "btn", type: "button", text: "Start" });
      start.addEventListener("click", () => void api.startForward(id!, f));
      list.append(el("div", { class: "tunnel-row" }, el("div", { class: "tunnel-main" }, el("code", { text: describe(f) }), el("span", { class: "tunnel-state", text: "Stopped" })), start));
    }
  };
  add.addEventListener("click", () => {
    const f = form.read();
    if (typeof f === "string") {
      error.textContent = f;
      return;
    }
    error.textContent = "";
    if (id != null && conn.id === id) void api.startForward(id, f);
    form.reset();
  });
  render();
  refreshOpen = render;
  await showModal<null>({
    title: `Tunnels — ${conn.title}`,
    wide: true,
    body: [
      list,
      el("h3", { text: "New tunnel for this connection" }),
      el("p", { class: "hint", text: "It lasts until you disconnect. To keep a tunnel, add it in the session's settings." }),
      form.el,
      error,
      add,
    ],
    // Not primary, so Enter in the form never closes the dialog.
    buttons: [{ label: "Close", value: () => null }],
    onDismiss: () => null,
  }).result;
  refreshOpen = null;
}
