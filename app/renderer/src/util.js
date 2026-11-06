// Small shared helpers: DOM, markdown, paths.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const stringify = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

export const oneLine = (v, max = 120) => {
  const s = stringify(v).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

// ---------------------------------------------------------------------------
// paths — the renderer works with absolute paths; the separator follows the OS
// ---------------------------------------------------------------------------
export const sep = () => (navigator.userAgent.includes("Windows") ? "\\" : "/");
export const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "") || (p.startsWith("/") ? "/" : p);

/** Path relative to `root` when inside it, otherwise unchanged. */
export function relativeTo(root, p) {
  if (!root) return p;
  const r = root.replace(/[\\/]+$/, "");
  if (p === r) return ".";
  return p.startsWith(r + "/") || p.startsWith(r + "\\") ? p.slice(r.length + 1) : p;
}

export function tildify(p, home) {
  return home && (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\")) ? "~" + p.slice(home.length) : p;
}

// ---------------------------------------------------------------------------
// tiny markdown renderer (escape first, then transform). Fenced code blocks are
// tagged with their language so the chat can colorize them with Monaco later.
// ---------------------------------------------------------------------------
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function renderMarkdown(src) {
  const esc = escapeHtml(src);
  // fenced blocks; an unterminated fence (mid-stream) runs to the end
  const fence = /```([\w+#.-]*)\n([\s\S]*?)(?:```|$)/g;
  let html = "", last = 0, m;
  while ((m = fence.exec(esc))) {
    html += mdBlockText(esc.slice(last, m.index));
    const lang = m[1] ? ` data-lang="${m[1]}"` : "";
    html += `<pre${lang}><code>${m[2].replace(/\n$/, "")}</code></pre>`;
    last = m.index + m[0].length;
  }
  html += mdBlockText(esc.slice(last));
  return html;
}

function mdBlockText(text) {
  const lines = text.split("\n");
  let html = "", para = [], list = null;
  const flushPara = () => {
    if (para.length) { html += `<p>${inlineMd(para.join("<br>"))}</p>`; para = []; }
  };
  const flushList = () => {
    if (list) { html += `<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.tag}>`; list = null; }
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { flushPara(); flushList(); html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; }
    else if (ul) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(ul[1]); }
    else if (ol) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(ol[1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return html;
}

/** Decode the entities escapeHtml produced (for handing code text to Monaco). */
export function unescapeHtml(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}
