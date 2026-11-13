// PreToolUse (Bash): Claude does not push and does not skip git hooks. Pushing is the
// user's step (`! git push`), and it goes through .githooks/pre-push.
import { readStdin } from "./lib.mjs";

const cmd = String(readStdin().tool_input?.command ?? "");
const rules = [
  [/\bgit\b(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/, "git push is blocked for Claude in this repo. The user pushes themselves (`! git push`)."],
  [/\bgit\b[\s\S]*--no-verify\b/, "--no-verify is blocked: git hooks are never skipped."],
  [/\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*\s-[a-mo-zA-Z]*n[a-zA-Z]*(?=\s|$)/, "git commit -n (no-verify) is blocked: git hooks are never skipped."],
  [/core\.hooksPath/i, "Changing core.hooksPath is blocked: it would disable the pre-push gate."],
];
for (const [re, why] of rules) {
  if (re.test(cmd)) {
    console.error(`Blocked by .claude/hooks/guard-bash.mjs: ${why}`);
    process.exit(2);
  }
}
