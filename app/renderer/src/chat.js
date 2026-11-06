// Chat panel: renders the pi agent's UiEvent stream (codepal-agent.ts) — streaming text,
// thinking, tool cards, permission prompts — and drives the composer.
import { colorize } from "./editor.js";
import { $, el, basename, oneLine, relativeTo, renderMarkdown, stringify, unescapeHtml } from "./util.js";

// Gateway wording varies ("Authentication Error", "Invalid proxy server token passed",
// 401) — all of them mean the key needs replacing, not retrying.
const AUTH_ERROR_RE = /\b401\b|authentication error|unauthorized|invalid[^]{0,24}(api key|token)/i;
const MAX_CONTEXT_CHARS = 12_000;

export function createChat({ api, editor, explorer, getRoot, onAuthError, onUsage, showChat }) {
  const chat = $("chat");
  const chatEmpty = $("chat-empty");
  const promptInput = $("prompt-input");
  const sendBtn = $("send-btn");
  const stopBtn = $("stop-btn");
  const statusRow = $("status-row");
  const statusText = $("status-text");
  const queueText = $("queue-text");
  const modelSelect = $("model-select");
  const attachBtn = $("attach-btn");
  const imageInput = $("image-input");
  const attachmentsEl = $("attachments");
  const contextRow = $("context-row");
  const contextChip = $("context-chip");
  const contextLabel = $("context-label");
  const composerHint = $("composer-hint");

  const state = {
    busy: false,
    currentText: null,      // { el, mdEl, raw, frame }
    currentThinking: null,  // { el, summaryEl, bodyEl, raw }
    toolCards: new Map(),   // toolCallId -> card refs
    alwaysAllow: new Set(), // tool names auto-approved this conversation
    attachments: [],        // { name, dataUrl }
    contextOn: true,        // send the open file / selection along
    context: null,          // latest editor context
    totals: { input: 0, output: 0, cost: 0 },
  };

  const rel = (p) => (typeof p === "string" ? relativeTo(getRoot(), p) : "");
  const absPath = (p) => {
    const s = String(p).trim().replace(/^@/, "");
    if (/^([a-zA-Z]:)?[\\/]/.test(s)) return s;
    const root = getRoot();
    const sep = root.includes("\\") ? "\\" : "/";
    return `${root}${sep}${s.replace(/^\.[\\/]/, "")}`;
  };

  // -------------------------------------------------------------- blocks
  function addBlock(node) {
    chatEmpty.classList.add("hidden");
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
    chat.appendChild(node);
    if (nearBottom) chat.scrollTop = chat.scrollHeight;
  }

  function scrollIfPinned() {
    if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120) chat.scrollTop = chat.scrollHeight;
  }

  function addUserBlock(text, images = [], contextLabelText = null) {
    const block = el("div", "block user");
    const bubble = el("div", "bubble", text);
    if (images.length) {
      const strip = el("div", "bubble-images");
      for (const src of images) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "attached image";
        strip.appendChild(img);
      }
      bubble.appendChild(strip);
    }
    if (contextLabelText) bubble.appendChild(el("div", "bubble-context", `</> ${contextLabelText}`));
    block.appendChild(bubble);
    addBlock(block);
  }

  function addSystemLine(text) { addBlock(el("div", "block system", text)); }

  function addErrorLine(text) {
    addBlock(el("div", "block error-msg", text));
    if (AUTH_ERROR_RE.test(text)) onAuthError();
  }

  // text — re-rendered at most once per frame while streaming
  function ensureText() {
    if (state.currentText) return state.currentText;
    const block = el("div", "block assistant");
    const md = el("div", "md");
    block.appendChild(md);
    addBlock(block);
    state.currentText = { el: block, mdEl: md, raw: "", frame: 0 };
    return state.currentText;
  }

  function appendText(delta) {
    const t = ensureText();
    t.raw += delta;
    if (!t.frame) {
      t.frame = requestAnimationFrame(() => {
        t.frame = 0;
        t.mdEl.innerHTML = renderMarkdown(t.raw);
        scrollIfPinned();
      });
    }
  }

  function endText(final) {
    const t = state.currentText;
    state.currentText = null;
    if (!t) return;
    cancelAnimationFrame(t.frame);
    if (typeof final === "string" && final) t.raw = final;
    t.mdEl.innerHTML = renderMarkdown(t.raw);
    // Syntax-highlight finished code blocks with Monaco's tokenizer.
    for (const pre of t.mdEl.querySelectorAll("pre[data-lang]")) {
      const code = pre.querySelector("code");
      colorize(unescapeHtml(code.innerHTML), pre.dataset.lang)
        .then((html) => { code.innerHTML = html; code.classList.add("colorized"); })
        .catch(() => {});
    }
    scrollIfPinned();
  }

  function ensureThinking() {
    if (state.currentThinking) return state.currentThinking;
    const details = el("details", "block thinking");
    const summary = el("summary", "", "Thinking…");
    const body = el("div", "thinking-body");
    details.append(summary, body);
    addBlock(details);
    state.currentThinking = { el: details, summaryEl: summary, bodyEl: body, raw: "" };
    return state.currentThinking;
  }

  function endThinking(final) {
    const t = state.currentThinking;
    state.currentThinking = null;
    if (!t) return;
    if (final) t.bodyEl.textContent = t.raw = final;
    t.summaryEl.textContent = "Thought for a moment";
  }

  // -------------------------------------------------------------- tool cards
  function toolSummary(name, args) {
    if (!args || typeof args !== "object") return oneLine(args);
    if (name === "bash" || name === "powershell") return oneLine(args.command, 200);
    if (name === "grep" || name === "find") return `${args.pattern}${args.path ? ` in ${rel(absPath(args.path))}` : ""}`;
    if (args.path) {
      const p = rel(absPath(args.path));
      if (name === "read" && args.offset) return `${p}:${args.offset}`;
      if (name === "edit" && Array.isArray(args.edits)) return `${p} · ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}`;
      return p;
    }
    return oneLine(args);
  }

  function addToolCard(toolCallId, toolName, args) {
    endText();
    const block = el("div", "block tool");
    const head = el("div", "tool-head");
    const dot = el("span", "tool-dot running", "⏺");
    const name = el("span", "tool-name", toolName || "tool");
    const summary = el("span", "tool-summary", toolSummary(toolName, args));
    head.append(dot, name, summary);
    const resultLine = el("div", "tool-result-line hidden");
    const preview = el("span", "tool-result-preview");
    resultLine.append(el("span", "elbow", "⎿"), preview);
    const actions = el("div", "tool-actions hidden");
    const detail = el("div", "tool-detail hidden");
    const outPre = el("pre", "", "");
    detail.append(el("div", "label", "Input"), el("pre", "", stringify(args) || "(none)"), el("div", "label", "Output"), outPre);
    head.addEventListener("click", () => detail.classList.toggle("hidden"));
    block.append(head, resultLine, actions, detail);
    addBlock(block);
    const card = { block, dot, preview, resultLine, actions, outPre, output: "" };
    state.toolCards.set(toolCallId, card);
    return card;
  }

  function updateToolCard(card, text) {
    if (!card || !text) return;
    card.output = text; // pi sends the accumulated partial result
    card.outPre.textContent = text;
    card.resultLine.classList.remove("hidden");
    card.preview.textContent = oneLine(text.split("\n").filter(Boolean).pop() ?? "", 140);
    scrollIfPinned();
  }

  function finishToolCard(card, e) {
    if (!card) return;
    card.output = e.text ?? card.output;
    card.outPre.textContent = card.output;
    card.dot.classList.remove("running");
    card.dot.classList.add(e.isError ? "error" : "done");
    const preview = e.isError ? `Error: ${oneLine(card.output, 130)}` : oneLine(card.output, 130) || "done";
    const dur = e.durationMs ? ` (${(e.durationMs / 1000).toFixed(1)}s)` : "";
    card.preview.textContent = preview + dur;
    card.resultLine.classList.remove("hidden");
    if (e.file) {
      const { path, before, after, line } = e.file;
      const open = el("button", "chip", "Open");
      open.addEventListener("click", () => editor.openFile(path, { line }).catch((err) => addErrorLine(err.message)));
      card.actions.append(open);
      if (before !== null && after !== null) {
        const diff = el("button", "chip", "Diff");
        diff.addEventListener("click", () => editor.openDiff({ path, before, after }));
        card.actions.append(diff);
      }
      card.actions.classList.remove("hidden");
    }
    scrollIfPinned();
  }

  // -------------------------------------------------------------- approvals
  /** The file an edit/write would produce, for reviewing it before approving. */
  async function proposedChange(toolName, input) {
    const path = absPath(input.path);
    const current = (await editor.readFile(path)) ?? "";
    if (toolName === "write") return { path, before: current, after: String(input.content ?? "") };
    // edit: every oldText is matched against the original file (pi's semantics).
    const hits = (input.edits ?? [])
      .map((e) => ({ at: current.indexOf(e.oldText), e }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => b.at - a.at);
    let after = current;
    for (const { at, e } of hits) after = after.slice(0, at) + e.newText + after.slice(at + e.oldText.length);
    return { path, before: current, after };
  }

  const pendingCards = new Set();

  function showApproval(req) {
    if (state.alwaysAllow.has(req.toolName)) {
      api.respondApproval(req.id, true);
      return;
    }
    endText();
    showChat();
    const block = el("div", "block approval");
    const card = el("div", "card");
    const input = req.input ?? {};
    let what = `${req.toolName} wants to run:`;
    let body = stringify(input);
    if (req.toolName === "bash" || req.toolName === "powershell") body = String(input.command ?? body);
    if (req.toolName === "write") {
      what = `write wants to ${input.content?.length ? "write" : "create"} ${rel(absPath(input.path))}`;
      body = String(input.content ?? "");
    }
    if (req.toolName === "edit") {
      what = `edit wants to change ${rel(absPath(input.path))}`;
      body = (input.edits ?? []).map((e) => `- ${oneLine(e.oldText, 90)}\n+ ${oneLine(e.newText, 90)}`).join("\n\n");
    }
    card.append(el("div", "approval-title", "Permission required"), el("div", "approval-tool", what), el("pre", "", body || "(no input)"));

    const buttons = el("div", "approval-buttons");
    const yes = el("button", "primary", "Yes");
    const always = el("button", "", `Yes, don’t ask again for ${req.toolName}`);
    const no = el("button", "", "No");
    buttons.append(yes, always, no);
    if ((req.toolName === "edit" || req.toolName === "write") && input.path) {
      const review = el("button", "", "Review diff");
      review.addEventListener("click", async () => {
        try {
          const change = await proposedChange(req.toolName, input);
          editor.openDiff({ ...change, title: `${basename(change.path)} (proposed)` });
        } catch (err) {
          addErrorLine(String(err?.message ?? err));
        }
      });
      buttons.append(review);
    }
    card.appendChild(buttons);
    block.appendChild(card);
    addBlock(block);
    chat.scrollTop = chat.scrollHeight;

    const entry = { block, resolved: false };
    pendingCards.add(entry);
    const resolve = (approved, label) => {
      if (entry.resolved) return;
      entry.resolved = true;
      pendingCards.delete(entry);
      api.respondApproval(req.id, approved, approved ? undefined : "Denied by the user");
      block.replaceChildren(el("div", "approval-resolved",
        `${approved ? "✓ Approved" : "✗ Denied"} ${req.toolName}${label ? ` — ${label}` : ""}`));
    };
    yes.addEventListener("click", () => resolve(true));
    always.addEventListener("click", () => {
      state.alwaysAllow.add(req.toolName);
      resolve(true, "always this conversation");
    });
    no.addEventListener("click", () => resolve(false));
  }

  function cancelPendingApprovals() {
    for (const entry of pendingCards) {
      entry.resolved = true;
      entry.block.replaceChildren(el("div", "approval-resolved", "– Cancelled"));
    }
    pendingCards.clear();
  }

  // -------------------------------------------------------------- events
  let refreshTimer = 0;
  const refreshWorkspaceSoon = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      explorer.refresh();
      editor.revalidate();
    }, 250);
  };

  function handleEvent(e) {
    switch (e.type) {
      case "text_start": endThinking(); ensureText(); break;
      case "text_delta": appendText(e.delta); break;
      case "text_end": endText(e.content); break;
      case "thinking_start": ensureThinking(); break;
      case "thinking_delta": {
        const t = ensureThinking();
        t.raw += e.delta;
        t.bodyEl.textContent = t.raw;
        scrollIfPinned();
        break;
      }
      case "thinking_end": endThinking(e.content); break;
      case "status": statusText.textContent = e.text; break;
      case "tool_start":
        statusText.textContent = `Running ${e.toolName}…`;
        addToolCard(e.toolCallId, e.toolName, e.args);
        break;
      case "tool_update": updateToolCard(state.toolCards.get(e.toolCallId), e.text); break;
      case "tool_end":
        finishToolCard(state.toolCards.get(e.toolCallId), e);
        statusText.textContent = "Working…";
        if (e.file) {
          editor.applyAgentChange(e.file).catch(() => {});
          explorer.markChanged(e.file.path);
        } else if (e.toolName === "bash" || e.toolName === "powershell") {
          refreshWorkspaceSoon(); // a command may have changed anything
        }
        break;
      case "usage":
        state.totals.input += e.input + e.cacheRead + e.cacheWrite;
        state.totals.output += e.output;
        state.totals.cost += e.cost;
        onUsage(state.totals);
        break;
      case "notice": addSystemLine(e.message); break;
      case "error": endText(); addErrorLine(e.message); break;
      case "queue": {
        const n = e.steering.length + e.followUp.length;
        queueText.textContent = n ? `${n} queued` : "";
        queueText.classList.toggle("hidden", !n);
        break;
      }
      case "settled":
        endText();
        endThinking();
        if (e.aborted) addSystemLine("Interrupted");
        setBusy(false);
        refreshWorkspaceSoon();
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------- attachments
  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    for (const [i, att] of state.attachments.entries()) {
      const chip = el("div", "attachment");
      const img = document.createElement("img");
      img.src = att.dataUrl;
      img.alt = att.name;
      img.title = att.name;
      const remove = el("button", "remove", "×");
      remove.title = `Remove ${att.name}`;
      remove.addEventListener("click", () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      });
      chip.append(img, remove);
      attachmentsEl.appendChild(chip);
    }
    attachmentsEl.classList.toggle("hidden", state.attachments.length === 0);
  }

  function addImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        state.attachments.push({ name: file.name || "image", dataUrl: reader.result });
        renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  attachBtn.addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", () => {
    addImageFiles(imageInput.files);
    imageInput.value = "";
  });
  promptInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  });

  // -------------------------------------------------------------- editor context
  function contextText(ctx) {
    if (!ctx) return "";
    return ctx.selection
      ? `${ctx.rel}:${ctx.selection.startLine}-${ctx.selection.endLine}`
      : ctx.rel;
  }

  function renderContext() {
    const ctx = state.context;
    contextRow.classList.toggle("hidden", !ctx);
    if (!ctx) return;
    contextLabel.textContent = contextText(ctx);
    contextChip.classList.toggle("off", !state.contextOn);
    contextChip.title = state.contextOn
      ? "Sent with your message — click to leave it out"
      : "Not sent — click to include the open file / selection";
  }

  contextChip.addEventListener("click", () => {
    state.contextOn = !state.contextOn;
    renderContext();
    promptInput.focus();
  });

  /** The user's text plus an <editor-context> block (see APPEND_SYSTEM_PROMPT). */
  function withContext(text) {
    const ctx = state.contextOn ? state.context : null;
    if (!ctx) return { prompt: text, label: null };
    let block = `\n\n<editor-context>\nOpen file: ${ctx.rel}`;
    if (ctx.selection) {
      let sel = ctx.selection.text;
      if (sel.length > MAX_CONTEXT_CHARS) sel = `${sel.slice(0, MAX_CONTEXT_CHARS)}\n… (selection truncated)`;
      block += `\nSelected lines ${ctx.selection.startLine}-${ctx.selection.endLine}:\n\`\`\`${ctx.language}\n${sel}\n\`\`\``;
    }
    block += "\n</editor-context>";
    return { prompt: text + block, label: contextText(ctx) };
  }

  // -------------------------------------------------------------- composer
  function setBusy(busy) {
    state.busy = busy;
    statusRow.classList.toggle("hidden", !busy);
    if (busy) statusText.textContent = "Working…";
    else { queueText.textContent = ""; queueText.classList.add("hidden"); }
    composerHint.textContent = busy ? "⏎ steer · alt+⏎ queue follow-up" : "⏎ send · shift+⏎ newline";
    promptInput.placeholder = busy ? "Steer CodePal while it works…" : "Ask CodePal to do something…";
  }

  async function submit({ followUp = false } = {}) {
    const text = promptInput.value.trim();
    if (!text && state.attachments.length === 0) return;
    const images = state.attachments.map((a) => a.dataUrl);
    const { prompt, label } = withContext(text);
    state.attachments = [];
    renderAttachments();
    promptInput.value = "";
    autosize();
    addUserBlock(text, images, label);
    const wasBusy = state.busy;
    setBusy(true);
    try {
      await api.send({ prompt, images, model: modelSelect.value, whileBusy: followUp ? "followUp" : "steer" });
      if (wasBusy) addSystemLine(followUp ? "Queued as a follow-up" : "Sent as steering — CodePal reads it after the current step");
    } catch (err) {
      if (!wasBusy) setBusy(false);
      addErrorLine(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }

  function autosize() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + "px";
  }

  promptInput.addEventListener("input", autosize);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit({ followUp: e.altKey && state.busy });
    }
  });
  sendBtn.addEventListener("click", () => submit());
  stopBtn.addEventListener("click", () => api.abort().catch(() => {}));
  modelSelect.addEventListener("change", () => {
    api.setModel(modelSelect.value).catch((err) => addErrorLine(String(err?.message ?? err)));
  });

  async function reset() {
    await api.reset().catch(() => {});
    state.currentText = null;
    state.currentThinking = null;
    state.toolCards.clear();
    state.alwaysAllow.clear();
    state.attachments = [];
    state.totals = { input: 0, output: 0, cost: 0 };
    onUsage(null);
    renderAttachments();
    cancelPendingApprovals();
    setBusy(false);
    chat.querySelectorAll(".block").forEach((b) => b.remove());
    chatEmpty.classList.remove("hidden");
    explorer.clearChanged();
    promptInput.focus();
  }

  api.onEvent(handleEvent);
  api.onApproval(showApproval);
  api.onApprovalCancelled(cancelPendingApprovals);
  api.onDemoUser((text) => { addUserBlock(text); setBusy(true); });
  setBusy(false);

  return {
    reset,
    addSystemLine,
    addErrorLine,
    focus: () => promptInput.focus(),
    setContext(ctx) {
      state.context = ctx;
      renderContext();
    },
    /** Ctrl+L in the editor: include the selection and jump to the composer. */
    askAbout(ctx) {
      state.context = ctx;
      state.contextOn = true;
      renderContext();
      showChat();
      promptInput.focus();
    },
    setModels(models, selected) {
      modelSelect.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.free ? `${m.id} · free` : m.id;
        const price = m.free ? "Free" : `$${m.input}/M in · $${m.output}/M out${m.cached_input != null ? ` · $${m.cached_input}/M cached` : ""}`;
        opt.title = [m.blurb, price].filter(Boolean).join("\n");
        if (m.id === selected) opt.selected = true;
        modelSelect.appendChild(opt);
      }
    },
    get busy() { return state.busy; },
  };
}
