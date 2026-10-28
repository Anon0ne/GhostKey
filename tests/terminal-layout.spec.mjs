import { test, expect } from '@playwright/test';

for (const dir of ['row', 'column']) {
test(`${dir} split keeps every terminal row visible through resizing and search`, async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/tests/fixtures/terminal-layout.html');
  await page.waitForFunction(() => window.ready);
    await page.evaluate((dir) => {
      window.layout.split.className = `split ${dir}`;
      window.layout.panes[0].openSearch();
    }, dir);
    for (let height = 680; height < 720; height++) {
      await page.setViewportSize({ width: 1100, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
        window.layout.fit();
        requestAnimationFrame(resolve);
      })));
      const panes = await page.evaluate(() => window.layout.panes.map((pane) => {
        const screen = pane.el.querySelector('.xterm-screen');
        const box = screen.closest('.xterm').parentElement;
        const s = screen.getBoundingClientRect(), b = box.getBoundingClientRect();
        return { bottom: s.bottom, availableBottom: b.bottom, right: s.right, availableRight: b.right, overflow: box.scrollHeight - box.clientHeight };
      }));
      for (const pane of panes) {
        expect(pane.bottom, `${dir} split at height ${height}: clipped last row`).toBeLessThanOrEqual(pane.availableBottom + 0.5);
        expect(pane.right, `${dir} split at height ${height}: clipped column`).toBeLessThanOrEqual(pane.availableRight + 0.5);
        expect(pane.overflow, `${dir} split at height ${height}: extra container scrolling`).toBeLessThanOrEqual(1);
      }
    }
});
}

test('scrollback stays available without an always-present empty scrollbar', async ({ page }) => {
  await page.goto('/tests/fixtures/terminal-layout.html');
  await page.waitForFunction(() => window.ready);
  const viewport = page.locator('.xterm-viewport').first();
  expect(await viewport.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  await page.evaluate(() => new Promise((resolve) => {
    const term = window.layout.panes[0].term;
    term.write(Array.from({ length: 100 }, (_, i) => `Line ${i}\r\n`).join(''), resolve);
  }));
  await page.locator(".xterm-screen").first().hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => page.evaluate(() => {
    const buffer = window.layout.panes[0].term.buffer.active;
    return buffer.viewportY < buffer.baseY;
  })).toBe(true);
  await page.evaluate(() => window.layout.panes[0].term.scrollToBottom());
  await expect.poll(() => page.evaluate(() => {
    const buffer = window.layout.panes[0].term.buffer.active;
    return buffer.viewportY === buffer.baseY;
  })).toBe(true);
});

test('approving pasted commands restores terminal focus so Enter reaches SSH', async ({ page }) => {
  await page.goto('/tests/fixtures/terminal-layout.html');
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    const pane = window.layout.panes[0];
    Object.assign(pane.conn, { request: { username: 'test', host: 'example', port: 22 }, id: 1, connected: true, closed: false });
    window.receivedInput = [];
    pane.conn.input = (text) => window.receivedInput.push(text);
    pane.focus();
    window.pasteFinished = pane.pasteText('echo one\necho two');
  });
  await page.getByRole('button', { name: 'Paste to this terminal', exact: true }).click();
  await page.evaluate(() => window.pasteFinished);
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.receivedInput.at(-1))).toBe('\r');
});

test('right-click clipboard paste accepts Enter without an extra click', async ({ page }) => {
  await page.goto('/tests/fixtures/terminal-layout.html');
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = { invoke: async () => 'echo clipboard' };
    const pane = window.layout.panes[0];
    Object.assign(pane.conn, { request: { username: 'test', host: 'example', port: 22 }, id: 1, connected: true, closed: false });
    window.receivedInput = [];
    pane.conn.input = (text) => window.receivedInput.push(text);
    window.layout.panes[1].focus();
  });
  await page.locator('.xterm-screen').first().click({ button: 'right' });
  await expect.poll(() => page.evaluate(() => window.receivedInput.includes('echo clipboard'))).toBe(true);
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.receivedInput.at(-1))).toBe('\r');
});
