import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { jumpChain, jumpChoices, routeText, MAX_JUMPS } = await load("jumps.ts");

const s = (id, jumpSession = null) => ({ id, name: id, jumpSession });

test("a chain of jump hosts comes out outermost first", () => {
  const all = [s("server", "inner"), s("inner", "bastion"), s("bastion")];
  const c = jumpChain(all[0], all);
  assert.equal(c.ok, true);
  assert.deepEqual(c.hops.map((h) => h.id), ["bastion", "inner"]);
  assert.equal(routeText(c.hops, "server"), "bastion → inner → server");
});

test("a direct session has no hops", () => {
  assert.deepEqual(jumpChain(s("a"), [s("a")]), { ok: true, hops: [] });
});

test("a missing jump host or a loop is refused with a reason", () => {
  const missing = jumpChain(s("a", "gone"), [s("a", "gone")]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no longer exists/);
  const all = [s("a", "b"), s("b", "c"), s("c", "b")];
  const loop = jumpChain(all[0], all);
  assert.equal(loop.ok, false);
  assert.match(loop.error, /loop/);
});

test("chains longer than the limit are refused", () => {
  const all = Array.from({ length: MAX_JUMPS + 2 }, (_, i) => s(`h${i}`, i < MAX_JUMPS + 1 ? `h${i + 1}` : null));
  assert.equal(jumpChain(all[0], all).ok, false);
  assert.equal(jumpChain(all[1], all).ok, true);
});

test("jump choices leave out the session itself and anything that routes through it", () => {
  const all = [s("a"), s("b", "a"), s("c", "b"), s("d")];
  assert.deepEqual(jumpChoices(all[0], all).map((x) => x.id), ["d"]);
  assert.deepEqual(jumpChoices(all[3], all).map((x) => x.id), ["a", "b", "c"]);
  // A new session (not saved yet) can use any of them.
  assert.equal(jumpChoices({ id: "new" }, all).length, 4);
});
