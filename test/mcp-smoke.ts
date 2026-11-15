/**
 * MCP smoke test: a real stdio MCP server (test/fixtures/echo-mcp-server.mjs) configured
 * in CodePal's mcp.json, driven by a scripted model (pi-ai's faux provider), through
 * createCodepalSession — the same code path the app uses. No gateway key needed.
 *
 * Scenarios, each with a fresh agent dir, project folder and fake home:
 *   direct    "exposure": "direct" — the model calls mcp__echo__* tools itself
 *   codemode  pi's default exposure — the model runs a codemode script that calls them,
 *             and tries the built-in write tool from the script
 *   builtin   the model calls pi's write and bash directly (CodePal's original gate)
 * Every scenario also plants two servers that must never start: one in the project's
 * .pi/mcp.json (the folder is not trusted) and one in the fake home's ~/.pi/agent/mcp.json
 * (the pi CLI's config, which CodePal must not read). And dispose() must stop the server.
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
const fixture = path.join(here, "fixtures", "echo-mcp-server.mjs");
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type ToolEnd = Extract<UiEvent, { type: "tool_end" }>;
interface Run {
  ends: ToolEnd[];
  approvals: string[];
  events: UiEvent[];
  cwd: string;
  calls: { name: string; args?: { text?: string } }[];
}

const server = (dir: string, name: string, extra: object = {}) => ({
  command: process.execPath,
  args: [fixture],
  env: { ECHO_MCP_LOG: path.join(dir, `${name}.calls.jsonl`), ECHO_MCP_PID: path.join(dir, `${name}.pid`) },
  ...extra,
});
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

async function scenario(
  label: string,
  exposure: "direct" | undefined,
  script: AssistantMessage[],
  verify: (run: Run, c: typeof check) => void,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codepal-mcp-"));
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  const home = path.join(tmp, "home");
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  writeJson(path.join(agentDir, "mcp.json"), { mcpServers: { echo: server(state, "echo", exposure ? { exposure } : {}) } });
  writeJson(path.join(cwd, ".pi", "mcp.json"), { mcpServers: { proj: server(state, "proj", { exposure: "direct" }) } });
  writeJson(path.join(home, ".pi", "agent", "mcp.json"), { mcpServers: { shadow: server(state, "shadow", { exposure: "direct" }) } });
  const realHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() -> the fake home, as pi's getAgentDir() would see it

  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(script);
  const events: UiEvent[] = [];
  const approvals: string[] = [];
  let settled!: () => void;
  const settledP = new Promise<void>((r) => { settled = r; });
  const c = (name: string, ok: boolean, detail?: string) => check(`[${label}] ${name}`, ok, detail);

  try {
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
      // No onProjectTrustRequest: the project folder stays untrusted.
      onApprovalRequest: async (req) => {
        const input = req.input as { text?: string; path?: string; command?: string; content?: string };
        approvals.push(`${req.toolName}:${input.text ?? input.path ?? input.command ?? ""}`);
        return JSON.stringify(input).includes("blocked") ? { approved: false, reason: "Denied by test" } : { approved: true };
      },
    });

    try {
      // Wait for the server's tools (and, for codemode exposure, the codemode tool) so a
      // connection failure is reported as such rather than as a confused model run.
      const deadline = Date.now() + 15_000;
      let names: string[] = [];
      while (Date.now() < deadline) {
        names = session.session.getAllTools().map((t) => t.name).filter((n) => n.startsWith("mcp__"));
        const ready = names.includes("mcp__echo__peek") && (exposure === "direct" || session.session.getActiveToolNames().includes("codemode"));
        if (ready) break;
        await sleep(100);
      }
      c("echo server connected, tools registered", names.includes("mcp__echo__echo") && names.includes("mcp__echo__peek"), names.join(", ") || "none");

      await session.send("Go.");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        settledP,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("run did not settle in 30 s")), 30_000); }),
      ]).finally(() => clearTimeout(timer));

      const callLog = path.join(state, "echo.calls.jsonl");
      const calls = fs.existsSync(callLog)
        ? fs.readFileSync(callLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
        : [];
      verify({ ends: events.filter((e): e is ToolEnd => e.type === "tool_end"), approvals, events, cwd, calls }, c);
      c("model got the final turn", events.some((e) => e.type === "text_end" && e.content.includes("done")));
      const all = session.session.getAllTools().map((t) => t.name);
      c("untrusted project's .pi/mcp.json did not start", !all.some((n) => n.startsWith("mcp__proj")) && !fs.existsSync(path.join(state, "proj.pid")));
      c("pi CLI's ~/.pi/agent/mcp.json was not read", !all.some((n) => n.startsWith("mcp__shadow")) && !fs.existsSync(path.join(state, "shadow.pid")));
    } finally {
      await session.dispose();
    }
  } catch (err) {
    c("run completed", false, String((err as Error).message ?? err));
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }

  const pidFile = path.join(state, "echo.pid");
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

/** The approval rule for MCP tools, common to both MCP scenarios. */
function mcpGateChecks(run: Run, c: typeof check) {
  c("echo asked for approval", run.approvals.some((a) => a.startsWith("mcp__echo__echo:") && !a.endsWith(":blocked")), run.approvals.join(" | "));
  c("peek (read-only) did not ask", !run.approvals.some((a) => a.startsWith("mcp__echo__peek")), run.approvals.join(" | "));
  c("denied echo asked, and never reached the server", run.approvals.includes("mcp__echo__echo:blocked") && !run.calls.some((x) => x.args?.text === "blocked"), JSON.stringify(run.calls));
}

// 1. direct: the model calls echo (approved) -> peek -> echo (denied) -> final text.
await scenario("direct", "direct", [
  fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "hello" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("mcp__echo__peek", {}), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("mcp__echo__echo", { text: "blocked" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("done")),
], (run, c) => {
  mcpGateChecks(run, c);
  const ok = run.ends.find((e) => e.toolName === "mcp__echo__echo" && !e.isError);
  const peek = run.ends.find((e) => e.toolName === "mcp__echo__peek");
  c("echo returned the server's result", ok?.text.includes("echo: hello") === true, ok?.text);
  c("peek returned its result", peek?.isError === false && peek.text.includes("peek ok"), peek?.text);
  c("denied echo ended as an error", run.ends.some((e) => e.toolName === "mcp__echo__echo" && e.isError));
});

// 2. codemode (pi's default exposure): one script calls echo, a denied echo, peek, and
// pi's write tool with content the test denies. Scripts receive an MCP tool's result as
// an object (its MCP content), so stringify it.
const code = `
const a = JSON.stringify(await tools.mcp__echo__echo({ text: "from script" }));
let denied = "no";
try { await tools.mcp__echo__echo({ text: "blocked" }); } catch (e) { denied = "yes"; }
const p = JSON.stringify(await tools.mcp__echo__peek({}));
let wrote = "no";
try { await tools.write({ path: "from-script.txt", content: "blocked" }); wrote = "yes"; } catch (e) { wrote = "denied"; }
return a + " | denied=" + denied + " | " + p + " | write=" + wrote;
`;
await scenario("codemode", undefined, [
  fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("done")),
], (run, c) => {
  mcpGateChecks(run, c);
  const t = run.ends.find((e) => e.toolName === "codemode")?.text ?? "";
  c("script got echo's result", t.includes("echo: from script"), t);
  c("script saw the denied call fail", t.includes("denied=yes"), t);
  c("script got peek's result", t.includes("peek ok"), t);
  c("script's write asked, was denied, wrote nothing",
    run.approvals.includes("write:from-script.txt") && t.includes("write=denied") && !fs.existsSync(path.join(run.cwd, "from-script.txt")), t);
});

// 3. builtin: pi's own write (approved) and bash (denied) still ask, as before MCP.
await scenario("builtin", "direct", [
  fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: "hello" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("bash", { command: "echo blocked > blocked.txt" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText("done")),
], (run, c) => {
  const note = path.join(run.cwd, "note.txt");
  c("write asked and wrote the file", run.approvals.includes("write:note.txt") && fs.existsSync(note) && fs.readFileSync(note, "utf8") === "hello", run.approvals.join(" | "));
  c("denied bash asked, ended as an error, ran nothing",
    run.approvals.includes("bash:echo blocked > blocked.txt") && run.ends.some((e) => e.toolName === "bash" && e.isError) && !fs.existsSync(path.join(run.cwd, "blocked.txt")), run.approvals.join(" | "));
});

for (const [name, ok, detail] of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `FAIL (${failed} of ${results.length})` : `PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
