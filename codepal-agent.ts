/**
 * CodePal — agent sessions on pi (https://pi.dev), talking to the cloudcode.one gateway
 * ====================================================================================
 * Verified against @earendil-works/pi-coding-agent 1.5.0. API surface used:
 *   ModelRuntime.create({ authPath, modelsPath })  -> model/auth runtime
 *   modelRuntime.registerProvider(id, config)      -> the cloudcode.one provider + models
 *   new DefaultResourceLoader({ cwd, agentDir, extensionFactories, appendSystemPromptOverride })
 *   createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader, sessionManager })
 *   session.subscribe(listener)                     -> AgentSessionEvent stream
 *   session.prompt(text, { images, streamingBehavior }) / steer() / followUp()
 *   session.abort() / session.setModel(model) / session.dispose()
 *
 * Tool approval: pi has no permission prompts of its own (by design), but an extension
 * can intercept every call through the `tool_call` event and return { block, reason }.
 * The inline extension below awaits the desktop UI's Approve/Deny for mutating tools.
 *
 * Events: pi's stream carries the whole partial AssistantMessage on every delta. Copying
 * that over Electron IPC on each token is wasteful, so toUiEvents() reduces it to the
 * small UiEvent union the renderer consumes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

// pi's install telemetry and provider attribution headers default to on. An embedding
// app shouldn't report to pi.dev on its users' behalf; PI_TELEMETRY=1 re-enables it.
process.env.PI_TELEMETRY ??= "0";

// ===========================================================================
// 1. cloudcode.one provider
// ===========================================================================
export const PROVIDER_ID = "cloudcode";

/** The Anthropic SDK pi uses appends /v1/messages itself, so the base must NOT end in
 *  /v1 (the gateway 404s on /v1/v1/messages). Harness's CLOUDCODE_BASE_URL did include
 *  /v1 — strip it so the same env var works for both apps. */
export const gatewayBaseUrl = () =>
  (process.env.CLOUDCODE_BASE_URL ?? "https://api.cloudcode.one").replace(/\/+$/, "").replace(/\/v1$/, "");

/** One entry of https://cloudcode.one/models.json (prices are USD per 1M tokens). */
export interface CloudcodeModel {
  id: string;
  blurb?: string;
  input: number;
  output: number;
  cached_input?: number | null;
  free?: boolean;
  vision?: boolean;
  context_window?: number;
}

// max_tokens 32768 is verified accepted by the gateway; smaller limits truncated large
// write/edit tool calls mid-JSON with the weaker models.
const MODEL_MAX_TOKENS = 32_768;
// Conservative: pi compacts context relative to this. Catalog entries can override it.
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Catalog entries -> pi chat models.
 *  - api "anthropic-messages": the gateway speaks the Anthropic Messages API.
 *  - reasoning:false: pi then never sends a `thinking` parameter. GLM thinks on every
 *    turn anyway and the gateway enables z.ai's preserved thinking per deployment; pi
 *    still parses the streamed thinking blocks (with their signatures) and replays them
 *    verbatim on later turns, which is all preserved thinking needs from the client.
 *  - input includes "image" for every model: the gateway accepts images on any model
 *    and reroutes them to a vision variant; the catalog's vision flag is a UI hint. */
function toProviderModels(models: CloudcodeModel[]) {
  return models.map((m) => ({
    id: m.id,
    name: m.id,
    api: "anthropic-messages" as const,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: m.input, output: m.output, cacheRead: m.cached_input ?? 0, cacheWrite: 0 },
    contextWindow: m.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: MODEL_MAX_TOKENS,
  }));
}

const runtimes = new Map<string, { runtime: Promise<ModelRuntime>; catalog: string }>();

/** One ModelRuntime per agent dir (in practice: per process). pi's credential/model
 *  files live under the app's own agent dir (never ~/.pi/agent), and the gateway key is
 *  read from CLOUDCODE_TOKEN at request time via pi's "$NAME" interpolation, so a
 *  reconnect needs no re-registration. */
async function getModelRuntime(agentDir: string, models: CloudcodeModel[]) {
  let entry = runtimes.get(agentDir);
  if (!entry) {
    entry = {
      runtime: ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      }),
      catalog: "",
    };
    runtimes.set(agentDir, entry);
  }
  const runtime = await entry.runtime;
  const catalog = JSON.stringify([gatewayBaseUrl(), models]);
  if (catalog !== entry.catalog) {
    runtime.registerProvider(PROVIDER_ID, {
      name: "cloudcode.one",
      baseUrl: gatewayBaseUrl(),
      api: "anthropic-messages",
      apiKey: "$CLOUDCODE_TOKEN",
      models: toProviderModels(models),
    });
    entry.catalog = catalog;
  }
  return runtime;
}

// ===========================================================================
// 2. Tool approval — the inline extension
// ===========================================================================
/** pi's built-in tools: read, bash, edit, write (+ grep/find/ls when enabled; powershell
 *  replaces bash on Windows setups that choose it). These change things, so they ask. */
const GATED_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const FILE_TOOLS = new Set(["edit", "write"]);
const MAX_SNAPSHOT_BYTES = 1_000_000;

export type ApprovalResolver = (req: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<{ approved: boolean; reason?: string }>;

/** Mirrors pi's (unexported) resolveToCwd(), which edit/write use: strip a leading "@"
 *  (models echo @-mentions), expand "~", resolve relative to the session cwd. */
const expandPath = (cwd: string, p: string) => {
  let s = p.trim().replace(/^@/, "");
  if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(cwd, s);
};

function readSnapshot(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
    const buf = fs.readFileSync(file);
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch (err) {
    // A write creating a new file diffs against empty; anything else is unknown.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "" : null;
  }
}

/** MCP tools are registered as `mcp__<server>__<tool>` (pi's mcpNamespace()). They ask
 *  too, unless one of the user's own servers marks them read-only (readOnlyHint). */
export const isMcpTool = (name: string) => name.startsWith("mcp__");

/** Server names in an mcp.json. With `definitionsOnly`, only entries that define a server
 *  (command, url or type), not a project's override of a global server's settings. */
function mcpServerNames(file: string, definitionsOnly = false): Set<string> {
  try {
    const servers = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).mcpServers ?? {};
    return new Set(Object.entries(servers)
      .filter(([, v]) => !definitionsOnly || (typeof v === "object" && v !== null && ("command" in v || "url" in v || "type" in v)))
      .map(([name]) => name));
  } catch {
    return new Set();
  }
}

function approvalExtension(
  cwd: string,
  agentDir: string,
  resolve: ApprovalResolver,
  snapshots: Map<string, { path: string; before: string | null }>,
) {
  return (pi: ExtensionAPI) => {
    /** The user's own servers: defined in CodePal's mcp.json and not replaced by the
     *  project's .pi/mcp.json. Read at call time, so edits apply without a restart. */
    const isOwnServer = (server: string) =>
      mcpServerNames(path.join(agentDir, "mcp.json")).has(server) &&
      !mcpServerNames(path.join(cwd, ".pi", "mcp.json"), true).has(server);
    const needsApproval = (toolName: string) => {
      if (GATED_TOOLS.has(toolName)) return true;
      if (!isMcpTool(toolName)) return false;
      const info = pi.getAllTools().find((tool) => tool.name === toolName);
      // readOnlyHint is the server's own claim: trusted only for the user's own servers.
      // Servers from a project (or registered by an extension) always ask.
      const server = info?.namespace?.aliases?.[0];
      const trustedReadOnly = info?.annotations?.readOnlyHint === true && server !== undefined && isOwnServer(server);
      return !trustedReadOnly;
    };
    // Also runs for calls a tool makes through ctx.executeTool() (codemode scripts calling
    // MCP tools): pi routes nested calls through the same tool_call hooks.
    pi.on("tool_call", async (event) => {
      if (!needsApproval(event.toolName)) return undefined;
      const decision = await resolve({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      });
      if (!decision.approved) {
        return { block: true, reason: decision.reason ?? "Denied by the user" };
      }
      // Approved edit/write: snapshot the file right before it changes, so the UI can
      // offer a before/after diff in the editor once the tool finishes.
      const p = (event.input as { path?: unknown }).path;
      if (FILE_TOOLS.has(event.toolName) && typeof p === "string") {
        const abs = expandPath(cwd, p);
        snapshots.set(event.toolCallId, { path: abs, before: readSnapshot(abs) });
      }
      return undefined;
    });
  };
}

// ===========================================================================
// 3. Events — pi AgentSessionEvent -> compact UiEvent
// ===========================================================================
export type UiEvent =
  | { type: "text_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end"; content: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end"; content: string }
  | { type: "status"; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; text: string }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      text: string;
      durationMs?: number;
      file?: { path: string; before: string | null; after: string | null; line?: number };
    }
  | {
      type: "usage";
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number;
    }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | { type: "queue"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "settled"; aborted: boolean };

/** Tool results are { content: (text|image)[], details }; keep the text. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result === "string") return result;
  return result == null ? "" : JSON.stringify(result);
}

function toUiEvents(
  event: AgentSessionEvent,
  snapshots: Map<string, { path: string; before: string | null }>,
): UiEvent[] {
  // Calls issued by another tool (codemode) are reported inside the parent's result.
  if ((event as { parentToolCallId?: string }).parentToolCallId) return [];
  switch (event.type) {
    case "message_update": {
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "text_start": return [{ type: "text_start" }];
        case "text_delta": return [{ type: "text_delta", delta: e.delta }];
        case "text_end": return [{ type: "text_end", content: e.content }];
        case "thinking_start": return [{ type: "thinking_start" }];
        case "thinking_delta": return [{ type: "thinking_delta", delta: e.delta }];
        case "thinking_end": return [{ type: "thinking_end", content: e.content }];
        case "toolcall_start": return [{ type: "status", text: "Preparing a tool call…" }];
        default: return [];
      }
    }
    case "message_end": {
      const m = event.message as {
        role?: string; model?: string; stopReason?: string; errorMessage?: string;
        usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
      };
      if (m.role !== "assistant") return [];
      const out: UiEvent[] = [];
      // A failed request still ends with an all-zero usage record — skip it.
      if (m.usage && (m.usage.input || m.usage.output || m.usage.cacheRead || m.usage.cacheWrite)) {
        out.push({
          type: "usage",
          model: m.model ?? "",
          input: m.usage.input ?? 0,
          output: m.usage.output ?? 0,
          cacheRead: m.usage.cacheRead ?? 0,
          cacheWrite: m.usage.cacheWrite ?? 0,
          cost: m.usage.cost?.total ?? 0,
        });
      }
      if (m.stopReason === "error") out.push({ type: "error", message: m.errorMessage || "Model request failed" });
      return out;
    }
    case "tool_execution_start":
      return [{ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
    case "tool_execution_update":
      return [{ type: "tool_update", toolCallId: event.toolCallId, text: resultText(event.partialResult) }];
    case "tool_execution_end": {
      const end: UiEvent = {
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        text: resultText(event.result),
        durationMs: event.durationMs,
      };
      const snap = snapshots.get(event.toolCallId);
      if (snap) {
        snapshots.delete(event.toolCallId);
        if (!event.isError) {
          const line = (event.result as { details?: { firstChangedLine?: number } })?.details?.firstChangedLine;
          end.file = { path: snap.path, before: snap.before, after: readSnapshot(snap.path), line };
        }
      }
      return [end];
    }
    case "auto_retry_start":
      return [{
        type: "notice",
        message: `Retrying (attempt ${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s — ${event.errorMessage}`,
      }];
    case "auto_retry_end":
      return event.success ? [] : [{ type: "error", message: event.finalError ?? "Retries exhausted" }];
    case "compaction_start":
      return [{ type: "notice", message: "Compacting the conversation to fit the context window…" }];
    case "compaction_end":
      return event.errorMessage
        ? [{ type: "error", message: `Compaction failed: ${event.errorMessage}` }]
        : event.aborted ? [] : [{ type: "notice", message: "Conversation compacted" }];
    case "queue_update":
      return [{ type: "queue", steering: event.steering, followUp: event.followUp }];
    case "agent_settled":
      snapshots.clear(); // drop snapshots of calls an abort cut short
      return [{ type: "settled", aborted: event.aborted }];
    default:
      return [];
  }
}

// ===========================================================================
// 4. Sessions
// ===========================================================================
export interface CreateSessionArgs {
  cwd: string;
  /** pi's global config dir for this app (settings, skills, extensions, auth). */
  agentDir: string;
  model: string;
  /** Catalog from https://cloudcode.one/models.json — becomes the provider's models. */
  models: CloudcodeModel[];
  /** Appended to pi's own system prompt (which documents its tools). */
  appendSystemPrompt?: string;
  onEvent: (event: UiEvent) => void;
  onApprovalRequest: ApprovalResolver;
  /** Asked when the folder has pi project resources that can run code or change the
   *  agent (.pi/extensions, .pi/mcp.json, .pi/settings.json, …) and no decision is saved.
   *  Omitted -> such folders stay untrusted. */
  onProjectTrustRequest?: (cwd: string) => Promise<{ trusted: boolean; remember: boolean }>;
  /** Tests only: a pi Provider (e.g. pi-ai's fauxProvider with scripted replies) that
   *  replaces the cloudcode.one gateway; `model` is then one of its model ids. */
  provider?: Provider;
}

/** pi's SDK treats every project as trusted unless the host decides otherwise, which
 *  would load a cloned repo's .pi/extensions (arbitrary code) the moment a conversation
 *  starts. Decide like pi's CLI does: nothing to gate -> trusted; else a saved decision
 *  (pi's own trust.json, in our agent dir); else ask the user. */
async function resolveProjectTrust(args: CreateSessionArgs): Promise<boolean> {
  if (!hasTrustRequiringProjectResources(args.cwd)) return true;
  const store = new ProjectTrustStore(args.agentDir);
  const saved = store.get(args.cwd);
  if (typeof saved === "boolean") return saved;
  if (!args.onProjectTrustRequest) return false;
  const { trusted, remember } = await args.onProjectTrustRequest(args.cwd);
  if (remember) store.set(args.cwd, trusted);
  return trusted;
}

/** Data URL ("data:image/png;base64,...") -> pi ImageContent. */
function toImage(dataUrl: string) {
  const m = /^data:([^;,]+)(?:;[^,;]+)*;base64,(.*)$/s.exec(dataUrl);
  return m ? { type: "image" as const, mimeType: m[1], data: m[2] } : { type: "image" as const, mimeType: "image/png", data: dataUrl };
}

/** pi's ExtensionUIContext for a host without pi's terminal UI. Notifications go to the
 *  chat as notices; dialogs (MCP OAuth sign-in, "authorize now?") are declined, since
 *  CodePal does not support those yet. Everything else is a TUI affordance and a no-op. */
function codepalUiContext(onEvent: (event: UiEvent) => void): ExtensionUIContext {
  const handlers: Partial<ExtensionUIContext> = {
    notify: (message: string) => onEvent({ type: "notice", message }),
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
  };
  // theme: methods like fg(color, text) / bold(text) return the text unstyled.
  const plainTheme = new Proxy({}, {
    get: (_t, prop) => (typeof prop === "symbol" ? undefined : (...a: unknown[]) => a.findLast((x) => typeof x === "string") ?? ""),
  });
  return new Proxy(handlers, {
    get: (target, prop) => {
      if (prop in target) return target[prop as keyof ExtensionUIContext];
      // Not a thenable, and inspectable: symbols and `then` stay undefined.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "theme") return plainTheme;
      return () => undefined;
    },
  }) as ExtensionUIContext;
}

/** How long dispose() waits for extensions (MCP servers) to shut down. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export async function createCodepalSession(args: CreateSessionArgs) {
  fs.mkdirSync(args.agentDir, { recursive: true });
  // pi's MCP extension reads mcp.json, keeps OAuth state and logs in getAgentDir(), which
  // is ~/.pi/agent (the pi CLI's) unless this is set. CodePal keeps its own.
  process.env.PI_CODING_AGENT_DIR = args.agentDir;
  const modelRuntime = await getModelRuntime(args.agentDir, args.models);
  if (args.provider) modelRuntime.registerNativeProvider(args.provider);
  const providerId = args.provider?.id ?? PROVIDER_ID;
  const findModel = (id: string) => {
    const model = modelRuntime.getModel(providerId, id);
    if (!model) throw new Error(`Unknown model "${id}" — not in the ${providerId} catalog`);
    return model;
  };

  const snapshots = new Map<string, { path: string; before: string | null }>();
  // One settings manager for the loader and the session, untrusted until decided.
  const settingsManager = SettingsManager.create(args.cwd, args.agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: args.cwd,
    agentDir: args.agentDir,
    settingsManager,
    extensionFactories: [
      approvalExtension(args.cwd, args.agentDir, args.onApprovalRequest, snapshots),
      // MCP servers from <agentDir>/mcp.json (+ .pi/mcp.json in trusted projects).
      // codemode runs the scripts that reach MCP tools with the default "codemode"
      // exposure, in a QuickJS sandbox; its tool calls pass the approval hook above.
      createCodemodeExtension(),
      createMcpExtension({ logPath: path.join(args.agentDir, "mcp.log") }),
    ],
    appendSystemPromptOverride: (base: string[]) =>
      args.appendSystemPrompt ? [...base, args.appendSystemPrompt] : base,
  });
  await resourceLoader.reload({ resolveProjectTrust: () => resolveProjectTrust(args) });

  const { session } = await createAgentSession({
    cwd: args.cwd,
    agentDir: args.agentDir,
    modelRuntime,
    model: findModel(args.model),
    thinkingLevel: "off",
    resourceLoader,
    // Conversations live in the window, like Harness; nothing is written to disk.
    sessionManager: SessionManager.inMemory(args.cwd),
    settingsManager,
  });

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    for (const ui of toUiEvents(event, snapshots)) args.onEvent(ui);
  });
  /** session.dispose() does not emit session_shutdown, which is what lets extensions
   *  clean up: the MCP extension closes its connections and stops stdio server processes.
   *  Capped, so a server that never closes cannot hang a folder switch or quit. */
  const shutdown = async () => {
    unsubscribe();
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          new Promise<void>((r) => { timer = setTimeout(r, SHUTDOWN_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
      }
    } catch { /* an extension's cleanup failed; dispose regardless */ }
    session.dispose();
  };

  // Emits session_start to extensions: the MCP extension connects its servers then.
  try {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: codepalUiContext(args.onEvent),
      onError: (err) => args.onEvent({ type: "notice", message: `Extension error: ${err.error}` }),
    });
  } catch (err) {
    await shutdown(); // servers that already started must stop too
    throw err;
  }

  return {
    session: session as AgentSession,
    sessionId: session.sessionId,

    /** Starts a run, or — while one is streaming — queues the message: "steer" lands
     *  after the current tool batch, "followUp" after the run finishes. Resolves when
     *  the message is accepted; the run itself reports through onEvent. */
    send(text: string, images: string[] = [], whileBusy: "steer" | "followUp" = "steer") {
      const imgs = images.map(toImage);
      if (session.isStreaming) {
        return whileBusy === "steer" ? session.steer(text, imgs) : session.followUp(text, imgs);
      }
      // prompt() resolves only after the whole run; report failures as events instead.
      session.prompt(text, { images: imgs }).catch((err: unknown) => {
        args.onEvent({ type: "error", message: String((err as Error)?.message ?? err) });
        args.onEvent({ type: "settled", aborted: false });
      });
      return Promise.resolve("started" as const);
    },

    abort: () => session.abort(),
    setModel: (id: string) => session.setModel(findModel(id)),
    get busy() { return session.isStreaming; },

    /** Stops the session and its extensions (MCP servers included). */
    dispose: shutdown,
  };
}

export type CodepalSession = Awaited<ReturnType<typeof createCodepalSession>>;
