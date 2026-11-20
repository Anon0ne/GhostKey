// The menu bar across the top of the window: File, Edit, View, Session, Help.

import { el } from "./modal";

export interface MenuItem {
  label: string;
  /** Shown on the right, e.g. "Ctrl+Shift+T". The app handles the key itself. */
  shortcut?: string;
  run: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
}

export type MenuEntry = MenuItem | "-";

export interface Menu {
  label: string;
  items: MenuEntry[];
}

/** The next item to highlight, skipping separators and disabled items. -1 when there is none. */
export function nextItem(entries: MenuEntry[], from: number, step: 1 | -1): number {
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    const e = entries[i];
    if (e !== "-" && (e.enabled?.() ?? true)) return i;
  }
  return -1;
}

export class MenuBar {
  private buttons: HTMLButtonElement[] = [];
  private dropdown: HTMLElement | null = null;
  private openIndex = -1;
  private rows: HTMLElement[] = [];
  private highlighted = -1;
  /** Where focus was before the menu took it, to give it back on close. */
  private returnFocus: HTMLElement | null = null;

  constructor(
    private root: HTMLElement,
    private menus: Menu[],
  ) {
    root.setAttribute("role", "menubar");
    menus.forEach((menu, i) => {
      const button = el("button", { class: "menu-title", type: "button", role: "menuitem", "aria-haspopup": "true", "aria-expanded": "false", text: menu.label });
      button.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (this.openIndex === i) this.close();
        else this.open(i, false);
      });
      button.addEventListener("mouseenter", () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i, false);
      });
      button.addEventListener("keydown", (e) => this.onKey(e));
      this.buttons.push(button);
      root.append(button);
    });
    document.addEventListener("mousedown", (e) => {
      if (this.openIndex >= 0 && !root.contains(e.target as Node) && !this.dropdown?.contains(e.target as Node)) this.close(false);
    });
    window.addEventListener("blur", () => this.close(false));
    window.addEventListener("resize", () => this.close(false));
  }

  get isOpen() {
    return this.openIndex >= 0;
  }

  /** Opens the first menu from the keyboard (F10). */
  focusFirst() {
    this.open(0, true);
  }

  open(index: number, fromKeyboard: boolean) {
    if (this.openIndex < 0) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && !this.root.contains(active) ? active : null;
    }
    this.dropdown?.remove();
    this.buttons.forEach((b, i) => {
      b.classList.toggle("open", i === index);
      b.setAttribute("aria-expanded", String(i === index));
    });
    this.openIndex = index;
    const menu = this.menus[index];
    const list = el("div", { class: "menu-dropdown", role: "menu", "aria-label": menu.label });
    this.rows = [];
    menu.items.forEach((entry, i) => {
      if (entry === "-") {
        list.append(el("div", { class: "menu-separator", role: "separator" }));
        this.rows.push(el("div"));
        return;
      }
      const enabled = entry.enabled?.() ?? true;
      const checked = entry.checked?.();
      const row = el(
        "button",
        {
          class: "menu-item",
          type: "button",
          role: checked === undefined ? "menuitem" : "menuitemcheckbox",
          "aria-checked": checked === undefined ? false : String(checked),
          disabled: !enabled,
          tabindex: "-1",
        },
        el("span", { class: "menu-check", text: checked ? "✓" : "" }),
        el("span", { class: "menu-label", text: entry.label }),
        el("span", { class: "menu-shortcut", text: entry.shortcut ?? "" }),
      );
      row.addEventListener("mouseenter", () => this.highlight(i));
      row.addEventListener("click", () => this.activate(i));
      row.addEventListener("keydown", (e) => this.onKey(e));
      this.rows.push(row);
      list.append(row);
    });
    const rect = this.buttons[index].getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom}px`;
    document.body.append(list);
    this.dropdown = list;
    this.highlighted = -1;
    if (fromKeyboard) this.highlight(nextItem(menu.items, -1, 1));
    else this.buttons[index].focus();
  }

  close(restore = true) {
    if (this.openIndex < 0) return;
    this.dropdown?.remove();
    this.dropdown = null;
    this.buttons.forEach((b) => {
      b.classList.remove("open");
      b.setAttribute("aria-expanded", "false");
    });
    this.openIndex = -1;
    this.highlighted = -1;
    const target = this.returnFocus;
    this.returnFocus = null;
    if (restore) target?.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private highlight(i: number) {
    this.highlighted = i;
    this.rows.forEach((r, k) => r.classList.toggle("highlighted", k === i));
    if (i >= 0) this.rows[i].focus();
  }

  private activate(i: number) {
    const entry = this.menus[this.openIndex]?.items[i];
    if (!entry || entry === "-" || !(entry.enabled?.() ?? true)) return;
    this.close();
    // Run after the menu closes and focus is back, so dialogs and panes get it.
    setTimeout(() => entry.run(), 0);
  }

  private onKey(e: KeyboardEvent) {
    if (this.openIndex < 0) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        const i = this.buttons.indexOf(e.target as HTMLButtonElement);
        if (i >= 0) {
          e.preventDefault();
          this.open(i, true);
        }
      }
      return;
    }
    const items = this.menus[this.openIndex].items;
    const n = this.menus.length;
    switch (e.key) {
      case "Escape":
        this.close();
        break;
      case "ArrowDown":
        this.highlight(nextItem(items, this.highlighted, 1));
        break;
      case "ArrowUp":
        this.highlight(nextItem(items, this.highlighted < 0 ? items.length : this.highlighted, -1));
        break;
      case "ArrowRight":
        this.open((this.openIndex + 1) % n, true);
        break;
      case "ArrowLeft":
        this.open((this.openIndex - 1 + n) % n, true);
        break;
      case "Enter":
      case " ":
        if (this.highlighted >= 0) this.activate(this.highlighted);
        break;
      case "Tab":
        this.close();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}
