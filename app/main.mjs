/**
 * Electron main process for CodePal.
 *
 * Hosts the pi agent session (codepal-agent.ts) and the workspace file access the
 * editor needs, and bridges both to the renderer:
 *   - session:send / session:abort / session:reset / session:set-model   (invoke)
 *   - session:event                          (main -> renderer stream of UiEvents)
 *   - approval:request / approval:respond    (tool-approval round trip)
 *   - fs:list / fs:read / fs:write / fs:stat / fs:create   (workspace-confined)
 *
 * The UI is served from a privileged codepal:// scheme rather than file:// — Monaco
 * starts its language services in web workers, which Chromium won't load from file://.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelPortalAuth, fetchApiKeyFromPortal } from "./portal-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, "renderer");

// macOS apps launched from Finder/Dock get launchd's minimal PATH and cwd "/". Borrow
// PATH from the login shell so the agent's bash tool finds Homebrew/nvm tools.
if (process.platform === "darwin" && app.isPackaged) {
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    });
    const shellPath = out.match(/__PATH__(.*)__PATH__/)?.[1];
    if (shellPath) process.env.PATH = shellPath;
  } catch { /* keep launchd's PATH */ }
  if (process.cwd() === "/") process.chdir(os.homedir());
}

protocol.registerSchemesAsPrivileged([
  { scheme: "codepal", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const PORTAL_BASE = (process.env.CLOUDCODE_PORTAL_URL ?? "https://cloudcode.one").replace(/\/+$/, "");

// Bundled snapshot of https://cloudcode.one/models.json (2026-11-06), used until the
// live fetch succeeds (offline, portal down). Prices are USD per 1M tokens.
const FALLBACK_CATALOG = {
  currency: "USD",
  unit: "per 1M tokens",
  image_surcharge_usd: 0.02,
  models: [
    { id: "deepseek-v4-pro", blurb: "Main coding model · 1M context", input: 1.705, output: 5.115, cached_input: 0.0568, free: false, vision: false },
    { id: "deepseek-v4.1-flash", blurb: "Fast subagents · haiku tier · 1M context", input: 0.27, output: 1.08, cached_input: 0.0054, free: false, vision: false },
    { id: "glm-5v-turbo", blurb: "Vision", input: 2.4, output: 8.0, cached_input: 0.48, free: false, vision: true },
    { id: "glm-5.3", blurb: "Flagship coding agent · 1M context", input: 1.26, output: 3.96, cached_input: 0.234, free: false, vision: false },
    { id: "glm-5.3-flash", blurb: "Vision + reasoning · 1M context", input: 0.165, output: 0.55, cached_input: 0.033, free: false, vision: true },
    { id: "glm-4.7-flash", blurb: "Fast · free tier", input: 0, output: 0, cached_input: null, free: true, vision: false },
  ],
};

let liveCatalog = null;   // last successful models.json fetch
let catalogFetch = null;  // in-flight fetch, so concurrent callers share it

async function loadCatalog() {
  if (liveCatalog) return liveCatalog;
  catalogFetch ??= (async () => {
    try {
      const res = await fetch(`${PORTAL_BASE}/models.json`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data?.models) || !data.models.every((m) => typeof m?.id === "string")) {
        throw new Error("malformed models.json");
      }
      liveCatalog = data;
    } catch (err) {
      console.warn(`models.json fetch failed (${err.message}); using bundled catalog`);
    } finally {
      catalogFetch = null; // a failed fetch retries on the next call
    }
  })();
  await catalogFetch;
  return liveCatalog ?? FALLBACK_CATALOG;
}

// Appended to pi's own system prompt, which already documents the tools.
const APPEND_SYSTEM_PROMPT = [
  "You are CodePal, a coding agent inside a desktop app that pairs this chat with a code editor.",
  "The user's workspace is the current working directory; files you create or change open",
  "in their editor, so keep edits focused. A user message may end with an <editor-context>",
  "block naming the file they have open and any text they selected — treat it as what",
  '"this file" or "this code" refers to. Be direct and concise.',
].join(" ");

let win = null;
let agentPromise = null;
let sessionPromise = null;  // in-flight or ready CodepalSession
let approvalSeq = 0;
const pendingApprovals = new Map(); // id -> resolve({ approved, reason })

// ---------------------------------------------------------------------------
// App state — the workspace folder survives restarts.
// ---------------------------------------------------------------------------
const statePath = () => path.join(app.getPath("userData"), "state.json");
const agentDir = () => path.join(app.getPath("userData"), "pi-agent");

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2)); } catch { /* best effort */ }
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** `codepal <folder>` (packaged) / `electron . <folder>` (dev) opens that folder;
 *  otherwise the last workspace, otherwise the launch directory. */
function initialWorkspace() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  const fromArgs = args.map((a) => path.resolve(a)).find(isDir);
  if (fromArgs) return fromArgs;
  const last = readState().workspace;
  if (last && isDir(last)) return last;
  return process.cwd();
}

let workspaceRoot = process.cwd();

function setWorkspace(dir) {
  workspaceRoot = path.resolve(dir);
  // Parts of the agent stack resolve against process.cwd(); keep it aligned.
  try { process.chdir(workspaceRoot); } catch { /* folder gone — the session still gets cwd */ }
  writeState({ workspace: workspaceRoot });
}

/** Absolute path inside the workspace, or throw. The renderer only reaches the files
 *  of the folder the user opened. */
function inWorkspace(p) {
  const abs = path.resolve(workspaceRoot, String(p ?? "."));
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`Outside the workspace: ${abs}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Agent module — precompiled JS when packaged (scripts/build-agent.mjs); dev
// compiles the TS on the fly with tsx, which stays out of the packaged app.
// ---------------------------------------------------------------------------
const getAgent = () => (agentPromise ??= loadAgent());

async function loadAgent() {
  const base = path.join(__dirname, "..");
  if (app.isPackaged) return import(pathToFileURL(path.join(base, "codepal-agent.js")).href);
  const { register } = await import("tsx/esm/api");
  register();
  return import(pathToFileURL(path.join(base, "codepal-agent.ts")).href);
}

const toRenderer = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// Only the app's own pages (codepal://app/) may reach file access, keys and the agent.
const trusted = (e) =>
  e.sender === win?.webContents && String(e.senderFrame?.url ?? "").startsWith("codepal://app/");
const handle = (channel, fn) =>
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error(`Untrusted sender for ${channel}`);
    return fn(e, ...args);
  });
const on = (channel, fn) =>
  ipcMain.on(channel, (e, ...args) => { if (trusted(e)) fn(e, ...args); });

function denyAllPending(reason) {
  for (const resolve of pendingApprovals.values()) resolve({ approved: false, reason });
  pendingApprovals.clear();
  toRenderer("approval:cancelled", null);
}

async function closeSession() {
  denyAllPending("Session closed");
  const p = sessionPromise;
  sessionPromise = null;
  if (!p) return;
  try {
    const s = await p;
    await s.abort().catch(() => {});
    s.dispose();
  } catch { /* creation failed — nothing to close */ }
}

function getSession(model) {
  sessionPromise ??= (async () => {
    const [agent, catalog] = await Promise.all([getAgent(), loadCatalog()]);
    return agent.createCodepalSession({
      cwd: workspaceRoot,
      agentDir: agentDir(),
      model,
      models: catalog.models,
      appendSystemPrompt: APPEND_SYSTEM_PROMPT,
      onEvent: (event) => toRenderer("session:event", event),
      onProjectTrustRequest: async (cwd) => {
        const res = await dialog.showMessageBox(win, {
          type: "warning",
          title: "Trust this folder?",
          message: `Trust the pi project resources in ${path.basename(cwd)}?`,
          detail:
            "This folder has a .pi directory (or .agents/skills) with resources the agent loads: " +
            "extensions run as code on your machine, and settings, MCP servers, skills and " +
            "system-prompt files change what the agent does. Only trust folders whose contents you trust.\n\n" +
            "Not trusting still lets CodePal work here — it just skips those resources.",
          buttons: ["Don't Trust", "Trust Folder"],
          defaultId: 0,
          cancelId: 0,
          checkboxLabel: "Remember for this folder",
          checkboxChecked: true,
        });
        return { trusted: res.response === 1, remember: res.checkboxChecked };
      },
      onApprovalRequest: (req) =>
        new Promise((resolve) => {
          const id = `approval-${++approvalSeq}`;
          pendingApprovals.set(id, resolve);
          toRenderer("approval:request", { id, ...req });
        }),
    });
  })();
  // A failed creation must not wedge every later send.
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

// ---------------------------------------------------------------------------
// Portal key storage — keys fetched from the portal persist across runs via
// safeStorage (OS keychain backed). Manually pasted tokens are NOT persisted.
// ---------------------------------------------------------------------------
const keyFilePath = () => path.join(app.getPath("userData"), "cloudcode-key.bin");

// An externally set CLOUDCODE_TOKEN is back on the next launch, so "forget key"
// can only clear it for this run — the renderer says so when that's the case.
const ENV_TOKEN_AT_LAUNCH = Boolean(process.env.CLOUDCODE_TOKEN);

function loadStoredKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(keyFilePath()));
  } catch {
    return null;
  }
}

function storeKey(key) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(keyFilePath(), safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function forgetStoredKey() {
  try { fs.rmSync(keyFilePath(), { force: true }); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Window + codepal:// protocol
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function registerAppProtocol() {
  protocol.handle("codepal", async (req) => {
    const url = new URL(req.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(url.pathname)));
    if (url.host !== "app" || !file.startsWith(RENDERER_DIR + path.sep)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

// CODEPAL_THEME=dark|light forces the theme (useful with CODEPAL_SCREENSHOT).
if (process.env.CODEPAL_THEME) nativeTheme.themeSource = process.env.CODEPAL_THEME;

/** Electron's default menu binds Ctrl+W to close the window and Ctrl+R to reload —
 *  both would throw away unsaved editor state. This menu shows the editor's shortcuts
 *  without registering them (registerAccelerator:false, Linux/Windows; macOS hands keys
 *  to the page first anyway), so keystrokes reach the renderer, which runs them;
 *  clicking an item sends the same command over IPC. */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const cmd = (label, accelerator, command) => ({
    label, accelerator, registerAccelerator: false, click: () => toRenderer("menu:command", command),
  });
  const quiet = (item) => ({ ...item, registerAccelerator: false });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        cmd("Open Folder…", "CmdOrCtrl+O", "open-folder"),
        cmd("Save", "CmdOrCtrl+S", "save"),
        cmd("Close Tab", "CmdOrCtrl+W", "close-tab"),
        { type: "separator" },
        isMac ? { role: "close", accelerator: "Shift+Cmd+W" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: ["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"].map((role) =>
        role === "separator" ? { type: "separator" } : quiet({ role })),
    },
    {
      label: "View",
      submenu: [
        cmd("Toggle Explorer", "CmdOrCtrl+B", "toggle-explorer"),
        cmd("Toggle Chat", "CmdOrCtrl+J", "toggle-chat"),
        cmd("New Conversation", "CmdOrCtrl+Shift+N", "new-conversation"),
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, ...(isMac ? [{ role: "zoom" }, { role: "front" }] : [])] },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    title: "CodePal",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL("codepal://app/index.html");
  win.on("closed", () => { win = null; });

  // Dev: surface renderer warnings/errors (e.g. a Monaco worker failing to load).
  if (!app.isPackaged) {
    win.webContents.on("console-message", ({ level, message, sourceId, lineNumber }) => {
      if (level === "warning" || level === "error") console.error(`[renderer ${level}] ${message} (${sourceId}:${lineNumber})`);
    });
  }

  // Links in chat/markdown open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("codepal://app/")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // UI dev without a gateway token: CODEPAL_DEMO=1 replays a canned event stream.
  if (process.env.CODEPAL_DEMO) {
    win.webContents.once("did-finish-load", () => setTimeout(replayDemo, 800));
  }

  // Headless UI check: CODEPAL_SCREENSHOT=/path.png captures the window and exits.
  if (process.env.CODEPAL_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        await fs.promises.writeFile(process.env.CODEPAL_SCREENSHOT, image.toPNG());
        app.quit();
      }, Number(process.env.CODEPAL_SCREENSHOT_DELAY ?? 2500));
    });
  }
}

// ---------------------------------------------------------------------------
// IPC — app / connection
// ---------------------------------------------------------------------------
handle("app:info", async () => {
  const catalog = await loadCatalog();
  const ids = catalog.models.map((m) => m.id);
  const wanted = process.env.CLOUDCODE_MODEL ?? readState().model;
  return {
    workspace: workspaceRoot,
    home: os.homedir(),
    platform: process.platform,
    models: catalog.models,
    defaultModel: ids.includes(wanted) ? wanted : ids[0],
    portalBase: PORTAL_BASE,
    hasToken: Boolean(process.env.CLOUDCODE_TOKEN),
    demo: Boolean(process.env.CODEPAL_DEMO),
  };
});

// Account balance from the portal; null when there's no token or the fetch fails.
handle("app:balance", async () => {
  const token = process.env.CLOUDCODE_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${PORTAL_BASE}/api/balance`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    // A rotated or revoked key surfaces here first — let the renderer prompt a reconnect.
    if (res.status === 401 || res.status === 403) return { error: "unauthorized" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data?.balance !== "number" || typeof data?.used !== "number") {
      throw new TypeError("malformed balance response");
    }
    return { currency: data.currency ?? "USD", balance: data.balance, used: data.used };
  } catch (err) {
    console.warn(`balance fetch failed (${err.message})`);
    return null;
  }
});

// Token entered in the UI lives in this process's env only — never written to disk.
// pi reads it at request time ("$CLOUDCODE_TOKEN"), so a live session picks it up.
handle("app:set-token", (_e, token) => {
  const value = String(token ?? "").trim();
  if (value) process.env.CLOUDCODE_TOKEN = value;
  return { hasToken: Boolean(process.env.CLOUDCODE_TOKEN) };
});

handle("app:clear-token", () => {
  forgetStoredKey();
  delete process.env.CLOUDCODE_TOKEN;
  return { hasToken: false, envTokenReturnsOnRestart: ENV_TOKEN_AT_LAUNCH };
});

handle("app:portal-connect", async () => {
  try {
    const key = await fetchApiKeyFromPortal({
      portalBase: PORTAL_BASE,
      openExternal: (url) => shell.openExternal(url),
    });
    process.env.CLOUDCODE_TOKEN = key;
    return { ok: true, hasToken: true, stored: storeKey(key) };
  } catch (err) {
    return { ok: false, error: err.code ?? "unknown", message: err.message };
  }
});

on("app:portal-cancel", () => cancelPortalAuth("Cancelled by user"));
on("app:open-dashboard", () => shell.openExternal(`${PORTAL_BASE}/dashboard`));

// ---------------------------------------------------------------------------
// IPC — workspace
// ---------------------------------------------------------------------------
handle("workspace:open", async () => {
  const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"], defaultPath: workspaceRoot });
  if (res.canceled) return null;
  await closeSession(); // the agent's cwd is fixed per session
  setWorkspace(res.filePaths[0]);
  return workspaceRoot;
});

const HIDDEN = new Set([".git", ".DS_Store", "Thumbs.db"]);
const MAX_OPEN_BYTES = 5 * 1024 * 1024;

handle("fs:list", async (_e, dir) => {
  const abs = inWorkspace(dir);
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  return entries
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => {
      let isDirectory = d.isDirectory();
      if (d.isSymbolicLink()) isDirectory = isDir(path.join(abs, d.name));
      return { name: d.name, path: path.join(abs, d.name), dir: isDirectory };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
});

handle("fs:read", async (_e, file) => {
  const abs = inWorkspace(file);
  const st = await fs.promises.stat(abs);
  if (st.size > MAX_OPEN_BYTES) return { tooLarge: true, size: st.size, mtimeMs: st.mtimeMs };
  const buf = await fs.promises.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size, mtimeMs: st.mtimeMs };
  return { content: buf.toString("utf8"), mtimeMs: st.mtimeMs };
});

handle("fs:write", async (_e, file, content) => {
  const abs = inWorkspace(file);
  await fs.promises.writeFile(abs, String(content), "utf8");
  return { mtimeMs: (await fs.promises.stat(abs)).mtimeMs };
});

handle("fs:stat", async (_e, file) => {
  try {
    const st = await fs.promises.stat(inWorkspace(file));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // deleted (or outside the workspace)
  }
});

handle("fs:create", async (_e, file, kind) => {
  const abs = inWorkspace(file);
  if (fs.existsSync(abs)) throw new Error(`${path.basename(abs)} already exists`);
  if (kind === "dir") await fs.promises.mkdir(abs, { recursive: true });
  else {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, "", { flag: "wx" });
  }
  return abs;
});

// ---------------------------------------------------------------------------
// IPC — agent session
// ---------------------------------------------------------------------------
handle("session:send", async (_e, { prompt, images, model, whileBusy }) => {
  const session = await getSession(model);
  return session.send(String(prompt ?? ""), images ?? [], whileBusy === "followUp" ? "followUp" : "steer");
});

// Stop the current run but keep the conversation. Pending approvals are denied first —
// an abort waits for the tool_call handler, which is waiting for the user.
handle("session:abort", async () => {
  denyAllPending("Interrupted by the user");
  const s = await sessionPromise?.catch(() => null);
  await s?.abort();
  return { ok: true };
});

handle("session:reset", async () => {
  await closeSession();
  return { ok: true };
});

handle("session:set-model", async (_e, id) => {
  writeState({ model: id });
  const s = await sessionPromise?.catch(() => null);
  if (s) await s.setModel(id);
  return { ok: true };
});

on("approval:respond", (_e, { id, approved, reason }) => {
  const resolve = pendingApprovals.get(id);
  if (!resolve) return;
  pendingApprovals.delete(id);
  resolve({ approved, reason });
});

// ---------------------------------------------------------------------------
// Demo stream — synthetic UiEvents so the UI can be exercised without a gateway
// token (CODEPAL_DEMO=1). With CODEPAL_DEMO=auto (or CODEPAL_DEMO_WRITE=1) the
// approved write really creates hello.ts in the workspace.
// ---------------------------------------------------------------------------
async function replayDemo() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = (event) => toRenderer("session:event", event);
  const demoFile = path.join(workspaceRoot, "hello.ts");
  const before = fs.existsSync(demoFile) ? fs.readFileSync(demoFile, "utf8") : "";
  const after = `export function hello(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nconsole.log(hello("CodePal"));\n`;

  toRenderer("demo:user", "Add a hello() helper in hello.ts and log a greeting.");
  await sleep(300);
  ev({ type: "thinking_start" });
  ev({ type: "thinking_delta", delta: "The user wants a small helper. I'll write hello.ts with a typed function." });
  await sleep(300);
  ev({ type: "thinking_end", content: "The user wants a small helper. I'll write hello.ts with a typed function." });
  ev({ type: "text_start" });
  ev({ type: "text_delta", delta: "I'll create `hello.ts` with a typed helper." });
  ev({ type: "text_end", content: "I'll create `hello.ts` with a typed helper." });
  const args = { path: "hello.ts", content: after };
  const approved = await new Promise((resolve) => {
    const id = `approval-${++approvalSeq}`;
    pendingApprovals.set(id, (d) => resolve(d.approved));
    toRenderer("approval:request", { id, toolCallId: "t1", toolName: "write", input: args });
    // CODEPAL_DEMO=auto approves by itself (headless screenshots).
    if (process.env.CODEPAL_DEMO === "auto") setTimeout(() => pendingApprovals.get(id)?.({ approved: true }), 900);
  });
  pendingApprovals.clear();
  ev({ type: "tool_start", toolCallId: "t1", toolName: "write", args });
  await sleep(200);
  const writes = process.env.CODEPAL_DEMO === "auto" || process.env.CODEPAL_DEMO_WRITE;
  if (approved && writes) fs.writeFileSync(demoFile, after);
  ev({
    type: "tool_end", toolCallId: "t1", toolName: "write", isError: !approved, durationMs: 12,
    text: approved ? "Successfully wrote 6 lines to hello.ts" : "Denied by the user",
    ...(approved ? { file: { path: demoFile, before, after, line: 1 } } : {}),
  });
  await sleep(300);
  const md = "Done. `hello.ts` now exports:\n\n```ts\nhello(name: string): string\n```\n\nRun it with `npx tsx hello.ts`.";
  ev({ type: "text_start" });
  ev({ type: "text_delta", delta: md });
  ev({ type: "text_end", content: md });
  ev({ type: "usage", model: "glm-4.7-flash", input: 1812, output: 164, cacheRead: 0, cacheWrite: 0, cost: 0 });
  ev({ type: "settled", aborted: false });
}

// ---------------------------------------------------------------------------
// NOTE: must stay a .then() chain — Electron emits "ready" only after the main
// module finishes evaluating, so a top-level `await app.whenReady()` deadlocks.
app.whenReady().then(() => {
  // safeStorage needs the app to be ready; env still wins over the stored key.
  if (!process.env.CLOUDCODE_TOKEN) {
    const stored = loadStoredKey();
    if (stored) process.env.CLOUDCODE_TOKEN = stored;
  }
  setWorkspace(initialWorkspace());
  registerAppProtocol();
  buildMenu();
  loadCatalog(); // warm the model catalog so app:info doesn't wait on the network
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  denyAllPending("App quitting");
  cancelPortalAuth("App quitting");
  sessionPromise?.then((s) => s.dispose()).catch(() => {});
});
