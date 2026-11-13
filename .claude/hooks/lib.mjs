// Shared helpers for the verification hooks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const root =
  process.env.CLAUDE_PROJECT_DIR ||
  execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
export const reportsDir = path.join(root, ".claude", "test-reports");
export const sessionDir = path.join(root, ".claude", ".session");

// Paperwork that changes after the checks ran (reports, briefs) must not invalidate them.
const EXCLUDE = [":!.claude/reports", ":!.claude/briefs", ":!.claude/learning-log.md"];

export const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

/** Identifies the exact code state: HEAD + uncommitted changes + untracked files. */
export function stateId() {
  const h = createHash("sha256");
  h.update(git("rev-parse", "HEAD"));
  h.update(git("diff", "HEAD", "--binary", "--", ".", ...EXCLUDE));
  const untracked = git("ls-files", "-o", "--exclude-standard", "-z", "--", ".", ...EXCLUDE);
  for (const f of untracked.split("\0").filter(Boolean)) {
    h.update(f);
    try { h.update(fs.readFileSync(path.join(root, f))); } catch { /* vanished or unreadable */ }
  }
  return h.digest("hex").slice(0, 16);
}

export function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

export const sessionFile = (id) =>
  path.join(sessionDir, String(id || "unknown").replace(/[^\w-]/g, "_"));
