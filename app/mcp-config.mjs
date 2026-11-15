/**
 * CodePal's mcp.json: read, validate, edit, and merge with a session's live MCP status
 * for the MCP panel. No Electron here, so it can be tested with plain node
 * (test/mcp-config.test.mjs).
 *
 * The file is pi's MCP config format (pi 1.5.0, extensions/mcp/config.js):
 *   { "mcpServers": { "<name>": { "command", "args", "env", "cwd" } | { "url", "headers" },
 *                     ...plus "enabled", "exposure", "toolExposure", "description" } }
 * The form only manages the connection fields; anything else in an entry is kept.
 */
import fs from "node:fs";
import path from "node:path";

/** Names CodePal's form accepts. pi accepts more, but these stay readable as tool prefixes
 *  (mcp__<name>__<tool>) and in the panel. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const EMPTY_CONFIG = '{\n  "mcpServers": {}\n}\n';
const CONNECTION_KEYS = ["command", "args", "env", "cwd", "url", "headers", "type", "transport"];

/** { servers: { name: entry }, exists, error? } — never throws. */
export function readMcpConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { servers: {}, exists: false };
    return { servers: {}, exists: true, error: err.message };
  }
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, ""));
    const servers = json?.mcpServers;
    if (typeof json !== "object" || json === null || Array.isArray(json) ||
        (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))) {
      return { servers: {}, exists: true, error: 'expected an object with an "mcpServers" object' };
    }
    return { servers: servers ?? {}, exists: true };
  } catch (err) {
    return { servers: {}, exists: true, error: err.message };
  }
}

/** Read-modify-write. Refuses to touch a file it cannot parse, so a hand edit with a syntax
 *  error is never overwritten by the form. */
function updateMcpConfig(file, mutate) {
  let json = { mcpServers: {} };
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`mcp.json has a syntax error (${err.message}). Fix it with "Edit mcp.json" first.`);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error('mcp.json is not an object with "mcpServers". Fix it with "Edit mcp.json" first.');
    }
    json.mcpServers ??= {};
  }
  mutate(json.mcpServers);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write a sibling temp file and rename it over mcp.json: a crash never leaves half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

const has = (obj, key) => Object.hasOwn(obj, key);

/** "KEY=value" lines -> { KEY: "value" } (env). Throws on a line without "=". */
export function parsePairs(text, sep, what) {
  const pairs = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    if (i <= 0) throw new Error(`${what}: "${line}" is not ${sep === "=" ? "NAME=value" : "Name: value"}`);
    pairs.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  // fromEntries defines own keys, so a "__proto__" line is just a key, not a prototype.
  return Object.fromEntries(pairs);
}

/** Form input -> the connection part of an mcp.json entry. Throws with a message for the user.
 *  input: { name, kind: "command"|"url", command, args (string, one per line), env (lines),
 *           url, headers (lines) } */
export function validateServerInput(input) {
  const name = String(input?.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    throw new Error("Name: 1–40 letters, digits, '-' or '_', starting with a letter or digit.");
  }
  if (input.kind === "url") {
    let url;
    try { url = new URL(String(input.url ?? "").trim()); } catch { throw new Error("URL: not a valid address."); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new Error("URL: must start with https:// (plain http:// only for a server on this computer).");
    }
    const headers = parsePairs(input.headers, ":", "Headers");
    return { name, connection: { url: url.href, ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  const command = String(input?.command ?? "").trim();
  if (!command) throw new Error("Command: required (for example npx).");
  const args = String(input.args ?? "").split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
  const env = parsePairs(input.env, "=", "Environment");
  return {
    name,
    connection: { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) },
  };
}

/** Add a server (new entries get "exposure": "direct", so each tool call shows as its own
 *  card in the chat) or replace an existing entry's connection, keeping its other settings.
 *  previousName renames. */
export function saveServer(file, input, previousName) {
  const { name, connection } = validateServerInput(input);
  updateMcpConfig(file, (servers) => {
    const editing = previousName !== undefined && previousName !== null && previousName !== "";
    if (editing && !has(servers, previousName)) throw new Error(`No server named "${previousName}".`);
    if ((!editing || name !== previousName) && has(servers, name)) throw new Error(`A server named "${name}" already exists.`);
    const base = editing ? { ...servers[previousName] } : { exposure: "direct" };
    for (const key of CONNECTION_KEYS) delete base[key];
    if (editing && name !== previousName) delete servers[previousName];
    servers[name] = { ...connection, ...base };
  });
  return name;
}

export function removeServer(file, name) {
  updateMcpConfig(file, (servers) => {
    if (!has(servers, name)) throw new Error(`No server named "${name}".`);
    delete servers[name];
  });
}

/** pi treats a missing "enabled" as enabled, so enabling removes the key. */
export function setServerEnabled(file, name, enabled) {
  updateMcpConfig(file, (servers) => {
    const entry = has(servers, name) ? servers[name] : undefined;
    if (!entry || typeof entry !== "object") throw new Error(`No server named "${name}".`);
    if (enabled) delete entry.enabled;
    else entry.enabled = false;
  });
}

/** Entry -> what the form shows when editing it. */
export function toFormInput(name, entry) {
  const lines = (obj, sep) => Object.entries(obj ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");
  if (entry?.url) return { name, kind: "url", url: entry.url, headers: lines(entry.headers, ": ") };
  return { name, kind: "command", command: entry?.command ?? "", args: (entry?.args ?? []).join("\n"), env: lines(entry?.env, "=") };
}

/** One line describing how a server is started or reached. Header and env values are
 *  not shown (they often hold keys). */
export function summarize(entry) {
  if (entry?.url) return entry.url;
  const quote = (a) => (/\s/.test(a) ? JSON.stringify(a) : a);
  return [entry?.command, ...(entry?.args ?? [])].filter(Boolean).map(String).map(quote).join(" ");
}

/**
 * Panel rows: CodePal's configured servers first, then servers only the session knows
 * (a trusted project's .pi/mcp.json, or registered by an extension).
 *   runtime: session.mcpStatus() or null when no conversation is running.
 * States: connected | failed | needs-auth | disabled | connecting (session running, no
 * result yet) | not-started (servers start with a conversation).
 */
export function mergeStatus(config, runtime) {
  const live = new Map((runtime?.servers ?? []).map((s) => [s.name, s]));
  const rows = [];
  for (const [name, entry] of Object.entries(config.servers)) {
    const enabled = entry?.enabled !== false;
    const r = live.get(name);
    live.delete(name);
    rows.push({
      name,
      source: "codepal",
      kind: entry?.url ? "url" : "command",
      summary: summarize(entry),
      enabled,
      exposure: entry?.exposure ?? "codemode",
      state: !enabled ? "disabled" : r ? r.state : runtime ? "connecting" : "not-started",
      message: r?.message,
      tools: r?.tools ?? [],
    });
  }
  for (const r of live.values()) {
    rows.push({ name: r.name, source: "project", kind: null, summary: "", enabled: true, exposure: null, state: r.state, message: r.message, tools: r.tools });
  }
  return rows;
}

/** Ready-made servers for the form. The user reviews and saves them; nothing is added
 *  without that. Commands need Node.js (npx) on the computer. */
export function presets(workspace = ".") {
  return [
    {
      id: "filesystem",
      label: "Filesystem",
      description: "Read, search and edit files in a folder you choose. Needs Node.js.",
      input: { name: "filesystem", kind: "command", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", workspace].join("\n") },
    },
    {
      id: "memory",
      label: "Memory",
      description: "A small knowledge graph the agent can store facts in across conversations. Needs Node.js.",
      input: { name: "memory", kind: "command", command: "npx", args: "-y\n@modelcontextprotocol/server-memory" },
    },
    {
      id: "sequential-thinking",
      label: "Sequential thinking",
      description: "Lets the agent work through a problem step by step. Needs Node.js.",
      input: { name: "sequential-thinking", kind: "command", command: "npx", args: "-y\n@modelcontextprotocol/server-sequential-thinking" },
    },
    {
      id: "context7",
      label: "Context7 (library docs)",
      description: "Up-to-date documentation and code examples for libraries. Runs online, no install.",
      input: { name: "context7", kind: "url", url: "https://mcp.context7.com/mcp", headers: "" },
    },
    {
      id: "github",
      label: "GitHub",
      description: "Issues, pull requests and repositories. Needs a GitHub personal access token.",
      input: { name: "github", kind: "url", url: "https://api.githubcopilot.com/mcp/", headers: "Authorization: Bearer <your GitHub token>" },
    },
  ];
}
