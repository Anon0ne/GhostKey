// The SSH keys window: the agent's keys, inspecting a key file, creating a
// key, and saving a key in OpenSSH format with a new passphrase. Private keys
// never reach this code; the Rust side reads and writes them.

import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, type AgentStatus, type KeyInfo, type KeyKind } from "./api";
import { el, field, showModal } from "./modal";

/** Why a new key's settings can't be used yet, or null. */
export function newKeyProblem(v: { path: string; passphrase: string; confirm: string }): string | null {
  if (!v.path.trim()) return "Choose where to save the key.";
  if (v.path.trim().endsWith(".pub")) return "Choose a name for the private key; GhostKey adds .pub for the public key.";
  if (v.passphrase !== v.confirm) return "The passphrases don't match.";
  return null;
}

/** One line about a key, e.g. "ssh-ed25519 256-bit, SHA256:…, me@laptop". */
export function keySummary(k: { algorithm: string; bits: number | null; fingerprint: string; comment: string }): string {
  const parts = [`${k.algorithm}${k.bits ? ` ${k.bits}-bit` : ""}`, k.fingerprint];
  if (k.comment) parts.push(k.comment);
  return parts.join(", ");
}

const KINDS: { value: KeyKind; label: string }[] = [
  { value: "ed25519", label: "Ed25519 (recommended)" },
  { value: "ecdsa256", label: "ECDSA P-256" },
  { value: "rsa4096", label: "RSA 4096 (for older servers)" },
];

function passwordInput(placeholder = ""): HTMLInputElement {
  return el("input", { type: "password", autocomplete: "new-password", placeholder });
}

async function pickKey(title: string): Promise<string | null> {
  const picked = await openFileDialog({ multiple: false, directory: false, title });
  return typeof picked === "string" ? picked : null;
}

function copyButton(text: () => string, label = "Copy public key"): HTMLButtonElement {
  const b = el("button", { class: "btn", type: "button", text: label });
  b.addEventListener("click", () => {
    Promise.resolve(writeText(text()))
      .then(() => {
        b.textContent = "Copied";
        setTimeout(() => (b.textContent = label), 1500);
      })
      .catch(() => (b.textContent = "Couldn't copy"));
  });
  return b;
}

function keyDetails(info: KeyInfo): HTMLElement {
  if (info.needsPassphrase) {
    return el("p", { class: "hint", text: `${info.format} key, encrypted. Enter its passphrase to see the fingerprint.` });
  }
  return el(
    "div",
    { class: "key-details" },
    el("p", { text: `${info.format}${info.encrypted ? ", protected by a passphrase" : ", no passphrase"}` }),
    el("p", { class: "key-line", text: keySummary(info) }),
    el("pre", { class: "key-public", text: info.publicLine }),
    copyButton(() => info.publicLine),
  );
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return el("section", { class: "key-section" }, el("h3", { text: title }), ...children);
}

function result(): HTMLElement {
  return el("div", { class: "key-result", role: "status" });
}

function fail(box: HTMLElement, e: unknown) {
  box.replaceChildren(el("p", { class: "modal-error", text: String(e) }));
}

function agentSection(): HTMLElement {
  const body = el("div");
  const render = (s: AgentStatus) => {
    if (!s.kind) {
      body.replaceChildren(el("p", { class: "hint", text: s.error ?? "No SSH agent found." }));
      return;
    }
    const list = s.keys.length
      ? el("ul", { class: "agent-keys" }, ...s.keys.map((k) => el("li", { text: `${keySummary(k)}${k.certificate ? " (certificate)" : ""}` })))
      : el("p", { class: "hint", text: "The agent holds no keys yet." });
    body.replaceChildren(
      el("p", { text: `Connected to ${s.kind}. Sessions set to "SSH agent / Pageant" log in with these keys.` }),
      list,
      s.error ? el("p", { class: "modal-error", text: s.error }) : el("span"),
    );
  };
  const refresh = () => {
    body.replaceChildren(el("p", { class: "hint", text: "Checking the agent…" }));
    api.agentStatus().then(render).catch((e) => fail(body, e));
  };
  const refreshBtn = el("button", { class: "btn", type: "button", text: "Refresh" });
  refreshBtn.addEventListener("click", refresh);

  const addBox = result();
  const add = el("button", { class: "btn", type: "button", text: "Add a key file…" });
  add.addEventListener("click", async () => {
    const path = await pickKey("Choose a private key to add to the agent");
    if (!path) return;
    let passphrase: string | null = null;
    const info = await api.keyInspect(path, null).catch((e) => (fail(addBox, e), null));
    if (!info) return;
    if (info.encrypted) {
      passphrase = await askPassphrase(path);
      if (passphrase === null) return;
    }
    try {
      await api.agentAdd(path, passphrase);
      addBox.replaceChildren(el("p", { text: "Added. The agent keeps it until it restarts." }));
      refresh();
    } catch (e) {
      fail(addBox, e);
    }
  });
  refresh();
  return section("SSH agent", body, el("div", { class: "inline" }, refreshBtn, add), addBox);
}

async function askPassphrase(path: string): Promise<string | null> {
  const input = passwordInput();
  input.autocomplete = "off";
  return showModal<string | null>({
    title: "Key passphrase",
    body: [el("p", { text: path }), field("Passphrase", input)],
    buttons: [
      { label: "Cancel", value: () => null },
      { label: "OK", value: () => input.value, primary: true },
    ],
    onDismiss: () => null,
  }).result;
}

function inspectSection(): HTMLElement {
  const path = el("input", { placeholder: "~/.ssh/id_ed25519, a .pub file or a .ppk file", spellcheck: "false" });
  const passphrase = passwordInput("Only needed for encrypted PuTTY and PEM keys");
  passphrase.autocomplete = "off";
  const out = result();
  const run = () => {
    if (!path.value.trim()) return;
    api
      .keyInspect(path.value.trim(), passphrase.value || null)
      .then((info) => out.replaceChildren(keyDetails(info)))
      .catch((e) => fail(out, e));
  };
  const browse = el("button", { class: "btn", type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const p = await pickKey("Choose a key file");
    if (p) {
      path.value = p;
      run();
    }
  });
  const show = el("button", { class: "btn", type: "button", text: "Show" });
  show.addEventListener("click", run);
  return section(
    "Inspect a key",
    field("Key file", el("div", { class: "inline" }, path, browse)),
    field("Passphrase", el("div", { class: "inline" }, passphrase, show)),
    out,
  );
}

function generateSection(): HTMLElement {
  const kind = el("select", {}, ...KINDS.map((k) => el("option", { value: k.value, text: k.label })));
  const path = el("input", { placeholder: "~/.ssh/id_ed25519_ghostkey", spellcheck: "false" });
  const browse = el("button", { class: "btn", type: "button", text: "Choose…" });
  browse.addEventListener("click", async () => {
    const p = await saveFileDialog({ title: "Save the new private key as" });
    if (p) path.value = p;
  });
  const comment = el("input", { placeholder: "e.g. justin@laptop", spellcheck: "false" });
  const pass = passwordInput("Recommended");
  const confirm = passwordInput();
  const out = result();
  const create = el("button", { class: "btn primary", type: "button", text: "Create key" });
  create.addEventListener("click", async () => {
    const problem = newKeyProblem({ path: path.value, passphrase: pass.value, confirm: confirm.value });
    if (problem) return fail(out, problem);
    create.disabled = true;
    out.replaceChildren(el("p", { class: "hint", text: "Creating the key…" }));
    try {
      const info = await api.keyGenerate(path.value.trim(), kind.value as KeyKind, comment.value.trim(), pass.value || null);
      pass.value = confirm.value = "";
      out.replaceChildren(
        el("p", { text: `Saved ${path.value.trim()} and ${path.value.trim()}.pub. Add the public key to the server's ~/.ssh/authorized_keys.` }),
        keyDetails(info),
      );
    } catch (e) {
      fail(out, e);
    } finally {
      create.disabled = false;
    }
  });
  return section(
    "Create a key",
    field("Type", kind),
    field("Save as", el("div", { class: "inline" }, path, browse), "An existing file is never replaced."),
    field("Comment", comment),
    field("Passphrase", pass),
    field("Repeat passphrase", confirm),
    create,
    out,
  );
}

function convertSection(): HTMLElement {
  const from = el("input", { placeholder: "A .ppk, PEM or OpenSSH private key", spellcheck: "false" });
  const browse = el("button", { class: "btn", type: "button", text: "Browse…" });
  browse.addEventListener("click", async () => {
    const p = await pickKey("Choose the key to convert");
    if (p) from.value = p;
  });
  const oldPass = passwordInput("Leave empty if it has none");
  oldPass.autocomplete = "off";
  const to = el("input", { placeholder: "Where to save the OpenSSH copy", spellcheck: "false" });
  const pickTo = el("button", { class: "btn", type: "button", text: "Choose…" });
  pickTo.addEventListener("click", async () => {
    const p = await saveFileDialog({ title: "Save the OpenSSH key as" });
    if (p) to.value = p;
  });
  const newPass = passwordInput("Leave empty for none");
  const confirm = passwordInput();
  const out = result();
  const go = el("button", { class: "btn", type: "button", text: "Save copy" });
  go.addEventListener("click", async () => {
    if (!from.value.trim()) return fail(out, "Choose the key to convert.");
    const problem = newKeyProblem({ path: to.value, passphrase: newPass.value, confirm: confirm.value });
    if (problem) return fail(out, problem);
    try {
      const info = await api.keyConvert(from.value.trim(), oldPass.value || null, to.value.trim(), newPass.value || null);
      oldPass.value = newPass.value = confirm.value = "";
      out.replaceChildren(el("p", { text: `Saved ${to.value.trim()}. The original file wasn't changed.` }), keyDetails(info));
    } catch (e) {
      fail(out, e);
    }
  });
  return section(
    "Convert or change a passphrase",
    el("p", { class: "hint", text: "Saves a copy in OpenSSH format, with a new passphrase or none. Use it to turn a PuTTY .ppk into a key OpenSSH tools accept, or to change a passphrase." }),
    field("Key", el("div", { class: "inline" }, from, browse)),
    field("Current passphrase", oldPass),
    field("Save copy as", el("div", { class: "inline" }, to, pickTo)),
    field("New passphrase", newPass),
    field("Repeat new passphrase", confirm),
    go,
    out,
  );
}

export async function openKeyManager() {
  await showModal<void>({
    title: "SSH keys",
    wide: true,
    body: [el("div", { class: "key-manager" }, agentSection(), inspectSection(), generateSection(), convertSection())],
    buttons: [{ label: "Close", value: () => undefined, primary: true }],
    onDismiss: () => undefined,
  }).result;
}
