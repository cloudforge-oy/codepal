// Runs the project's checks (.claude/checks.json) and writes the raw output as the test
// report for the current code state, plus the diff the reviewer subagent reads.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { git, reportsDir, root, stateId } from "./lib.mjs";

const { commands } = JSON.parse(fs.readFileSync(path.join(root, ".claude", "checks.json"), "utf8"));
let report = "";
let failed = 0;
const out = (s) => { report += s; process.stdout.write(s); };

for (const cmd of commands) {
  out(`\n$ ${cmd}\n`);
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  out((r.stdout ?? "") + (r.stderr ?? ""));
  const code = r.status ?? 1;
  if (code !== 0) failed++;
  out(`[exit ${code}]\n`);
}

const id = stateId();
let base = "origin/main";
try { git("rev-parse", "--verify", base); } catch { base = "main"; }
const head = git("rev-parse", "HEAD").trim();
// "clean" = nothing uncommitted or untracked, so the report describes exactly `head`.
const tree = git("status", "--porcelain").trim() === "" ? "clean" : "dirty";
const header =
  `test report ${id}\ndate: ${new Date().toISOString()}\nhead: ${head}\ntree: ${tree}\n` +
  `result: ${failed ? `FAIL (${failed} of ${commands.length} commands failed)` : "PASS"}\n`;

fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, `${id}.txt`), header + report);
// `git diff` skips untracked files, so new files are appended as additions.
let diff = git("diff", base);
for (const f of git("ls-files", "-o", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
  const r = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", f], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  diff += r.stdout ?? "";
}
fs.writeFileSync(path.join(reportsDir, `${id}.diff`), diff);
console.log(`\n${header}report: .claude/test-reports/${id}.txt\ndiff:   .claude/test-reports/${id}.diff (against ${base})`);
process.exit(failed ? 1 : 0);
