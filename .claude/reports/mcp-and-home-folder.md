# Report: home folder fallback + MCP engine (part 1 of the brief)

Brief: `.claude/briefs/mcp-and-home-folder.md`. Branch `mcp-servers`, not pushed.
Commits: `8206039` (start folder), `668ad6b` (MCP engine), `07e71a6` (fixes after review).

Delivered so far: the start-folder fallback and the MCP engine with approval. Not yet
built: the MCP panel, add-server form, Edit mcp.json, presets, resources/prompts, the
"needs sign-in" status, the 0.2.0 Store release.

## Tests

`node .claude/hooks/run-checks.mjs` at `07e71a6`, clean tree: PASS. Report
`.claude/test-reports/` (head 07e71a6…). `npm run test:mcp`: 30 checks in 3 scenarios
(direct, codemode, builtin): MCP calls ask except readOnlyHint tools, denials never reach
the server, codemode script calls ask (MCP and write), pi's write/bash still ask, an
untrusted project's `.pi/mcp.json` does not start, the pi CLI's `~/.pi/agent` is not read,
dispose stops the server. Mutation checks: disabling the MCP gate fails 3 checks;
removing `PI_CODING_AGENT_DIR` fails the `~/.pi/agent` check (and most others).
Also passes under Electron's Node (24.22.1, Electron 43.8.7).

Start folder: checked by launching the real app with a throwaway config (no saved folder
-> home; saved folder -> reopened; saved folder removed -> home). Not automated.

## Independent review (reviewer subagent, at 668ad6b)

Verdict: reject, because most of the brief is not built yet (expected: this is part 1)
and because it believed `os` was not imported in app/main.mjs (it is, line 17; the
reviewer only sees the diff). Fixed from its findings: servers left running when binding
fails; no test of pi's write/bash gate after the refactor; no test that untrusted
projects and `~/.pi/agent` stay out. Its "missed": Windows (npx without a shell, MSIX
redirection of userData, killing an npx -> node process tree), HTTP servers and
`${VAR}` headers untested, MCP file changes have no before/after diff, the renderer's
approval card never tested with MCP inputs, no type check in the project.

## Decisions (skeptic subagent argued each; user decides open ones)

1. Start folder: home as fallback (user's choice). Skeptic: home exposes the whole home
   folder to the agent's ungated read tools. Open.
2. pi's built-in MCP (user's choice). Cost: its server state is internal, and it does
   not support MCP prompts at all.
3. `PI_CODING_AGENT_DIR` set process-wide. Skeptic: leaks into the agent's bash children
   (a `pi` CLI run from the agent would use CodePal's dir). Kept: config/OAuth/log paths
   in pi all depend on it and the loader functions are not exported.
4. Codemode loaded, pi's default exposure kept. Skeptic: approval cards for calls from a
   script show without a visible link to the script; force "direct" instead. Open.
5. readOnlyHint trusted as the server declares (user's rule). Skeptic's top risk: a
   server can mislabel a writing tool. Open.
6. UI context: notices to chat, dialogs declined. Verified mode "rpc" only skips TUI paths.
7. dispose(): capped 5 s, used on every exit path, quit waits for it.
8. Test-only `provider` option on createCodepalSession; pi-ai 1.5.0 devDependency.
9. Panel status source: open (pi exposes no structured status).

## Exam

Not used (dropped by the user on 2026-11-13).
