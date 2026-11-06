// File explorer: a lazily loaded tree of the workspace folder.
import { $, el, basename, dirname, relativeTo } from "./util.js";

/** True when p is root or inside it (a path-boundary check, not a string prefix). */
const isUnder = (root, p) => p === root || relativeTo(root, p) !== p;

const FOLDER_ICON =
  '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const FILE_ICON =
  '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';

export function createExplorer({ api, onOpenFile, onError }) {
  const treeEl = $("tree");
  let root = "";
  const expanded = new Set();   // absolute dir paths
  const changed = new Set();    // files the agent touched this conversation
  let activePath = null;
  let selectedDir = null;       // where "New file" goes
  let renderSeq = 0;

  function row(entry, depth) {
    const r = el("div", "tree-row");
    r.style.paddingLeft = `${8 + depth * 12}px`;
    r.dataset.path = entry.path;
    r.title = entry.path;
    r.setAttribute("role", "treeitem");
    const twisty = el("span", "twisty");
    if (entry.dir) twisty.innerHTML = CHEVRON; // static markup
    const icon = document.createElement("span");
    icon.innerHTML = entry.dir ? FOLDER_ICON : FILE_ICON; // static markup, no user data
    r.append(twisty, icon.firstChild, el("span", "name", entry.name));
    if (entry.dir) r.classList.toggle("open", expanded.has(entry.path));
    else {
      r.classList.toggle("active", entry.path === activePath);
      r.classList.toggle("changed", changed.has(entry.path));
    }
    return r;
  }

  /** Render `dir`'s children into `container`; expanded subfolders recurse. */
  async function renderDir(dir, depth, container, seq) {
    let entries;
    try {
      entries = await api.list(dir);
    } catch (err) {
      container.appendChild(el("div", "tree-empty", String(err?.message ?? err)));
      return;
    }
    if (seq !== renderSeq) return; // a newer render superseded this one
    if (!entries.length && depth === 0) container.appendChild(el("div", "tree-empty", "This folder is empty."));
    for (const entry of entries) {
      const r = row(entry, depth);
      container.appendChild(r);
      if (entry.dir) {
        const children = el("div", "tree-children");
        container.appendChild(children);
        r.addEventListener("click", () => toggle(entry.path, r, children, depth));
        if (expanded.has(entry.path)) await renderDir(entry.path, depth + 1, children, seq);
      } else {
        r.addEventListener("click", () => {
          selectedDir = dirname(entry.path);
          onOpenFile(entry.path);
        });
      }
    }
  }

  async function toggle(path, r, children, depth) {
    selectedDir = path;
    if (expanded.has(path)) {
      expanded.delete(path);
      r.classList.remove("open");
      children.innerHTML = "";
      return;
    }
    expanded.add(path);
    r.classList.add("open");
    children.innerHTML = "";
    await renderDir(path, depth + 1, children, renderSeq);
  }

  async function refresh() {
    if (!root) return;
    const seq = ++renderSeq;
    const fresh = document.createDocumentFragment();
    await renderDir(root, 0, fresh, seq);
    if (seq !== renderSeq) return;
    const scroll = treeEl.scrollTop;
    treeEl.replaceChildren(fresh);
    treeEl.scrollTop = scroll;
  }

  function highlight() {
    for (const r of treeEl.querySelectorAll(".tree-row")) {
      const p = r.dataset.path;
      if (r.querySelector(".twisty svg")) continue; // folder
      r.classList.toggle("active", p === activePath);
      r.classList.toggle("changed", changed.has(p));
    }
  }

  /** Inline name input for a new file in the selected folder (or the root). */
  function promptNewFile() {
    const dir = selectedDir && isUnder(root, selectedDir) ? selectedDir : root;
    const input = el("input", "tree-input");
    input.placeholder = `New file in ${basename(dir)}/ — e.g. src/app.ts`;
    input.setAttribute("aria-label", "New file name");
    treeEl.prepend(input);
    input.focus();
    let done = false;
    const finish = async (create) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      input.remove();
      if (!create || !name) return;
      try {
        const sepChar = root.includes("\\") ? "\\" : "/";
        const path = await api.create(`${dir}${sepChar}${name}`, name.endsWith("/") ? "dir" : "file");
        await refresh();
        if (!name.endsWith("/")) onOpenFile(path);
      } catch (err) {
        onError(String(err?.message ?? err));
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
  }

  $("refresh-tree").addEventListener("click", refresh);
  $("new-file").addEventListener("click", promptNewFile);

  return {
    async setRoot(dir) {
      root = dir;
      expanded.clear();
      changed.clear();
      selectedDir = dir;
      $("explorer-title").textContent = basename(dir) || dir;
      await refresh();
    },
    refresh,
    setActive(path) {
      activePath = path;
      highlight();
    },
    /** Mark a file the agent created or changed; reveal its folders if new. */
    async markChanged(path) {
      if (!root || !isUnder(root, path)) return;
      changed.add(path);
      for (let d = dirname(path); d !== root && d.length > root.length && isUnder(root, d); d = dirname(d)) expanded.add(d);
      await refresh();
    },
    clearChanged() {
      changed.clear();
      highlight();
    },
  };
}
