#!/usr/bin/env node
/**
 * Minimal MCP server over stdio for CodePal's tests: newline-delimited JSON-RPC 2.0,
 * no dependencies. Tools:
 *   echo  {text}  -> "echo: <text>"   (no annotations: CodePal asks before calling it)
 *   peek  {}      -> "peek ok"        (readOnlyHint: CodePal calls it without asking)
 * Every tools/call is appended to $ECHO_MCP_LOG (one JSON line per call) and the process
 * id is written to $ECHO_MCP_PID, so a test can prove which calls reached the server and
 * that the server was stopped.
 */
import fs from "node:fs";
import readline from "node:readline";

const log = (entry) => {
  if (process.env.ECHO_MCP_LOG) fs.appendFileSync(process.env.ECHO_MCP_LOG, JSON.stringify(entry) + "\n");
};
if (process.env.ECHO_MCP_PID) fs.writeFileSync(process.env.ECHO_MCP_PID, String(process.pid));

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "peek",
    description: "Read-only probe that returns a fixed string.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t) => ({ content: [{ type: "text", text: t }] });

function handle(req) {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-mcp-server", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = req.params ?? {};
      log({ name, args });
      if (name === "echo") return text(`echo: ${args.text}`);
      if (name === "peek") return text("peek ok");
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification (e.g. notifications/initialized)
  try {
    send({ id: req.id, result: handle(req) });
  } catch (err) {
    send({ id: req.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
process.stdin.on("end", () => process.exit(0));
