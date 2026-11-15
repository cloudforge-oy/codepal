# Report: home folder fallback, MCP engine and MCP panel

Brief: `.claude/briefs/mcp-and-home-folder.md`. Branch `mcp-servers`, not pushed.
Commits: `8206039` (start folder), `668ad6b` (MCP engine), `07e71a6` (fixes after review),
`6ab058f` (readOnlyHint only for the user's own servers), `3b06931` (MCP panel),
`6224137` (mcp.json tab kept out of chat context).

Delivered: everything in the brief except the 0.2.0 Store release (needs the user's go,
since it publishes). Resources/prompts browsing was dropped by decision.

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

## Part 2: the MCP panel (after the review)

`npm run test:unit` (11 tests of app/mcp-config.mjs: validation, atomic edits, a file
with a syntax error is never overwritten, status merge, presets) and `npm run test:mcp`
now 40 checks (adds mcpStatus with a connected and a broken server, and the chat notice
pointing at the panel). Checked in the real app with screenshots (light and dark): status
rows (connected with tools, failed with error, disabled), the form with presets and a
validation error, a preset saved through the UI (written with exposure direct), Edit
mcp.json as an editor tab. Not checked: the approval card rendering MCP inputs in the
renderer (needs a live model), anything on Windows.

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
   script show without a visible link to the script; force "direct" instead. Decided: see 11.
5. readOnlyHint trusted as the server declares (user's rule). Skeptic's top risk: a
   server can mislabel a writing tool. Decided: see 10.
6. UI context: notices to chat, dialogs declined. Verified mode "rpc" only skips TUI paths.
7. dispose(): capped 5 s, used on every exit path, quit waits for it.
8. Test-only `provider` option on createCodepalSession; pi-ai 1.5.0 devDependency.
9. Panel status: from pi's registered tools + pi's startup "need attention" notice +
   mcp.json (user's choice "status + tools only"). Parsing that notice is tied to pi
   1.5.0's wording; pi is pinned exactly, and test:mcp fails if it changes.
10. readOnlyHint trusted only for servers in CodePal's own mcp.json (user's choice).
11. Form-added servers use direct exposure (user's choice).

## Exam

Not used (dropped by the user on 2026-11-13).
