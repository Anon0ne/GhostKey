import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const protocols = load("protocols.ts");
const { describeTarget, serialSummary, serialProblem, normalizeSerial, normalizeProtocol, protocolOf, hasSshFeatures, DEFAULT_SERIAL } = protocols;
const { jumpChain, jumpChoices } = load("jumps.ts");
const layout = load("layout.ts");
const { buildProfile, parseProfile } = load("profile.ts", {
  "./workspace": load("workspace.ts", { "./layout": layout }),
  "./hostLabels": load("hostLabels.ts"),
  "./protocols": protocols,
});

test("sessions saved before other protocols are SSH", () => {
  assert.equal(protocolOf({}), "ssh");
  assert.equal(protocolOf(null), "ssh");
  assert.ok(hasSshFeatures({ protocol: "ssh" }));
  for (const p of ["telnet", "serial", "local"]) assert.equal(hasSshFeatures({ protocol: p }), false, p);
});

test("each kind of target is described the way people write it", () => {
  assert.equal(describeTarget({ host: "h", port: 22, username: "u" }), "u@h");
  assert.equal(describeTarget({ protocol: "ssh", host: "h", port: 2222, username: "u" }), "u@h:2222");
  assert.equal(describeTarget({ protocol: "telnet", host: "switch", port: 23, username: "" }), "telnet switch");
  assert.equal(describeTarget({ protocol: "telnet", host: "switch", port: 2323, username: "" }), "telnet switch:2323");
  assert.equal(describeTarget({ protocol: "local", host: "", port: 0, username: "" }), "local shell");
  const serial = { ...DEFAULT_SERIAL, path: "COM3", baud: 9600 };
  assert.equal(describeTarget({ protocol: "serial", host: "", port: 0, username: "", serial }), "COM3 9600 8N1");
  assert.equal(serialSummary({ ...serial, parity: "even", dataBits: 7, stopBits: 2, flow: "hardware" }), "9600 7E2 RTS/CTS");
});

test("serial settings are checked like the backend checks them", () => {
  const ok = { ...DEFAULT_SERIAL, path: "/dev/ttyUSB0" };
  assert.equal(serialProblem(ok), null);
  assert.match(serialProblem({ ...ok, path: " " }), /port/);
  assert.match(serialProblem({ ...ok, baud: 10 }), /Speed/);
  assert.match(serialProblem({ ...ok, baud: 9600.5 }), /Speed/);
  assert.match(serialProblem({ ...ok, dataBits: 9 }), /Data bits/);
  assert.match(serialProblem({ ...ok, stopBits: 3 }), /Stop bits/);
  assert.match(serialProblem(null), /port/);
});

test("imported serial settings and protocols are cleaned", () => {
  assert.deepEqual(normalizeSerial({ path: " COM4 ", baud: 9600, parity: "weird", flow: "hardware", extra: 1 }), {
    path: "COM4",
    baud: 9600,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flow: "hardware",
  });
  assert.equal(normalizeSerial({ path: "", baud: 9600 }), null);
  assert.equal(normalizeSerial("COM1"), null);
  assert.equal(normalizeProtocol("telnet"), "telnet");
  assert.equal(normalizeProtocol("local"), "ssh");
  assert.equal(normalizeProtocol(undefined), "ssh");
});

test("only SSH sessions can be jump hosts", () => {
  const all = [
    { id: "a", name: "bastion", jumpSession: null },
    { id: "t", name: "switch", jumpSession: null, protocol: "telnet" },
    { id: "s", name: "server", jumpSession: "t" },
  ];
  // "server" goes through the Telnet session, so it has no usable route either.
  assert.deepEqual(jumpChoices({ id: "new" }, all).map((x) => x.id), ["a"]);
  const c = jumpChain(all[2], all);
  assert.equal(c.ok, false);
  assert.match(c.error, /isn't an SSH session/);
});

const base = {
  folder: "",
  username: "",
  auth: "password",
  keyPath: null,
  autoOpenTailscale: false,
  autoLog: false,
  forwards: [],
  jumpSession: null,
  tags: [],
  environment: "",
  tmux: "",
};

test("profiles carry Telnet and serial sessions", () => {
  const sessions = [
    { ...base, id: "11111111-1111-4111-8111-111111111111", name: "Switch", host: "10.0.0.2", port: 23, protocol: "telnet", serial: null },
    { ...base, id: "22222222-2222-4222-8222-222222222222", name: "Console", host: "", port: 0, protocol: "serial", serial: { ...DEFAULT_SERIAL, path: "COM3", baud: 9600 } },
    { ...base, id: "33333333-3333-4333-8333-333333333333", name: "Old", host: "h", port: 22, username: "u" },
  ];
  const profile = buildProfile({ sessions, snippets: [], workspaces: [] }, "/home/me", new Date(0));
  const back = parseProfile(JSON.stringify(profile));
  assert.ok(back.ok);
  assert.deepEqual(back.skipped, []);
  const [telnet, serial, old] = back.profile.sessions;
  assert.equal(telnet.protocol, "telnet");
  assert.equal(telnet.port, 23);
  assert.equal(serial.protocol, "serial");
  assert.equal(serial.serial.path, "COM3");
  assert.equal(serial.host, "");
  assert.equal(old.protocol, "ssh");
  assert.equal(old.serial, null);
});

test("a serial session in a profile with no usable port is skipped", () => {
  const raw = {
    format: "ghostkey-profile",
    version: 1,
    sessions: [{ ...base, id: "22222222-2222-4222-8222-222222222222", name: "Console", host: "", port: 0, protocol: "serial", serial: { path: "", baud: 9600 } }],
    snippets: [],
    workspaces: [],
  };
  const r = parseProfile(JSON.stringify(raw));
  assert.ok(r.ok);
  assert.equal(r.profile.sessions.length, 0);
  assert.match(r.skipped[0], /serial/);
});
