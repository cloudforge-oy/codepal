// CodePal renderer entry: wires the explorer, the Monaco editor and the pi chat together.
import { createChat } from "./chat.js";
import { createConnect } from "./connect.js";
import { createEditor } from "./editor.js";
import { createExplorer } from "./explorer.js";
import { $, tildify } from "./util.js";

const api = window.codepal;

const app = {
  root: "",
  home: "",
  balance: null,  // { balance, used } from the portal
  totals: null,   // token/cost totals of this conversation
};

// ---------------------------------------------------------------- status bar
function renderUsage() {
  const parts = [];
  const t = app.totals;
  if (t) {
    const k = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    parts.push(`↑${k(t.input)} ↓${k(t.output)}${t.cost ? ` · $${t.cost.toFixed(4)}` : ""}`);
  }
  if (app.balance) parts.push(`$${app.balance.balance.toFixed(2)} balance`);
  $("sb-usage").textContent = parts.join(" · ");
}

async function refreshBalance() {
  const res = await api.balance().catch(() => null);
  if (res?.error === "unauthorized") connect.setRejected(true);
  else if (res) connect.setRejected(false);
  app.balance = typeof res?.balance === "number" ? res : null;
  renderUsage();
}

// ---------------------------------------------------------------- panes
const LAYOUT_KEY = "codepal-layout";
const layout = (() => {
  try { return { explorer: 240, chat: 440, noExplorer: false, noChat: false, ...JSON.parse(localStorage.getItem(LAYOUT_KEY)) }; }
  catch { return { explorer: 240, chat: 440, noExplorer: false, noChat: false }; }
})();
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ } };

function applyLayout() {
  document.documentElement.style.setProperty("--explorer-w", `${layout.explorer}px`);
  document.documentElement.style.setProperty("--chat-w", `${layout.chat}px`);
  document.body.classList.toggle("no-explorer", layout.noExplorer);
  document.body.classList.toggle("no-chat", layout.noChat);
  $("toggle-explorer").classList.toggle("off", layout.noExplorer);
  $("toggle-chat").classList.toggle("off", layout.noChat);
}

function sash(id, key, { min, max, fromRight }) {
  const s = $(id);
  s.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    s.classList.add("dragging");
    document.body.classList.add("resizing");
    const startX = e.clientX;
    const start = layout[key];
    const move = (ev) => {
      const dx = ev.clientX - startX;
      layout[key] = Math.round(Math.min(max(), Math.max(min, start + (fromRight ? -dx : dx))));
      applyLayout();
    };
    const up = () => {
      s.removeEventListener("pointermove", move);
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) s.removeEventListener(type, up);
      s.classList.remove("dragging");
      document.body.classList.remove("resizing");
      saveLayout();
    };
    s.addEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) s.addEventListener(type, up);
  });
}

const togglePane = (key) => { layout[key] = !layout[key]; applyLayout(); saveLayout(); };
const showChat = () => { if (layout.noChat) togglePane("noChat"); };

// ---------------------------------------------------------------- modules
const explorer = createExplorer({
  api,
  onOpenFile: (path) => editor.openFile(path).catch((err) => chat.addErrorLine(err.message)),
  onError: (msg) => chat.addErrorLine(msg),
});

const editor = createEditor({
  api,
  onContextChange: (ctx) => chat.setContext(ctx),
  onAskSelection: (ctx) => chat.askAbout(ctx),
  onStatus: ({ cursor, language }) => {
    $("sb-cursor").textContent = cursor;
    $("sb-language").textContent = language;
  },
  onFileOpened: (path) => explorer.setActive(path),
  onError: (msg) => chat.addErrorLine(msg),
});

const chat = createChat({
  api,
  editor,
  explorer,
  getRoot: () => app.root,
  onAuthError: () => connect.setRejected(true),
  onUsage: (totals) => {
    app.totals = totals;
    renderUsage();
    if (totals) refreshBalance();
  },
  showChat,
});

const connect = createConnect({
  api,
  onConnected: refreshBalance,
  onNotice: (msg) => chat.addSystemLine(msg),
  onClose: () => chat.focus(),
});

// ---------------------------------------------------------------- workspace
async function setWorkspace(dir) {
  app.root = dir;
  editor.setRoot(dir);
  $("workspace-chip").textContent = tildify(dir, app.home);
  $("workspace-chip").title = `${dir} — click to open another folder`;
  $("sb-workspace").textContent = tildify(dir, app.home);
  $("empty-cwd").textContent = tildify(dir, app.home);
  document.title = `${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir} — CodePal`;
  await explorer.setRoot(dir);
}

async function openFolder() {
  if (editor.hasDirty() && !confirm("Some files have unsaved changes. Open another folder and discard them?")) return;
  const dir = await api.openWorkspace();
  if (!dir) return;
  editor.closeAll();
  await chat.reset();
  await setWorkspace(dir);
}

// ---------------------------------------------------------------- commands
// The app menu shows these shortcuts but doesn't register them (main.mjs), so the
// keys reach the page: the handler below runs them, and menu clicks arrive over IPC.
const COMMANDS = {
  "save": () => editor.save(),
  "close-tab": () => editor.closeActive(),
  "open-folder": () => openFolder(),
  "toggle-explorer": () => togglePane("noExplorer"),
  "toggle-chat": () => togglePane("noChat"),
  "new-conversation": () => chat.reset(),
};
const SHORTCUTS = { s: "save", w: "close-tab", o: "open-folder", b: "toggle-explorer", j: "toggle-chat", "shift+n": "new-conversation" };

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const cmd = SHORTCUTS[`${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`];
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation(); // Monaco would otherwise run its own Ctrl+S binding too
  COMMANDS[cmd]();
}, true);
api.onMenu((cmd) => COMMANDS[cmd]?.());

window.addEventListener("focus", () => editor.revalidate());

$("workspace-chip").addEventListener("click", openFolder);
$("toggle-explorer").addEventListener("click", () => togglePane("noExplorer"));
$("toggle-chat").addEventListener("click", () => togglePane("noChat"));
$("new-session").addEventListener("click", () => chat.reset());
document.getElementById("theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  try { localStorage.setItem("codepal-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let stored = null;
  try { stored = localStorage.getItem("codepal-theme"); } catch { /* ignore */ }
  if (!stored) document.documentElement.classList.toggle("dark", e.matches);
});

sash("sash-explorer", "explorer", { min: 160, max: () => window.innerWidth * 0.4 });
sash("sash-chat", "chat", { min: 320, max: () => window.innerWidth * 0.6, fromRight: true });
applyLayout();

// ---------------------------------------------------------------- init
(async () => {
  const info = await api.info();
  app.home = info.home;
  chat.setModels(info.models, info.defaultModel);
  await setWorkspace(info.workspace);
  connect.init(info.hasToken || info.demo);
  if (info.hasToken) refreshBalance();
  if (info.hasToken || info.demo) chat.focus();
})().catch((err) => chat.addErrorLine(`Startup failed: ${err?.message ?? err}`));
