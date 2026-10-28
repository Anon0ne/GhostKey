import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

const policy = load('paste.ts');

test('paste policy detects line endings and invisible terminal controls', () => {
  for (const text of ['a\nb', 'a\r', 'a\r\nb', '\x1b[201~', '\0', '\x7f', '\x85', '\u2028']) {
    assert.equal(policy.needsPastePreview(text), true, JSON.stringify(text));
  }
  assert.equal(policy.needsPastePreview('echo hello'), false);
  assert.equal(policy.pasteLineCount('a\r\nb\rc\n'), 4);
  assert.equal(policy.pastePreview('echo a\r\n\x1b[31m'), 'echo a\\u000d\n\\u001b[31m');
});

function node(tag, props = {}, ...children) {
  return {
    tag, ...props, children, value: '', handlers: {}, offsetWidth: 500, offsetHeight: 300,
    append(...items) { this.children.push(...items); },
    addEventListener(name, fn, capture) { this.handlers[name] = { fn, capture }; },
    fire(name, extra = {}) {
      const e = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
      return this.handlers[name]?.fn(e);
    },
    focus() {}, select() {}, remove() {},
  };
}

function harness() {
  const modals = [], terminals = [], searches = [];
  let clipboard = 'echo one\necho two';
  class Terminal {
    options = {}; focusCalls = 0; cols = 80; rows = 24; pasted = []; textarea = node('textarea');
    constructor() { terminals.push(this); }
    loadAddon() {} open() {} onData(fn) { this.data = fn; } onResize() {}
    attachCustomKeyEventHandler(fn) { this.key = fn; }
    paste(text) { this.pasted.push(text); }
    hasSelection() { return false; } focus() { this.focusCalls++; } reset() {} dispose() {} clearSelection() {}
  }
  class Connection {
    request = { host: 'example', username: 'alice', port: 22 }; id = 1; online = true; title = 'Lab';
    disconnect() { this.online = false; } input() {} resize() {}
  }
  class SearchAddon {
    calls = [];
    constructor() { searches.push(this); }
    findNext(text, options) { this.calls.push(['next', text, options]); return text === 'match'; }
    findPrevious(text) { this.calls.push(['previous', text]); return true; }
    clearDecorations() { this.calls.push(['clear']); }
  }
  const { Pane } = load('pane.ts', {
    '@xterm/xterm': { Terminal },
    '@xterm/addon-fit': { FitAddon: class { fit() {} } },
    '@xterm/addon-web-links': { WebLinksAddon: class {} },
    '@xterm/addon-search': { SearchAddon },
    '@tauri-apps/plugin-clipboard-manager': { readText: async () => clipboard, writeText() {} },
    './connection': { Connection }, './paste': policy,
    './modal': { el: node, showModal(opts) {
      let finish;
      const result = new Promise((resolve) => { finish = resolve; });
      const modal = { opts, result, close: () => finish(false), approve: () => finish(true) };
      modals.push(modal);
      return modal;
    } },
    './theme': {}, './api': { api: {} },
  });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const closed = [];
  const host = { close: (pane) => closed.push(pane), fontSize: () => 14, activate() {}, changed() {}, shortcut: () => false };
  return { pane: new Pane(host), another: () => new Pane(host), modals, terminals, searches, closed,
    clipboard: (text) => { clipboard = text; } };
}

test('paste cancellation and double invocation send no terminal bytes', async () => {
  const h = harness();
  const pending = h.pane.pasteText('a\nb');
  await h.pane.pasteText('second\n');
  assert.equal(h.modals.length, 1);
  assert.equal(h.modals[0].opts.buttons[0].label, 'Cancel');
  assert.equal(h.modals[0].opts.buttons[0].primary, true);
  h.modals[0].close();
  await pending;
  assert.deepEqual(h.terminals[0].pasted, []);
});

test('approval sends original bytes only to the originating pane', async () => {
  const h = harness();
  h.another();
  const text = 'echo a\r\necho b\n';
  const pending = h.pane.pasteText(text);
  assert.match(h.modals[0].opts.body[0].text, /alice@example:22/);
  h.modals[0].approve();
  await pending;
  assert.deepEqual(h.terminals[0].pasted, [text]);
  assert.deepEqual(h.terminals[1].pasted, []);
});

test('reconnect invalidates paste approval even if the native ID is reused', async () => {
  const h = harness();
  const pending = h.pane.pasteText('a\nb');
  h.pane.conn.request = { ...h.pane.conn.request };
  h.modals[0].approve();
  await pending;
  assert.deepEqual(h.terminals[0].pasted, []);
});

test('closing a pane cancels an open preview', async () => {
  const h = harness();
  const pending = h.pane.pasteText('a\nb');
  h.pane.dispose();
  await pending;
  assert.deepEqual(h.terminals[0].pasted, []);
});

test('native paste is captured before xterm and uses the same preview', async () => {
  const h = harness();
  const terminal = h.pane.el.children.at(-1).children[0];
  assert.equal(terminal.handlers.paste.capture, true);
  let prevented = false, stopped = false;
  terminal.fire('paste', {
    clipboardData: { getData: () => 'one\ntwo' },
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(prevented && stopped, true);
  assert.equal(h.modals.length, 1);
  h.modals[0].close();
});

test('single-line clipboard paste is immediate and offline paste is ignored', async () => {
  const h = harness();
  h.clipboard('hello');
  await h.pane.paste();
  assert.deepEqual(h.terminals[0].pasted, ['hello']);
  assert.equal(h.modals.length, 0);
  h.pane.conn.online = false;
  await h.pane.pasteText('discarded');
  assert.deepEqual(h.terminals[0].pasted, ['hello']);
});

test('an approved snippet is dropped if the pane reconnected meanwhile', () => {
  const h = harness();
  const bound = { id: h.pane.conn.id, request: h.pane.conn.request };
  assert.equal(h.pane.sendText('ls', false, bound), true);
  assert.deepEqual(h.terminals[0].pasted, ['ls']);
  h.pane.conn.request = { ...h.pane.conn.request };
  assert.equal(h.pane.sendText('id', true, bound), false);
  assert.deepEqual(h.terminals[0].pasted, ['ls']);
});

test('search stays per-pane, uses literal matching, and supports navigation and dismissal', () => {
  const h = harness();
  const other = h.another();
  h.pane.openSearch();
  const bar = h.pane.el.children[0];
  const [input, status, previous] = bar.children;
  assert.equal(bar.hidden, false);
  assert.equal(other.el.children[0].hidden, true);
  input.value = 'match';
  input.fire('input');
  assert.equal(status.textContent, 'Match selected');
  assert.equal(h.searches[0].calls.at(-1)[2].regex, false);
  previous.fire('click');
  assert.equal(h.searches[0].calls.at(-1)[0], 'previous');
  input.value = '[.*';
  input.fire('input');
  assert.equal(status.textContent, 'No matches');
  input.fire('keydown', { key: 'Escape' });
  assert.equal(bar.hidden, true);
  assert.equal(status.textContent, '');
  assert.deepEqual(h.searches[1].calls, []);
});


test('split-pane close button delegates to the app confirmation and cleanup flow', () => {
  const h = harness();
  const close = h.pane.el.children.find((n) => n.class === 'pane-close');
  close.fire('click');
  assert.deepEqual(h.closed, [h.pane]);
  assert.equal(h.pane.conn.online, true);
});


test('paste approval and cancellation restore keyboard focus to the terminal', async () => {
  const h = harness();
  const approved = h.pane.pasteText('one\ntwo');
  h.modals[0].approve();
  await approved;
  assert.equal(h.terminals[0].focusCalls, 1);
  const cancelled = h.pane.pasteText('three\nfour');
  h.modals[1].close();
  await cancelled;
  assert.equal(h.terminals[0].focusCalls, 2);
  assert.deepEqual(h.terminals[0].pasted, ['one\ntwo']);
});

test('paste never steals focus from another pane or dialog', async () => {
  const h = harness();
  h.pane.host.canFocus = () => false;
  await h.pane.pasteText('echo hello');
  assert.equal(h.terminals[0].focusCalls, 0);
  assert.deepEqual(h.terminals[0].pasted, ['echo hello']);
});

test('reconnected or disposed panes do not regain focus from an old preview', async () => {
  const h = harness();
  const pending = h.pane.pasteText('one\ntwo');
  h.pane.conn.request = { ...h.pane.conn.request };
  h.modals[0].approve();
  await pending;
  assert.equal(h.terminals[0].focusCalls, 0);
  const another = h.pane.pasteText('three\nfour');
  h.pane.dispose();
  await another;
  assert.equal(h.terminals[0].focusCalls, 0);
});
