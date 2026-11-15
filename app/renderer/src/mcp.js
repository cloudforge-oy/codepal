// MCP servers dialog: status of each server in CodePal's mcp.json (and servers only the
// running conversation knows, e.g. from a trusted project), enable/disable, an add/edit
// form with presets, and "Edit mcp.json" for everything the form does not cover.
import { $, el } from "./util.js";

/** IPC errors arrive as "Error invoking remote method 'mcp:…': Error: <message>". */
const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const STATE_LABEL = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs sign-in — not supported yet",
  disabled: "Disabled",
  connecting: "Connecting…",
  "not-started": "Starts with your next message",
};

export function createMcpPanel({ api, getModel, onEditConfig, onNotice }) {
  const overlay = $("mcp-overlay");
  const list = $("mcp-list");
  const banner = $("mcp-banner");
  const form = $("mcp-form");
  const formError = $("mcp-form-error");
  const f = {
    name: $("mcp-name"), command: $("mcp-command"), args: $("mcp-args"), env: $("mcp-env"),
    url: $("mcp-url"), headers: $("mcp-headers"),
  };
  let editing = null;   // previous name while editing, null when adding
  let poll = null;
  let presets = [];
  let changed = false;  // config changed while a conversation runs: say it applies later
  const expanded = new Set(); // servers whose tool list is open (survives the 1.5 s re-render)

  const kind = () => form.querySelector('input[name="mcp-kind"]:checked').value;
  const setKind = (k) => {
    form.querySelector(`input[name="mcp-kind"][value="${k}"]`).checked = true;
    $("mcp-command-fields").classList.toggle("hidden", k !== "command");
    $("mcp-url-fields").classList.toggle("hidden", k !== "url");
  };
  form.querySelectorAll('input[name="mcp-kind"]').forEach((r) => r.addEventListener("change", () => setKind(kind())));

  function showError(err) {
    formError.textContent = message(err);
    formError.classList.remove("hidden");
  }

  function fillForm(input) {
    f.name.value = input.name ?? "";
    setKind(input.kind === "url" ? "url" : "command");
    f.command.value = input.command ?? "";
    f.args.value = input.args ?? "";
    f.env.value = input.env ?? "";
    f.url.value = input.url ?? "";
    f.headers.value = input.headers ?? "";
  }

  function openForm(input, previousName = null) {
    editing = previousName;
    $("mcp-form-title").textContent = previousName ? `Edit ${previousName}` : "Add server";
    $("mcp-presets").classList.toggle("hidden", Boolean(previousName));
    formError.classList.add("hidden");
    fillForm(input ?? { kind: "command" });
    form.classList.remove("hidden");
    $("mcp-add").disabled = true;
    f.name.focus();
  }
  function closeForm() {
    form.classList.add("hidden");
    $("mcp-add").disabled = false;
    editing = null;
  }

  function renderPresets() {
    const host = $("mcp-presets");
    host.innerHTML = "";
    host.append(el("span", "hint", "Start from:"));
    for (const p of presets) {
      const b = el("button", "chip", p.label);
      b.type = "button";
      b.title = p.description;
      b.addEventListener("click", () => { fillForm(p.input); formError.classList.add("hidden"); });
      host.append(b);
    }
  }

  function renderRow(row) {
    const item = el("div", `mcp-row state-${row.state}`);
    const head = el("div", "mcp-row-head");
    head.append(el("span", "mcp-dot"), el("span", "mcp-name", row.name));
    const label = row.state === "connected"
      ? `Connected · ${row.tools.length} tool${row.tools.length === 1 ? "" : "s"}`
      : STATE_LABEL[row.state] ?? row.state;
    head.append(el("span", "mcp-state", label));
    if (row.source === "project") head.append(el("span", "mcp-tag", "from this project"));
    const actions = el("span", "mcp-row-actions");
    if (row.source === "codepal") {
      const toggle = el("button", "chip", row.enabled ? "Disable" : "Enable");
      toggle.addEventListener("click", () => run(() => api.mcpSetEnabled(row.name, !row.enabled)));
      const edit = el("button", "chip", "Edit");
      edit.addEventListener("click", async () => {
        try { openForm(await api.mcpFormInput(row.name), row.name); } catch (err) { onNotice(message(err)); }
      });
      const remove = el("button", "chip danger", "Remove");
      remove.addEventListener("click", () => {
        if (confirm(`Remove the MCP server "${row.name}" from CodePal?`)) run(() => api.mcpRemoveServer(row.name));
      });
      actions.append(toggle, edit, remove);
    }
    head.append(actions);
    item.append(head);
    if (row.summary) item.append(el("div", "mcp-summary", row.summary));
    if (row.message) item.append(el("div", "mcp-error", row.message));
    if (row.tools.length) {
      const tools = el("details", "mcp-tools");
      tools.open = expanded.has(row.name);
      tools.addEventListener("toggle", () => { if (tools.open) expanded.add(row.name); else expanded.delete(row.name); });
      tools.append(el("summary", "", "Tools"));
      const ul = el("ul");
      for (const t of row.tools) {
        const li = el("li");
        li.append(el("code", "", t.name));
        if (t.readOnly) li.append(el("span", "mcp-tag", "read-only"));
        if (t.description) li.append(el("span", "hint", ` ${t.description}`));
        ul.append(li);
      }
      tools.append(ul);
      item.append(tools);
    }
    return item;
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return; // the poll must not overlap a slow refresh
    refreshing = true;
    try { await doRefresh(); } finally { refreshing = false; }
  }
  async function doRefresh() {
    let status;
    try { status = await api.mcpStatus(); } catch (err) { banner.textContent = message(err); banner.classList.remove("hidden"); return; }
    presets = status.presets;
    renderPresets();
    $("mcp-path").textContent = status.configPath;
    const notes = [];
    if (status.configError) notes.push(`mcp.json can't be read: ${status.configError}. Fix it with "Edit mcp.json".`);
    for (const e of status.configErrors) notes.push(`Config: ${e}`);
    if (changed && status.sessionActive) notes.push("Changes apply to the next conversation (+ in the chat starts one).");
    banner.textContent = notes.join("\n");
    banner.classList.toggle("hidden", notes.length === 0);
    list.innerHTML = "";
    if (status.rows.length === 0) list.append(el("div", "mcp-empty", "No MCP servers yet. Add one, or start from a preset."));
    for (const row of status.rows) list.append(renderRow(row));
    $("mcp-connect").classList.toggle("hidden", status.sessionActive || status.rows.every((r) => r.state === "disabled"));
  }

  async function run(action) {
    try {
      await action();
      changed = true;
    } catch (err) {
      onNotice(message(err));
    }
    await refresh();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = {
      name: f.name.value, kind: kind(), command: f.command.value, args: f.args.value, env: f.env.value,
      url: f.url.value, headers: f.headers.value,
    };
    $("mcp-save").disabled = true;
    try {
      await api.mcpSaveServer(input, editing);
      changed = true;
      closeForm();
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      $("mcp-save").disabled = false;
    }
  });

  function open() {
    overlay.classList.remove("hidden");
    $("mcp-close").focus(); // Escape reaches the dialog right away
    refresh();
    clearInterval(poll);
    poll = setInterval(refresh, 1500); // servers connect in the background
  }
  function close() {
    overlay.classList.add("hidden");
    clearInterval(poll);
    poll = null;
    closeForm();
  }

  $("mcp-add").addEventListener("click", () => openForm(null));
  $("mcp-cancel").addEventListener("click", closeForm);
  $("mcp-close").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (!form.classList.contains("hidden")) closeForm(); // first Escape leaves the form
    else close();
  });
  $("mcp-edit-json").addEventListener("click", () => { close(); onEditConfig(); });
  $("mcp-connect").addEventListener("click", async () => {
    $("mcp-connect").disabled = true;
    try {
      await api.mcpConnect(getModel());
      changed = false;
    } catch (err) {
      onNotice(message(err));
    } finally {
      $("mcp-connect").disabled = false;
    }
    refresh();
  });

  return {
    open,
    close,
    /** A new conversation picks up config changes. */
    conversationReset() { changed = false; if (!overlay.classList.contains("hidden")) refresh(); },
  };
}
