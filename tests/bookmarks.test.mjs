import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { suggestRedaction, toMarkdown, toJson, excerptFor } = await load("bookmarks.ts");

const bm = (over = {}) => ({
  id: "b1",
  createdAt: "2026-11-20T02:00:00.000Z",
  source: { name: "lab", username: "kali", host: "10.0.0.5", port: 2222, sessionId: null, environment: "lab" },
  note: "Creds in config\nsecond line",
  original: "db_password=hunter2\n✓ ünïcode ```fence```\n",
  redacted: null,
  ...over,
});

test("redaction suggestions hide common secrets and keep the rest", () => {
  const text = [
    "password: hunter2",
    "db_password=s3cret API_TOKEN=xyz789 author=jane",
    "TOKEN=abc123 other=fine",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y",
    "key AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    "plain line ✓",
  ].join("\n");
  const r = suggestRedaction(text);
  for (const secret of ["hunter2", "s3cret", "xyz789", "abc123", "eyJhbGci", "AKIAABCDEFGHIJKLMNOP", "abc\n"]) assert.ok(!r.includes(secret), secret);
  assert.match(r, /other=fine/);
  assert.match(r, /author=jane/);
  assert.match(r, /plain line ✓/);
});

test("exports use the original unless a redacted copy is asked for and exists", () => {
  const b = bm({ redacted: "db_password=[REDACTED]\n" });
  assert.equal(excerptFor(b, { redacted: false }).version, "original");
  assert.equal(excerptFor(b, { redacted: true }).version, "redacted");
  assert.equal(excerptFor(bm(), { redacted: true }).version, "original");
});

test("markdown export keeps multiline unicode excerpts intact inside a safe fence", () => {
  const md = toMarkdown([bm()], { redacted: false, exportedAt: new Date("2026-11-20T03:00:00Z") });
  assert.match(md, /not a forensic record/);
  assert.match(md, /Session: lab \(kali@10\.0\.0\.5:2222\), lab/);
  assert.match(md, /> Creds in config\n> second line/);
  // The excerpt contains ``` so the fence must be longer.
  assert.match(md, /\n````\ndb_password=hunter2\n✓ ünïcode ```fence```\n````\n/);
});

test("json export records which version each excerpt is", () => {
  const j = JSON.parse(toJson([bm({ redacted: "x" }), bm({ id: "b2" })], { redacted: true, exportedAt: new Date(0) }));
  assert.equal(j.format, "ghostkey-bookmarks");
  assert.deepEqual(j.bookmarks.map((b) => b.excerptVersion), ["redacted", "original"]);
  assert.equal(j.bookmarks[1].excerpt, bm().original);
});
