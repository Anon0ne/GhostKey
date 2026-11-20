import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { tmuxNameProblem, describeTmux } = await load("tmux.ts");

test("tmux names match what the server side accepts", () => {
  for (const ok of ["", "work", "client-a_2"]) assert.equal(tmuxNameProblem(ok), null, ok);
  for (const bad of ["a b", "a;b", "x.y", "x:y", "$(id)", "'q'", "a".repeat(65)]) assert.ok(tmuxNameProblem(bad), bad);
});

test("tmux sessions are described in words", () => {
  const now = 1_700_003_600_000;
  assert.equal(describeTmux({ name: "w", attached: 0, windows: 1, created: 1_700_000_000 }, now), "1 window · started 1 h ago");
  assert.equal(describeTmux({ name: "w", attached: 2, windows: 3, created: null }, now), "3 windows · 2 attached now");
});
