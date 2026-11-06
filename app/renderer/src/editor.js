// Monaco editor: tabs over workspace files, save, agent-change sync, and diff views.
import * as monaco from "monaco-editor";
import { $, el, basename, relativeTo } from "./util.js";

// Monaco runs language services in workers; the build emits one bundle per worker.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const name =
      label === "json" ? "json"
      : ["css", "scss", "less"].includes(label) ? "css"
      : ["html", "handlebars", "razor"].includes(label) ? "html"
      : ["typescript", "javascript"].includes(label) ? "ts"
      : "editor";
    return new Worker(new URL(`dist/${name}.worker.js`, location.href), { name: label });
  },
};

// Themes that sit on the app's own background (oklch(1 0 0) / oklch(0.145 0 0)).
monaco.editor.defineTheme("codepal-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#ffffff",
    "editor.lineHighlightBackground": "#f5f5f5",
    "editorLineNumber.foreground": "#a3a3a3",
    "editorLineNumber.activeForeground": "#404040",
    "editor.selectionBackground": "#c7d2fe",
    "editorCursor.foreground": "#4338ca",
    "editorWidget.background": "#fafafa",
  },
});
monaco.editor.defineTheme("codepal-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0a0a0a",
    "editorGutter.background": "#0a0a0a",
    "editor.lineHighlightBackground": "#161616",
    "editorLineNumber.foreground": "#525252",
    "editorLineNumber.activeForeground": "#a3a3a3",
    "editor.selectionBackground": "#3730a399",
    "editorCursor.foreground": "#818cf8",
    "editorWidget.background": "#171717",
    "minimap.background": "#0a0a0a",
  },
});
const themeName = () => (document.documentElement.classList.contains("dark") ? "codepal-dark" : "codepal-light");
new MutationObserver(() => monaco.editor.setTheme(themeName()))
  .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

const OPTIONS = {
  theme: themeName(),
  automaticLayout: true,
  fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: "selection",
  bracketPairColorization: { enabled: true },
  stickyScroll: { enabled: true },
  padding: { top: 6 },
};

/** Monaco language id for a path, from the registered languages' extensions. */
export function languageFor(path) {
  const name = basename(path).toLowerCase();
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id;
  }
  return "plaintext";
}

const languageLabel = (id) => monaco.languages.getLanguages().find((l) => l.id === id)?.aliases?.[0] ?? id;

/** Syntax-highlighted HTML for a chat code block (Monaco escapes the text). */
export function colorize(code, lang) {
  const known = monaco.languages.getLanguages().find((l) => l.id === lang || l.aliases?.some((a) => a.toLowerCase() === lang));
  return monaco.editor.colorize(code, known?.id ?? "plaintext", { tabSize: 2 });
}

export function createEditor({ api, onContextChange, onAskSelection, onStatus, onFileOpened, onError }) {
  const report = (p) => p.catch((err) => onError(String(err?.message ?? err)));
  const host = $("editor-host");
  const codeHost = el("div", "editor-pane");
  const diffHost = el("div", "editor-pane hidden");
  for (const h of [codeHost, diffHost]) h.style.height = "100%";
  host.append(codeHost, diffHost);

  const editor = monaco.editor.create(codeHost, { ...OPTIONS, model: null });
  const diffEditor = monaco.editor.createDiffEditor(diffHost, {
    ...OPTIONS,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderOverviewRuler: false,
  });

  let root = "";
  const tabs = [];       // { key, kind: "file"|"diff", path, title, model | original+modified, ... }
  let active = null;
  let diffSeq = 0;

  const tabsEl = $("tabs");
  const emptyEl = $("editor-empty");
  const noticeEl = $("editor-notice");
  const noticeText = $("editor-notice-text");

  const isDirty = (t) => t.kind === "file" && !t.readOnly && t.model.getAlternativeVersionId() !== t.savedVersion;

  // ---------------------------------------------------------------- tabs UI
  function renderTabs() {
    tabsEl.innerHTML = "";
    for (const t of tabs) {
      const tab = el("div", "tab");
      tab.classList.toggle("active", t === active);
      tab.classList.toggle("dirty", isDirty(t));
      tab.classList.toggle("diff", t.kind === "diff");
      tab.classList.toggle("deleted", Boolean(t.deleted));
      tab.title = t.kind === "file" ? t.path : t.title;
      tab.setAttribute("role", "tab");
      const label = el("span", "tab-label", t.title);
      const close = el("button", "tab-close");
      close.title = "Close (Ctrl+W)";
      close.append(el("span", "", "×"));
      close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
      tab.addEventListener("click", () => activate(t));
      tab.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(t); });
      tab.append(label, close);
      tabsEl.appendChild(tab);
      if (t === active) queueMicrotask(() => tab.scrollIntoView({ block: "nearest", inline: "nearest" }));
    }
    emptyEl.classList.toggle("hidden", tabs.length > 0);
    renderNotice();
  }

  function renderNotice() {
    const t = active;
    const show = t?.kind === "file" && (t.conflict || t.deleted);
    noticeEl.classList.toggle("hidden", !show);
    if (!show) return;
    noticeText.textContent = t.deleted
      ? `${t.title} was deleted on disk. Saving will recreate it.`
      : `${t.title} changed on disk while you had unsaved edits.`;
    $("notice-reload").classList.toggle("hidden", Boolean(t.deleted));
  }

  /** Titles get a folder hint when two open tabs share a file name. */
  function retitle() {
    for (const t of tabs) {
      if (t.kind !== "file") continue;
      const same = tabs.filter((o) => o.kind === "file" && basename(o.path) === basename(t.path));
      const rel = relativeTo(root, t.path);
      t.title = same.length > 1 ? rel : basename(t.path);
    }
  }

  function status() {
    const t = active;
    if (!t) return onStatus({ cursor: "", language: "" });
    const ed = t.kind === "file" ? editor : diffEditor.getModifiedEditor();
    const pos = ed.getPosition();
    const model = t.kind === "file" ? t.model : t.modified;
    onStatus({
      cursor: pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : "",
      language: languageLabel(model.getLanguageId()),
    });
  }

  function emitContext() {
    onContextChange(getContext());
  }

  // ---------------------------------------------------------------- activation
  function activate(t, { line } = {}) {
    if (active?.kind === "file") active.viewState = editor.saveViewState();
    if (active?.kind === "diff") active.viewState = diffEditor.saveViewState();
    active = t;
    codeHost.classList.toggle("hidden", t?.kind !== "file");
    diffHost.classList.toggle("hidden", t?.kind !== "diff");
    if (t?.kind === "file") {
      editor.setModel(t.model);
      editor.updateOptions({ readOnly: Boolean(t.readOnly) });
      if (t.viewState) editor.restoreViewState(t.viewState);
      if (line) reveal(line);
      editor.focus();
    } else if (t?.kind === "diff") {
      diffEditor.setModel({ original: t.original, modified: t.modified });
      if (t.viewState) diffEditor.restoreViewState(t.viewState);
    } else {
      editor.setModel(null);
    }
    renderTabs();
    status();
    emitContext();
    onFileOpened(t?.kind === "file" ? t.path : null);
  }

  function reveal(line) {
    editor.revealLineInCenterIfOutsideViewport(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }

  // ---------------------------------------------------------------- files
  const opening = new Map(); // path -> in-flight open, so a double-click makes one tab

  function openFile(path, opts = {}) {
    if (!opening.has(path)) {
      opening.set(path, doOpenFile(path, opts).finally(() => opening.delete(path)));
      return opening.get(path);
    }
    return opening.get(path).then((t) => {
      if (opts.activate !== false) activate(t, { line: opts.line });
      return t;
    });
  }

  async function doOpenFile(path, { line, activate: doActivate = true } = {}) {
    let t = tabs.find((x) => x.kind === "file" && x.path === path);
    if (!t) {
      const res = await api.read(path);
      if (res.binary || res.tooLarge) {
        throw new Error(`${basename(path)} is ${res.binary ? "a binary file" : `too large (${(res.size / 1048576).toFixed(1)} MB)`} — not opened`);
      }
      const uri = monaco.Uri.file(path);
      monaco.editor.getModel(uri)?.dispose();
      const model = monaco.editor.createModel(res.content, languageFor(path), uri);
      t = { key: path, kind: "file", path, title: basename(path), model, savedVersion: model.getAlternativeVersionId(), mtimeMs: res.mtimeMs };
      model.onDidChangeContent(() => {
        const dirty = isDirty(t);
        if (dirty !== t.wasDirty) { t.wasDirty = dirty; renderTabs(); }
      });
      tabs.push(t);
      retitle();
    }
    if (doActivate) activate(t, { line });
    else renderTabs();
    return t;
  }

  async function save(t = active) {
    if (!t || t.kind !== "file" || t.readOnly) return;
    const { mtimeMs } = await api.write(t.path, t.model.getValue());
    t.savedVersion = t.model.getAlternativeVersionId();
    t.wasDirty = false;
    t.mtimeMs = mtimeMs;
    t.conflict = false;
    t.deleted = false;
    renderTabs();
  }

  /** Replace a file tab's content as one undoable edit (Ctrl+Z reverts the agent). */
  function replaceContent(t, text, mtimeMs) {
    if (t.model.getValue() !== text) {
      t.model.pushStackElement();
      t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text }], () => null);
      t.model.pushStackElement();
    }
    t.savedVersion = t.model.getAlternativeVersionId();
    t.wasDirty = false;
    t.conflict = false;
    t.deleted = false;
    if (mtimeMs) t.mtimeMs = mtimeMs;
  }

  async function reloadFromDisk(t, { force = false } = {}) {
    const res = await api.read(t.path);
    // Typed while the read was in flight? Don't clobber it — flag the conflict instead.
    if (!force && isDirty(t)) t.conflict = true;
    else if (res.content !== undefined) replaceContent(t, res.content, res.mtimeMs);
    renderTabs();
  }

  /** Sync after the agent wrote a file: refresh a clean tab in place, flag a dirty one,
   *  open it otherwise (without stealing focus from someone typing). */
  async function applyAgentChange({ path, after, line }) {
    if (!inWorkspace(path)) return;
    const t = tabs.find((x) => x.kind === "file" && x.path === path);
    if (!t) {
      await openFile(path, { line, activate: !editor.hasTextFocus() }).catch(() => {});
      return;
    }
    const stat = await api.stat(path);
    if (isDirty(t)) {
      t.conflict = true;
      if (stat) t.mtimeMs = stat.mtimeMs;
      renderTabs();
      return;
    }
    if (typeof after === "string") replaceContent(t, after, stat?.mtimeMs);
    else await reloadFromDisk(t);
    renderTabs();
    if (t === active && line) reveal(line);
  }

  /** Re-check open files against disk (after bash runs, when the window regains focus). */
  async function revalidate() {
    for (const t of tabs.filter((x) => x.kind === "file")) {
      const stat = await api.stat(t.path);
      if (!stat) {
        if (!t.deleted) { t.deleted = true; renderTabs(); }
        continue;
      }
      if (t.deleted) { t.deleted = false; renderTabs(); }
      if (stat.mtimeMs === t.mtimeMs) continue;
      if (isDirty(t)) { t.conflict = true; t.mtimeMs = stat.mtimeMs; renderTabs(); continue; }
      await reloadFromDisk(t);
    }
  }

  // ---------------------------------------------------------------- diffs
  function openDiff({ path, before, after, title }) {
    const lang = languageFor(path);
    const original = monaco.editor.createModel(before ?? "", lang);
    const modified = monaco.editor.createModel(after ?? "", lang);
    const t = { key: `diff:${++diffSeq}`, kind: "diff", path, title: title ?? `${basename(path)} (changes)`, original, modified };
    tabs.push(t);
    activate(t);
    // Jump to the first change once the diff is computed.
    const sub = diffEditor.onDidUpdateDiff(() => {
      sub.dispose();
      const first = diffEditor.getLineChanges()?.[0];
      if (first) diffEditor.getModifiedEditor().revealLineInCenter(Math.max(1, first.modifiedStartLineNumber));
    });
    return t;
  }

  // ---------------------------------------------------------------- close
  function closeTab(t) {
    if (isDirty(t) && !confirm(`${t.title} has unsaved changes. Close it anyway?`)) return;
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    // Detach before disposing — an editor still showing a disposed model throws.
    if (t.kind === "file") {
      if (editor.getModel() === t.model) editor.setModel(null);
      t.model.dispose();
    } else {
      if (diffEditor.getModel()?.modified === t.modified) diffEditor.setModel(null);
      t.original.dispose();
      t.modified.dispose();
    }
    retitle();
    if (active === t) {
      active = null;
      activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
    } else {
      renderTabs();
    }
  }

  /** Close every tab, discarding unsaved edits — callers check hasDirty() first. */
  function closeAll() {
    for (const t of [...tabs]) {
      t.wasDirty = false;
      t.savedVersion = t.kind === "file" ? t.model.getAlternativeVersionId() : t.savedVersion;
      closeTab(t);
    }
  }

  // ---------------------------------------------------------------- context
  function inWorkspace(p) {
    return relativeTo(root, p) !== p || p === root;
  }

  /** What the chat sends along: the open file and the selected text, if any. */
  function getContext() {
    const t = active;
    if (!t || t.kind !== "file") return null;
    const sel = editor.getSelection();
    const text = sel && !sel.isEmpty() ? t.model.getValueInRange(sel) : "";
    return {
      path: t.path,
      rel: relativeTo(root, t.path),
      language: t.model.getLanguageId(),
      selection: text
        ? { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text }
        : null,
    };
  }

  // ---------------------------------------------------------------- wiring
  let ctxTimer = 0;
  editor.onDidChangeCursorSelection(() => {
    status();
    clearTimeout(ctxTimer);
    ctxTimer = setTimeout(emitContext, 120);
  });
  diffEditor.getModifiedEditor().onDidChangeCursorPosition(status);

  editor.addAction({
    id: "codepal.ask",
    label: "Ask CodePal about this",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
    contextMenuGroupId: "navigation",
    contextMenuOrder: 0,
    run: () => onAskSelection(getContext()),
  });
  editor.addAction({
    id: "codepal.save",
    label: "Save",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
    run: () => report(save()),
  });

  $("notice-reload").addEventListener("click", () => active && report(reloadFromDisk(active, { force: true })));
  $("notice-keep").addEventListener("click", () => {
    if (active) { active.conflict = false; renderTabs(); }
  });

  renderTabs();

  return {
    openFile,
    openDiff,
    applyAgentChange,
    revalidate,
    save: () => report(save()),
    closeActive: () => active && closeTab(active),
    closeAll,
    hasDirty: () => tabs.some(isDirty),
    getContext,
    focus: () => (active?.kind === "file" ? editor.focus() : undefined),
    readFile: async (path) => {
      const t = tabs.find((x) => x.kind === "file" && x.path === path);
      if (t) return t.model.getValue();
      const res = await api.read(path).catch(() => null);
      return res?.content ?? null;
    },
    setRoot(dir) {
      root = dir;
      retitle();
    },
  };
}
