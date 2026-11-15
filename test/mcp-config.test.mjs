// Unit tests for app/mcp-config.mjs (CodePal's mcp.json handling). Run: npm run test:unit
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  mergeStatus, parsePairs, presets, readMcpConfig, removeServer, saveServer,
  setServerEnabled, summarize, toFormInput, validateServerInput,
} from "../app/mcp-config.mjs";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codepal-mcpcfg-")), "pi-agent", "mcp.json");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("readMcpConfig: missing, valid with BOM, invalid", () => {
  const file = tmpFile();
  assert.deepEqual(readMcpConfig(file), { servers: {}, exists: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF{"mcpServers":{"a":{"command":"x"}}}');
  assert.deepEqual(readMcpConfig(file), { servers: { a: { command: "x" } }, exists: true });
  fs.writeFileSync(file, "{ nope");
  const bad = readMcpConfig(file);
  assert.equal(bad.exists, true);
  assert.ok(bad.error);
  fs.writeFileSync(file, '{"mcpServers": []}');
  assert.match(readMcpConfig(file).error, /mcpServers/);
});

test("saveServer: new command server gets exposure direct, args and env", () => {
  const file = tmpFile();
  saveServer(file, { name: "mem", kind: "command", command: "npx", args: "-y\n @modelcontextprotocol/server-memory \n\n", env: "A=1\nB = two=2" });
  assert.deepEqual(read(file).mcpServers.mem, {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { A: "1", B: "two=2" }, exposure: "direct",
  });
  assert.throws(() => saveServer(file, { name: "mem", kind: "command", command: "x" }), /already exists/);
});

test("saveServer: editing keeps other settings, replaces the connection, renames", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ other: 1, mcpServers: {
    docs: { command: "old", args: ["x"], env: { K: "v" }, enabled: false, exposure: "codemode", description: "d" },
    keep: { command: "k" },
  } }));
  saveServer(file, { name: "docs2", kind: "url", url: "https://example.com/mcp", headers: "Authorization: Bearer a:b" }, "docs");
  const json = read(file);
  assert.equal(json.other, 1);
  assert.equal(json.mcpServers.docs, undefined);
  assert.deepEqual(json.mcpServers.docs2, {
    url: "https://example.com/mcp", headers: { Authorization: "Bearer a:b" }, enabled: false, exposure: "codemode", description: "d",
  });
  assert.deepEqual(json.mcpServers.keep, { command: "k" });
  assert.throws(() => saveServer(file, { name: "keep", kind: "command", command: "x" }, "docs2"), /already exists/);
  assert.throws(() => saveServer(file, { name: "z", kind: "command", command: "x" }, "missing"), /No server named "missing"/);
});

test("validateServerInput: names, URLs, required fields", () => {
  assert.throws(() => validateServerInput({ name: "", kind: "command", command: "x" }), /Name/);
  assert.throws(() => validateServerInput({ name: "__proto__", kind: "command", command: "x" }), /Name/);
  assert.throws(() => validateServerInput({ name: "has space", kind: "command", command: "x" }), /Name/);
  assert.throws(() => validateServerInput({ name: "a", kind: "command", command: " " }), /Command/);
  assert.throws(() => validateServerInput({ name: "a", kind: "url", url: "not a url" }), /URL/);
  assert.throws(() => validateServerInput({ name: "a", kind: "url", url: "http://example.com/mcp" }), /https/);
  assert.throws(() => validateServerInput({ name: "a", kind: "url", url: "ftp://example.com" }), /https/);
  assert.equal(validateServerInput({ name: "a", kind: "url", url: "http://localhost:3000/mcp" }).connection.url, "http://localhost:3000/mcp");
  assert.equal(validateServerInput({ name: "a", kind: "url", url: "http://127.0.0.1:3000/mcp" }).connection.url, "http://127.0.0.1:3000/mcp");
  assert.throws(() => validateServerInput({ name: "a", kind: "command", command: "x", env: "NOEQUALS" }), /Environment/);
});

test("parsePairs: __proto__ is just a key", () => {
  const out = parsePairs("__proto__=x\nA=1", "=", "Environment");
  assert.equal(Object.hasOwn(out, "__proto__"), true);
  assert.equal(out.__proto__, "x");
  assert.equal({}.x, undefined);
  // Survives JSON as an own key (an object literal { __proto__: ... } would set the prototype instead).
  assert.deepEqual(Object.entries(JSON.parse(JSON.stringify({ env: out })).env), [["__proto__", "x"], ["A", "1"]]);
});

test("a file with a syntax error is never overwritten", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ broken");
  for (const action of [
    () => saveServer(file, { name: "a", kind: "command", command: "x" }),
    () => removeServer(file, "a"),
    () => setServerEnabled(file, "a", false),
  ]) assert.throws(action, /syntax error/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["mcp.json"]); // no temp file left
});

test("setServerEnabled and removeServer", () => {
  const file = tmpFile();
  saveServer(file, { name: "a", kind: "command", command: "x" });
  setServerEnabled(file, "a", false);
  assert.equal(read(file).mcpServers.a.enabled, false);
  setServerEnabled(file, "a", true);
  assert.equal("enabled" in read(file).mcpServers.a, false);
  assert.throws(() => setServerEnabled(file, "toString", false), /No server/);
  removeServer(file, "a");
  assert.deepEqual(read(file).mcpServers, {});
  assert.throws(() => removeServer(file, "a"), /No server/);
});

test("toFormInput round-trips through validateServerInput", () => {
  for (const entry of [
    { command: "npx", args: ["-y", "pkg"], env: { A: "1" } },
    { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
  ]) {
    const { connection } = validateServerInput(toFormInput("s", entry));
    assert.deepEqual(connection, entry);
  }
});

test("summarize shows the command or URL, never env or header values", () => {
  assert.equal(summarize({ command: "npx", args: ["-y", "a b"], env: { SECRET: "s3" } }), 'npx -y "a b"');
  assert.equal(summarize({ url: "https://x/mcp", headers: { Authorization: "Bearer s3" } }), "https://x/mcp");
});

test("mergeStatus: every state", () => {
  const config = { servers: {
    up: { command: "a" }, down: { command: "b" }, off: { command: "c", enabled: false }, wait: { url: "https://w/mcp", exposure: "direct" },
  } };
  const runtime = { servers: [
    { name: "up", state: "connected", tools: [{ name: "t", readOnly: true, description: "" }] },
    { name: "down", state: "failed", message: "spawn b ENOENT", tools: [] },
    { name: "proj", state: "connected", tools: [] },
  ] };
  const rows = Object.fromEntries(mergeStatus(config, runtime).map((r) => [r.name, r]));
  assert.equal(rows.up.state, "connected");
  assert.equal(rows.up.tools.length, 1);
  assert.equal(rows.up.exposure, "codemode");
  assert.equal(rows.down.state, "failed");
  assert.equal(rows.down.message, "spawn b ENOENT");
  assert.equal(rows.off.state, "disabled");
  assert.equal(rows.wait.state, "connecting");
  assert.equal(rows.wait.kind, "url");
  assert.equal(rows.proj.source, "project");
  const idle = Object.fromEntries(mergeStatus(config, null).map((r) => [r.name, r.state]));
  assert.deepEqual(idle, { up: "not-started", down: "not-started", off: "disabled", wait: "not-started" });
});

test("presets validate and use the workspace for filesystem", () => {
  for (const p of presets("/work/space")) {
    if (p.id === "github") continue; // needs the user's token in the header first
    assert.doesNotThrow(() => validateServerInput(p.input), p.id);
  }
  assert.ok(presets("/work/space").find((p) => p.id === "filesystem").input.args.endsWith("/work/space"));
  assert.ok(presets().find((p) => p.id === "filesystem").input.args.endsWith("."));
});
