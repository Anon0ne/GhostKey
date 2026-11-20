import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { shouldNotify, skipVersion, skippedVersion, progressText, releasedText } = load("update.ts");

const release = { version: "0.3.0-beta.1", name: "GhostKey v0.3.0-beta.1", notes: "", url: "https://github.com/Anon0ne/GhostKey/releases/tag/v0.3.0-beta.1", published: "2026-11-20T10:00:00Z", prerelease: true, manifest: null };
const found = { current: "0.2.4", available: release, canInstall: false, installNote: "x" };
const none = { current: "0.2.4", available: null, canInstall: false, installNote: null };

test("automatic checks stay quiet about skipped versions; the menu always answers", () => {
  assert.equal(shouldNotify(found, null, false), true);
  assert.equal(shouldNotify(found, "0.3.0-beta.1", false), false);
  assert.equal(shouldNotify(found, "0.3.0-beta.1", true), true);
  assert.equal(shouldNotify(found, "0.2.9", false), true);
  assert.equal(shouldNotify(none, null, true), false);
});

test("the skipped version is remembered, and broken storage is ignored", () => {
  const data = new Map();
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  assert.equal(skippedVersion(store), null);
  skipVersion(store, "0.3.0");
  assert.equal(skippedVersion(store), "0.3.0");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(skippedVersion(broken), null);
  skipVersion(broken, "1.0.0");
  assert.equal(skippedVersion(null), null);
});

test("download progress reads in megabytes", () => {
  assert.equal(progressText({ type: "progress", done: 12_300_000, total: 40_000_000 }), "Downloaded 12.3 MB of 40.0 MB (31%)");
  assert.equal(progressText({ type: "progress", done: 2_000_000, total: null }), "Downloaded 2.0 MB");
  assert.match(progressText({ type: "installing" }), /restart/);
});

test("release dates are shown in words, or not at all", () => {
  assert.equal(releasedText("2026-11-20T10:00:00Z", "en-GB"), "Released 20 Nov 2026");
  assert.equal(releasedText(null), "");
  assert.equal(releasedText("soon"), "");
});
