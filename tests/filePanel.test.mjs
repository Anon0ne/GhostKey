import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function harness() {
  const dialog = deferred(), confirmation = deferred(), calls = [];
  const files = load('files.ts');
  const { FilePanel } = load('filePanel.ts', {
    './files': files,
    '@tauri-apps/plugin-dialog': { open: () => dialog.promise },
    './modal': { confirm: () => confirmation.promise },
    './api': { api: {
      defaultDownloadDir: async () => '/downloads', localKind: async () => 'missing',
      sftpRemove: async (...args) => calls.push(args),
    } },
  });
  const panel = Object.create(FilePanel.prototype);
  Object.assign(panel, {
    conn: { id: 1, online: true, request: {}, title: 'Lab' }, path: '/original',
    selected: new Set(['report']), entries: [{ name: 'report', kind: 'file' }],
    startTransfer: (...args) => calls.push(args),
    run: async (fn) => fn(),
  });
  return { panel, dialog, confirmation, calls };
}

test('download keeps its original remote folder while the destination dialog is open', async () => {
  const h = harness();
  const pending = h.panel.download([{ name: 'report', kind: 'file' }]);
  h.panel.path = '/different';
  h.dialog.resolve('/downloads');
  await pending;
  assert.equal(h.calls[0][2].remote, '/original/report');
});

test('delete confirmation applies to the folder shown when it opened', async () => {
  const h = harness();
  const pending = h.panel.removeSelected();
  h.panel.path = '/different';
  h.confirmation.resolve(true);
  await pending;
  assert.deepEqual(h.calls, [[1, '/original/report', false]]);
});

test('upload picker cannot switch to another connection or folder', async () => {
  const h = harness();
  h.panel.uploadPaths = async (...args) => h.calls.push(args);
  const pending = h.panel.chooseUploads();
  h.panel.conn.id = 2;
  h.panel.path = '/different';
  h.dialog.resolve(['/local/report']);
  await pending;
  assert.deepEqual(h.calls, []);
});
