/**
 * MCP smoke test: a real stdio MCP server (test/fixtures/echo-mcp-server.mjs) configured
 * in CodePal's mcp.json, driven by a scripted model (pi-ai's faux provider), through
 * createCodepalSession — the same code path the app uses. No gateway key needed.
 *
 * Two scenarios, each with a fresh agent dir and server process:
 *   direct    "exposure": "direct" — the model calls mcp__echo__* tools itself
 *   codemode  pi's default exposure — the model runs a codemode script that calls them
 * Checks in both:
 *   - the server connects and its tools are registered as mcp__echo__*
 *   - echo (not read-only) asks for approval; approved, it returns "echo: <text>"
 *   - peek (readOnlyHint) runs without asking
 *   - a denied echo call is blocked and never reaches the server
 *   - dispose() stops the server process
 *
 * Usage: npm run test:mcp
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createCodepalSession, type UiEvent } from "../codepal-agent.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type ToolEnd = Extract<UiEvent, { type: "tool_end" }>;

async function scenario(
  label: string,
  exposure: "direct" | undefined,
  script: AssistantMessage[],
  verify: (ctx: { ends: ToolEnd[]; approvals: string[]; events: UiEvent[] }) => void,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codepal-mcp-"));
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  const callLog = path.join(tmp, "calls.jsonl");
  const pidFile = path.join(tmp, "server.pid");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      echo: {
        command: process.execPath,
        args: [path.join(here, "fixtures", "echo-mcp-server.mjs")],
        env: { ECHO_MCP_LOG: callLog, ECHO_MCP_PID: pidFile },
        ...(exposure ? { exposure } : {}),
      },
    },
  }, null, 2));

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(script);
  const events: UiEvent[] = [];
  const approvals: string[] = [];
  let settled!: () => void;
  const settledP = new Promise<void>((r) => { settled = r; });
  const c = (name: string, ok: boolean, detail?: string) => check(`[${label}] ${name}`, ok, detail);

  const session = await createCodepalSession({
    cwd,
    agentDir,
    model: "faux-1",
    models: [],
    provider: faux.provider,
    onEvent: (e) => {
      events.push(e);
      if (e.type === "settled") settled();
    },
    onApprovalRequest: async (req) => {
      const input = req.input as { text?: string };
      approvals.push(`${req.toolName}:${input.text ?? ""}`);
      return input.text === "blocked" ? { approved: false, reason: "Denied by test" } : { approved: true };
    },
  });

  try {
    // Wait for the server's tools (and, for codemode exposure, the codemode tool) so a
    // connection failure is reported as such rather than as a confused model run.
    const deadline = Date.now() + 15_000;
    let names: string[] = [];
    while (Date.now() < deadline) {
      names = session.session.getAllTools().map((t) => t.name).filter((n) => n.startsWith("mcp__echo__"));
      const ready = names.length >= 2 && (exposure === "direct" || session.session.getActiveToolNames().includes("codemode"));
      if (ready) break;
      await sleep(100);
    }
    c("server connected, tools registered", names.includes("mcp__echo__echo") && names.includes("mcp__echo__peek"), names.join(", ") || "none");

    await session.send("Use the echo server.");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      settledP,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("run did not settle in 30 s")), 30_000); }),
    ]).finally(() => clearTimeout(timer));

    const ends = events.filter((e): e is ToolEnd => e.type === "tool_end");
    verify({ ends, approvals, events });
    const calls = fs.existsSync(callLog)
      ? fs.readFileSync(callLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
      : [];
    c("echo asked for approval", approvals.some((a) => a.startsWith("mcp__echo__echo:") && !a.endsWith(":blocked")), approvals.join(" | "));
    c("peek (read-only) did not ask", !approvals.some((a) => a.startsWith("mcp__echo__peek")), approvals.join(" | "));
    c("denied echo asked, and never reached the server", approvals.includes("mcp__echo__echo:blocked") && !calls.some((x) => x.args?.text === "blocked"), JSON.stringify(calls));
    c("model got the final turn", events.some((e) => e.type === "text_end" && e.content.includes("done")));
  } catch (err) {
    c("run completed", false, String((err as Error).message ?? err));
  } finally {
    await session.dispose();
  }

  const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : NaN);
  const validPid = Number.isInteger(pid) && pid > 0; // never signal 0 (= own process group)
  let alive = validPid;
  for (let i = 0; alive && i < 30; i++) {
    await sleep(100);
    // ESRCH = no such process. Anything else (EPERM) means something still holds the pid.
    try { process.kill(pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  c("dispose() stopped the server process", validPid && !alive, `pid ${pid}`);

  const notices = events.filter((e): e is Extract<UiEvent, { type: "notice" | "error" }> => e.type === "notice" || e.type === "error");
  if (notices.length) console.log(`[${label}] notices: ${notices.map((n) => n.message).join(" | ")}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 1. direct: the model calls echo (approved) -> peek -> echo (denied) -> final text.
await scenario("direct", "direct", [
  fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "hello" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("mcp__echo__peek", {}), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "blocked" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("done")),
], ({ ends }) => {
  const ok = ends.find((e) => e.toolName === "mcp__echo__echo" && !e.isError);
  const peek = ends.find((e) => e.toolName === "mcp__echo__peek");
  const denied = ends.find((e) => e.toolName === "mcp__echo__echo" && e.isError);
  check("[direct] echo returned the server's result", ok?.text.includes("echo: hello") === true, ok?.text);
  check("[direct] peek returned its result", peek?.isError === false && peek.text.includes("peek ok"), peek?.text);
  check("[direct] denied echo ended as an error", denied !== undefined, denied?.text);
});

// 2. codemode (pi's default exposure): one script calls echo, a denied echo, and peek.
// Scripts receive an MCP tool's result as an object (its MCP content), so stringify it.
const code = `
const a = JSON.stringify(await tools.mcp__echo__echo({ text: "from script" }));
let denied = "no";
try { await tools.mcp__echo__echo({ text: "blocked" }); } catch (e) { denied = "yes"; }
const p = JSON.stringify(await tools.mcp__echo__peek({}));
return a + " | denied=" + denied + " | " + p;
`;
await scenario("codemode", undefined, [
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("done")),
], ({ ends }) => {
  const run = ends.find((e) => e.toolName === "codemode");
  const t = run?.text ?? "";
  check("[codemode] script got echo's result", t.includes("echo: from script"), t);
  check("[codemode] script saw the denied call fail", t.includes("denied=yes"), t);
  check("[codemode] script got peek's result", t.includes("peek ok"), t);
});

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `FAIL (${failed} of ${results.length})` : `PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
