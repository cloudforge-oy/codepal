/**
 * Live smoke test for codepal-agent.ts against the cloudcode.one gateway.
 *
 *   CLOUDCODE_TOKEN=sk-... npm run smoke [-- --model glm-4.7-flash]
 *
 * Runs one pi session in a throwaway folder: the model is asked to create a file with
 * the write tool (approved automatically here) and then read it back. Checks that the
 * session streams text, that the approval gate fires for write, that the tool_end event
 * carries a before/after snapshot, and that usage arrives. Without a token it still runs
 * and expects the gateway's 401 — which proves the provider wiring and URL are right.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodepalSession, type CloudcodeModel, type UiEvent } from "./codepal-agent.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const portal = (process.env.CLOUDCODE_PORTAL_URL ?? "https://cloudcode.one").replace(/\/+$/, "");
const catalogRes = await fetch(`${portal}/models.json`);
if (!catalogRes.ok) throw new Error(`models.json: HTTP ${catalogRes.status}`);
const catalog = (await catalogRes.json()) as { models: CloudcodeModel[] };
const model = arg("model") ?? process.env.CLOUDCODE_MODEL ?? "glm-4.7-flash";
const hasToken = Boolean(process.env.CLOUDCODE_TOKEN);
if (!hasToken) process.env.CLOUDCODE_TOKEN = "sk-invalid-smoke-test";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "codepal-smoke-"));
const agentDir = path.join(work, ".agent");
console.log(`model ${model} · cwd ${work} · ${hasToken ? "live token" : "no token (expecting 401)"}`);

const seen = new Set<string>();
let approvals = 0;
let errors: string[] = [];
let fileEvent: UiEvent | undefined;

let markSettled = () => {};
const settled = new Promise<void>((resolve, reject) => {
  markSettled = resolve;
  setTimeout(() => reject(new Error("timed out after 3 minutes")), 180_000).unref();
});

const session = await createCodepalSession({
  cwd: work,
  agentDir,
  model,
  models: catalog.models,
  appendSystemPrompt: "You are running inside an automated smoke test. Be brief.",
  onApprovalRequest: async (req) => {
    approvals++;
    console.log(`  approval? ${req.toolName} ${JSON.stringify(req.input).slice(0, 100)} -> yes`);
    return { approved: true };
  },
  onEvent: (e) => {
    seen.add(e.type);
    switch (e.type) {
      case "text_delta": process.stdout.write(e.delta); break;
      case "text_end": process.stdout.write("\n"); break;
      case "tool_start": console.log(`  tool ${e.toolName}(${JSON.stringify(e.args).slice(0, 100)})`); break;
      case "tool_end":
        console.log(`  tool ${e.toolName} done${e.isError ? " (error)" : ""}: ${e.text.slice(0, 100).replace(/\n/g, " ")}`);
        if (e.file) fileEvent = e;
        break;
      case "usage": console.log(`  usage ↑${e.input} ↓${e.output} $${e.cost.toFixed(5)}`); break;
      case "error": errors.push(e.message); console.log(`  error: ${e.message}`); break;
      case "notice": console.log(`  notice: ${e.message}`); break;
      case "settled": markSettled(); break;
    }
  },
});

try {
  await session.send(
    "Use the write tool to create hello.txt containing exactly the line `hi from codepal`, " +
    "then use the read tool to read it back, then answer DONE.",
  );
  await settled;
} catch (err) {
  errors.push(String((err as Error).message ?? err));
  console.log(`  error: ${errors.at(-1)}`);
} finally {
  session.dispose();
}

const checks: [string, boolean][] = hasToken
  ? [
      ["text streamed", seen.has("text_delta")],
      ["usage reported", seen.has("usage")],
      ["write gated by approval", approvals > 0],
      ["tool_end carries a file snapshot", fileEvent?.type === "tool_end" && fileEvent.file?.after?.includes("hi from codepal") === true],
      ["file written", fs.existsSync(path.join(work, "hello.txt"))],
      ["no errors", errors.length === 0],
    ]
  : [["gateway answered 401 (auth reached /v1/messages)", errors.some((m) => /401|auth|invalid|unauthor/i.test(m))]];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  ok &&= pass;
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
