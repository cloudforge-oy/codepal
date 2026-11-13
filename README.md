# CodePal

Desktop coding agent: the [pi](https://pi.dev) agent (`@earendil-works/pi-coding-agent`)
talking to the cloudcode.one `/v1/messages` gateway, with a file explorer and the
[Monaco](https://microsoft.github.io/monaco-editor/) editor (VS Code's editor) beside the chat.

CodePal is the successor of [Harness](https://github.com/cloudforge-oy/harness), which ran
on `@cline/core` and had a chat window only. The two install side by side (different app
id, data folder and stored key).

## Layout

- `codepal-agent.ts` — pi session wiring: the cloudcode.one provider, the tool-approval
  extension, and the pi event → UI event mapping
- `codepal-smoke.ts` — live gateway smoke test for the agent module
- `app/` — Electron app
  - `main.mjs` — main process: hosts the pi session, workspace-confined file IPC for the
    editor, the `codepal://` scheme the UI is served from, the app menu
  - `portal-auth.mjs` — PKCE loopback flow that fetches the API key from the portal
  - `preload.cjs` — context-isolated bridge (`window.codepal`)
  - `renderer/` — the UI; `src/` is bundled by esbuild into `dist/`
    - `index.js` boot and layout · `explorer.js` file tree · `editor.js` Monaco tabs,
      save, diffs · `chat.js` agent chat · `connect.js` key dialog · `util.js`
- `scripts/build-renderer.mjs` — bundles the UI with Monaco (ESM) and its web workers
- `scripts/build-agent.mjs` — precompiles `codepal-agent.ts` for packaging

## Install on Windows

The Windows installer is **not code-signed**, so Windows warns about it:

- **SmartScreen** ("Windows protected your PC"): click *More info*, then *Run anyway*.
- **Smart App Control** ("...blocked an app that may be unsafe"): there is no *Run anyway*.
  Smart App Control is on mostly on freshly installed Windows 11 PCs
  (Windows Security > App & browser control > Smart App Control). If it is on, either:
  - install CodePal from the Microsoft Store (in preparation; Store apps are signed by
    Microsoft), or
  - run the Linux build under WSL, which Smart App Control does not affect:

    ```powershell
    wsl --install -d Ubuntu      # once, then restart Windows
    ```
    ```bash
    # inside Ubuntu: download codepal_<version>_amd64.deb from the Releases page, then
    sudo apt install ./codepal_*_amd64.deb
    codepal
    ```

    The window opens on the Windows desktop (WSLg). Your Windows drives are under
    `/mnt/c/...`; projects kept inside the Linux filesystem are faster.

Turning Smart App Control off also works, but on many Windows versions it cannot be turned
back on without resetting Windows, so that is your call, not something we recommend.

## Run

```bash
npm install
npm start                      # builds the renderer bundle, then launches
npm start -- ~/src/my-project  # open a specific folder
```

The app reopens the last folder; the folder chip in the top bar (or Ctrl+O) opens another.

Env: `CLOUDCODE_TOKEN` (otherwise the app offers the portal flow, as Harness did),
`CLOUDCODE_BASE_URL` (default `https://api.cloudcode.one`; a trailing `/v1` is accepted
and dropped — the Anthropic SDK inside pi adds `/v1/messages` itself), `CLOUDCODE_MODEL`,
`CLOUDCODE_PORTAL_URL` (default `https://cloudcode.one`).

Key handling is unchanged from Harness: **Connect with cloudcode.one** fetches the key
through the portal (PKCE + loopback) and stores it encrypted with Electron's
`safeStorage`; a pasted token lives in memory for that run only. pi reads the key from
`CLOUDCODE_TOKEN` at request time (`apiKey: "$CLOUDCODE_TOKEN"`), so a reconnect takes
effect on the next request — no new conversation needed — and pi never writes it to its
own `auth.json`.

Same caveats as Harness for development shells:

- launching from a shell with `ELECTRON_RUN_AS_NODE` set (e.g. a VS Code terminal):
  `env -u ELECTRON_RUN_AS_NODE npm start`
- Ubuntu 23.10+ aborting with "The SUID sandbox helper binary was found, but is not
  configured correctly": once per Electron install,
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`.
  Electron 43.8+ downloads its binary on first launch rather than at `npm install`,
  so run `npm start` once before applying this.

### UI development without a key

- `CODEPAL_DEMO=1` replays a canned agent run (thinking, a `write` approval, a diff);
  `CODEPAL_DEMO=auto` approves it by itself and really writes `hello.ts` into the folder.
- `CODEPAL_SCREENSHOT=/tmp/shot.png` captures the window and quits
  (`CODEPAL_SCREENSHOT_DELAY` ms, default 2500); `CODEPAL_THEME=dark|light` forces a theme.
- `node scripts/build-renderer.mjs --watch` rebuilds the UI on change (reload with
  View → Toggle Developer Tools → Ctrl+R in DevTools).

## Using it

**Editor.** Click a file in the explorer to open it in a tab. Ctrl+S saves, Ctrl+W
closes the tab; tabs show ● for unsaved changes. Monaco brings syntax highlighting for
~80 languages, IntelliSense for TS/JS/JSON/CSS/HTML, find/replace, multi-cursor, the
minimap and the command palette (F1).

**Agent.** The chat runs a pi session in the open folder with pi's built-in tools
(`read`, `bash`, `edit`, `write`). `bash`, `edit` and `write` ask first — pi itself never
prompts, so CodePal gates them through pi's `tool_call` extension event. For `edit` and
`write` the permission card has **Review diff**, which opens the proposed change in
Monaco's diff editor before you approve. "Yes, don't ask again" lasts for the conversation.

When the agent changes a file:

- an open, unmodified tab updates in place — as one undoable step, so Ctrl+Z reverts
  the agent's change;
- an open tab with unsaved edits is left alone and flagged ("changed on disk"), with
  *Reload from disk* / *Keep mine*;
- an unopened file opens in a new tab (without stealing focus if you're typing);
- the tool card gets **Open** and **Diff** (before/after of that change), and the file
  is marked in the explorer.

After `bash` runs, and when the window regains focus, open files are re-checked
against disk.

**Context.** The composer shows a chip for the open file; your selection is added when
there is one (`file.ts:10-24`). It is sent with the message as an `<editor-context>`
block, so "explain this" or "fix this function" works. Click the chip to leave it out.
Ctrl+L in the editor (or *Ask CodePal about this* in its context menu) jumps to the
chat with the selection attached.

**Steering.** While the agent works, Enter sends a *steering* message (read after the
current tool step) and Alt+Enter queues a *follow-up* (read when the run ends) — pi's
two queue modes. Stop aborts the run but keeps the conversation; **+** starts a new one.
The model can be switched mid-conversation.

| Shortcut | Action |
|---|---|
| Ctrl+S | Save |
| Ctrl+W | Close tab |
| Ctrl+O | Open folder |
| Ctrl+L | Ask about the selection |
| Ctrl+B / Ctrl+J | Toggle explorer / chat |
| Ctrl+Shift+N | New conversation |
| Enter / Alt+Enter (agent busy) | Steer / queue follow-up |

(Cmd instead of Ctrl on macOS. The app menu shows these shortcuts without registering
them, so Electron's default Ctrl+W = close window and Ctrl+R = reload can't throw away
unsaved editor state.)

## pi specifics

- **Config lives under the app**, not `~/.pi/agent`: `<userData>/pi-agent/` (Linux:
  `~/.config/CodePal/pi-agent/`) holds pi's `settings.json`, and is where user-level
  skills (`skills/`), prompt templates and extensions go. `AGENTS.md` / `CLAUDE.md` in the
  project are loaded as context.
- **Project trust is enforced.** pi's SDK treats every folder as trusted unless the host
  decides, so a cloned repo's `.pi/extensions/*.ts` would run the moment a conversation
  starts. CodePal decides like pi's CLI: when a folder has trust-requiring resources
  (`.pi/extensions`, `.pi/mcp.json`, `.pi/settings.json`, `.pi/skills`, `.pi/SYSTEM.md`,
  `.agents/skills`, …) it asks once — *Trust Folder* / *Don't Trust*, optionally
  remembered in `<userData>/pi-agent/trust.json` (delete the entry to be asked again).
  Not trusting still works; those resources are just skipped.
- **Conversations are in memory** (`SessionManager.inMemory`), like Harness. pi's
  compaction still kicks in near the context window (128k by default; a catalog entry
  can carry `context_window`).
- **Telemetry off by default.** pi's install telemetry and provider attribution headers
  default to on; CodePal sets `PI_TELEMETRY=0` unless you set it yourself.
- **No `thinking` parameter is sent** (models are registered with `reasoning: false`).
  GLM thinks on every turn anyway and the gateway enables z.ai's preserved thinking per
  deployment; pi parses the streamed thinking blocks with their signatures and replays
  them verbatim on later turns. Harness needed a postinstall patch for that
  (`patch-cline-thinking.mjs`); pi does it natively, and CodePal has no patches at all.

## Testing

```bash
npm run smoke                        # without a token: expects the gateway's 401
CLOUDCODE_TOKEN=sk-... npm run smoke # live: write + read a file through approvals
npm run smoke -- --model glm-5.3
```

The live run checks streaming, the approval gate, the before/after snapshot on `write`,
usage reporting and the file on disk.

## Packaging

```bash
npm run dist:linux   # dist/codepal_<version>_amd64.deb
npm run dist:win     # dist/CodePal-<version>-win.zip + dist/CodePal-Setup-<version>.exe
npm run dist:mac     # dist/CodePal-<version>-arm64.dmg + dist/CodePal-<version>-x64.dmg
```

Each first runs `npm run build`: `codepal-agent.ts` is compiled to plain JS (so the
packaged app needs no tsx/esbuild, whose native binaries are platform-specific) and the
renderer is bundled. Monaco is bundled into `app/renderer/dist`, so `monaco-editor` is a
devDependency and its ~100 MB of sources stay out of the package.

### Windows builds and the Microsoft Store

`.github/workflows/windows.yml` (run it manually, or on a `v*` tag) builds two things:

- the NSIS installer and the portable zip, **unsigned** (same as `npm run dist:win`);
- an MSIX package for the Microsoft Store (`npm run dist:store`, Windows only). The Store
  signs the package itself, so no code-signing certificate is needed. The package
  identity in `package.json` (`build.appx`) is the one Partner Center assigned to
  CloudForge Oy's "CodePal" (Store ID `9P65BRV593VW`); the `APPX_IDENTITY_NAME` and
  `APPX_PUBLISHER` repository variables can override it. Tile images live in `build/appx/` (regenerate with
  `npx electron scripts/build-appx-assets.mjs`).

The Windows installer (NSIS, built without wine) and the macOS DMGs (ad-hoc signed,
built in Docker on Linux) work exactly as in Harness — see `scripts/build-win-installer.mjs`
and `scripts/build-mac-dmg.mjs`. Like Harness, packages exclude the
`@anthropic-ai/claude-agent-sdk-*` / `@openai/codex-*` native CLIs if anything pulls them in.

## Privacy

CodePal sends nothing anywhere unless you ask it to. Your prompts, and the files the agent
reads, go to the cloudcode.one gateway you connect it to; pi's telemetry is off by default
(see *pi specifics*).

## License

[MIT](LICENSE) © CloudForge Oy
