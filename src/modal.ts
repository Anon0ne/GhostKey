/** Small DOM helpers for GhostKey's dialogs. All text goes in via textContent. */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export interface ModalButton<T> {
  label: string;
  value: () => T;
  primary?: boolean;
  danger?: boolean;
}

/**
 * Shows a modal and resolves with the value of the button pressed. Escape and
 * the backdrop resolve with `onDismiss()`. Enter presses the primary button.
 */
export function showModal<T>(opts: {
  title: string;
  body: Node[];
  buttons: ModalButton<T>[];
  onDismiss: () => T;
  validate?: () => string | null;
  /** A wider dialog, for lists. */
  wide?: boolean;
}): { result: Promise<T>; close: () => void } {
  const root = document.getElementById("modal-root")!;
  const error = el("p", { class: "modal-error", role: "alert" });
  const footer = el("div", { class: "modal-buttons" });
  const dialog = el(
    "div",
    { class: opts.wide ? "modal wide" : "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.title },
    el("h2", { text: opts.title }),
    ...opts.body,
    error,
    footer,
  );
  const backdrop = el("div", { class: "backdrop" }, dialog);

  let finish: (v: T) => void = () => {};
  const result = new Promise<T>((resolve) => {
    finish = (v: T) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
  });

  const press = (b: ModalButton<T>) => {
    if (b.primary && opts.validate) {
      const message = opts.validate();
      if (message) {
        error.textContent = message;
        return;
      }
    }
    finish(b.value());
  };

  for (const b of opts.buttons) {
    const cls = ["btn", b.primary ? "primary" : "", b.danger ? "danger" : ""].join(" ").trim();
    const button = el("button", { class: cls, type: "button", text: b.label });
    button.addEventListener("click", () => press(b));
    footer.append(button);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish(opts.onDismiss());
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      const primary = opts.buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        press(primary);
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) finish(opts.onDismiss());
  });

  root.append(backdrop);
  const first = dialog.querySelector<HTMLElement>("input, select, button.primary");
  first?.focus();
  return { result, close: () => finish(opts.onDismiss()) };
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return el("label", { class: "field" }, el("span", { text: label }), input, hint ? el("small", { text: hint }) : null);
}

export function checkbox(label: string, checked = false): [HTMLElement, HTMLInputElement] {
  const input = el("input", { type: "checkbox", checked });
  return [el("label", { class: "check" }, input, el("span", { text: label })), input];
}

/** A yes/no question. */
export function confirm(title: string, message: string, yes: string, danger = false): Promise<boolean> {
  return showModal<boolean>({
    title,
    body: [el("p", { text: message })],
    buttons: [
      { label: "Cancel", value: () => false },
      { label: yes, value: () => true, primary: true, danger },
    ],
    onDismiss: () => false,
  }).result;
}
