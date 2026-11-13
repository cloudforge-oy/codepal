// Stop: Claude may not finish while the code differs from the session's starting state
// and no test report exists for exactly the current state.
import fs from "node:fs";
import path from "node:path";
import { git, readStdin, reportsDir, sessionFile, stateId } from "./lib.mjs";

const input = readStdin();
const id = stateId();
const baseline = sessionFile(input.session_id);

if (fs.existsSync(baseline) && fs.readFileSync(baseline, "utf8").trim() === id) process.exit(0);
if (fs.existsSync(path.join(reportsDir, `${id}.txt`))) process.exit(0);

if (!fs.existsSync(baseline)) {
  // No baseline (hooks were installed mid-session): nothing to verify if the tree is
  // clean and everything is already on origin/main.
  try {
    const clean = git("status", "--porcelain").trim() === "";
    git("merge-base", "--is-ancestor", "HEAD", "origin/main");
    if (clean) process.exit(0);
  } catch { /* not an ancestor: fall through and block */ }
}

console.log(JSON.stringify({
  decision: "block",
  reason:
    `No test report exists for the current code state (${id}). ` +
    "Run `node .claude/hooks/run-checks.mjs`, read its output, and show the user the exact " +
    "commands and raw results before any summary. A failing report still lets you stop, " +
    "but you must say plainly that the checks failed.",
}));
