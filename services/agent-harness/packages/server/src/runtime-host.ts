/**
 * RuntimeHost — the single AgentRuntime behind the protocol server (design doc §3).
 *
 * Wiring mirrors `packages/cli/src/main.ts`: ProviderRegistry → resolveHealthy → ToolRegistry →
 * registerBuiltinTools → createTaskTool → registerTaskBoardTools / registerMessageTools →
 * new AgentRuntime({ … }). Nothing here re-implements the loop; the host only owns
 *   · startup health (a dead backend degrades the process instead of crashing it),
 *   · single-flight turn submission + an EventEmitter the SSE endpoint fans out,
 *   · derived state the UI needs (phase, context budget, stats, subagents, approvals).
 */
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import type { PermissionRequest, SessionEvent, ToolManifest, TurnPhase } from "@harness/contracts";
import { TURN_PHASES } from "@harness/contracts";
import {
  AgentMessageChannel,
  AgentRuntime,
  MemoryManager,
  ProviderRegistry,
  SharedTaskBoard,
  ToolRegistry,
  TraceWriter,
  createTaskTool,
  estimateTokens,
  loadConfig,
  registerBuiltinTools,
  registerMessageTools,
  registerTaskBoardTools,
  type HarnessConfig,
  type CustomModelInput,
  type OllamaRunner,
  type ResolvedModel,
  SkillRegistry,
  SkillError,
  type SkillManifest,
} from "@harness/core";
import {
  classifyFile,
  isMediaFile,
  lazyKnowledgeBase,
  parseFile,
  registerKbTools,
  type CleanOptions,
  type ChunkOptions,
  type KbPreview,
  type KbRemoveResult,
  type IngestReport,
  type LazyKnowledgeBase,
  DEFAULT_KB_DB_PATH,
} from "@harness/kb";

/** Same instruction as the CLI surface — one agent, many surfaces. */
const SYSTEM_PROMPT =
  "You are a precise personal agent. Use tools to accomplish the user's goal. " +
  "Validate assumptions with tools instead of guessing. Report key evidence (paths, command output) in your final answer. " +
  "如果被要求协作，用 task:list/task:claim 认领任务，用 msg:send 与其他 agent 通信。" +
  "用户提到「我的/我们」的文档（简历、笔记、合同等）优先查知识库：kb:search 用具体关键词" +
  "（人名、公司、技术名词、文件名词），不要用「我的XX」这类代词短语；结果无关就换关键词，" +
  "或用 kb:sources 浏览已索引的文件列表找到目标来源后再 kb:read，最后才考虑扫描磁盘。";

/** 智能问答 mode: no tools exist in this mode, so the prompt must not promise them. */
const CHAT_SYSTEM_PROMPT =
  "你是一个乐于助人的中文问答助手。直接、准确地回答用户的问题；" +
  "涉及事实与数据时如实说明不确定性。当前处于纯问答模式，不能执行工具或访问外部数据。";

/** A pending approval nobody answers is denied after five minutes (design doc §6). */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Tool output kept in the SSE payload; the UI only renders the first 200 characters. */
const OUTPUT_PREVIEW_CHARS = 2000;

/** Input summary kept for the tool card / approval card. */
const INPUT_PREVIEW_CHARS = 240;

/** Background KB ingest job (design §5.2 admin): media files can take minutes. */
interface KbIngestJob {
  id: string;
  paths: string[];
  force: boolean;
  /** Echo of the clean/chunk knobs so the UI can show what settings a job used. */
  clean: CleanOptions | null;
  chunk: ChunkOptions | null;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  /** Current file cursor while running; null when idle/finished. */
  progress: { file: string; index: number; total: number } | null;
  report: IngestReport | null;
  error: string | null;
}

/**
 * UI-facing events kept for replay (design doc §6 "session continuity"). A browser refresh
 * reconnects via SSE and receives this buffer before live events, so the chat can be rebuilt.
 * The buffer is also persisted as JSONL so a server restart restores the last session too.
 * Deltas are NOT recorded: `message_appended` carries the full assistant text once streaming ends.
 */
interface TranscriptEntry {
  kind: "session" | "tool_input" | "tool_result" | "turn" | "compaction";
  payload: unknown;
  at: number;
}

const TRANSCRIPT_MEMORY_LIMIT = 4000;
/** After this many appends the JSONL file is rewritten with just the tail (keeps it bounded). */
const TRANSCRIPT_REWRITE_INTERVAL = 5000;

export type ApprovalDecision = "allowed" | "denied" | "always";

export type HostStatus = "starting" | "ready" | "degraded";

export interface PhaseSnapshot {
  phase: TurnPhase;
  state: "pending" | "active" | "done";
  durationMs: number | null;
}

export interface ContextSnapshot {
  window: number;
  used: number;
  percent: number;
  /** Four buckets the UI paints as one stacked bar. */
  segments: {
    system: number;
    memory: number;
    history: number;
    observations: number;
  };
}

export interface SubagentSnapshot {
  id: string;
  profile: string;
  background: boolean;
  worktree?: string;
  status: "running" | "done";
  spawnedAt: number;
}

export interface ApprovalSnapshot {
  requestId: string;
  tool: string;
  level: string;
  input: string;
  createdAt: number;
  expiresAt: number;
}

export interface StatsSnapshot {
  turns: number;
  toolCalls: number;
  parallelWaves: number;
  iterations: number;
  lastDurationMs: number | null;
}

export interface HealthSnapshot {
  ok: boolean;
  status: HostStatus;
  model: string;
  provider: string;
  qdrant: "online" | "offline" | "unknown";
  degraded: boolean;
  toolCalling: boolean;
  contextWindow: number;
  hint?: string;
}

export interface HostSnapshot {
  status: HostStatus;
  busy: boolean;
  agentId: string | null;
  traceId: string;
  /** true = 智能体（工具全开），false = 智能问答（纯对话）。 */
  agentMode: boolean;
  phase: TurnPhase | null;
  phases: PhaseSnapshot[];
  context: ContextSnapshot;
  stats: StatsSnapshot;
  subagents: SubagentSnapshot[];
  approvals: ApprovalSnapshot[];
  health: HealthSnapshot;
  startedAt: number;
}

/** Structured failures — the HTTP layer maps `code`/`status` onto a response. */
export class HostBusyError extends Error {
  readonly code = "TURN_BUSY";
  readonly status = 409;
  constructor(message = "上一轮仍在执行，请等待结束或先中断") {
    super(message);
    this.name = "HostBusyError";
  }
}

export class HostUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE";
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "HostUnavailableError";
  }
}

export interface RuntimeHostOptions {
  cwd?: string;
  systemPrompt?: string;
  /** Diagnostic sink (defaults to stderr). */
  onLog?: (line: string) => void;
}

interface PendingApproval {
  request: PermissionRequest;
  manifest: ToolManifest;
  resolve: (outcome: "allowed" | "denied") => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface PhaseState {
  phase: TurnPhase;
  state: "pending" | "active" | "done";
  startedAt: number | null;
  durationMs: number | null;
}

/** Resolve "~"/"~/x" and relative input against the home directory (path picker inputs). */
function resolveFsPath(input: string): string {
  const raw = input.trim();
  if (raw === "~" || raw.startsWith("~/")) return join(homedir(), raw.slice(1));
  return resolve(raw);
}

// -------------------------------------------------------------------------------------------
// custom online models (web UI「添加线上模型」) — persisted at ~/.harness/models.json
// -------------------------------------------------------------------------------------------

const CUSTOM_MODELS_FILE = join(homedir(), ".harness", "models.json");
/** In-memory mirror of models.json; the registry holds the live entries. */
const customModels: CustomModelInput[] = [];

/** Load persisted custom models; malformed/missing file just means an empty list. */
function loadCustomModels(): CustomModelInput[] {
  try {
    const parsed = JSON.parse(readFileSync(CUSTOM_MODELS_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as CustomModelInput).baseUrl === "string" && typeof (item as CustomModelInput).model === "string") {
        customModels.push(item as CustomModelInput);
      }
    }
  } catch {
    // Missing or unreadable file — first run or user edit; start empty.
  }
  return customModels;
}

/** Write the in-memory mirror back to disk (0600 not available via writeFileSync options; best-effort). */
function saveCustomModels(): void {
  try {
    mkdirSync(dirname(CUSTOM_MODELS_FILE), { recursive: true });
    writeFileSync(CUSTOM_MODELS_FILE, `${JSON.stringify(customModels, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`⚠ 保存自定义模型失败: ${err instanceof Error ? err.message : err}`);
  }
}

/** Read exactly the first `max` bytes without loading the whole file into memory. */
function readFirstBytes(file: string, max: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const read = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function freshPhases(): PhaseState[] {
  return TURN_PHASES.map((phase) => ({ phase, state: "pending", startedAt: null, durationMs: null }));
}

/**
 * Re-register every entry behind an input-capturing wrapper. The registry has no mutation API and
 * session events do not carry tool input, so this is the only way the UI can show "what did the
 * agent ask for" without touching core.
 */
function withInputCapture(
  source: ToolRegistry,
  onInput: (tool: string, input: unknown) => void,
): ToolRegistry {
  const wrapped = new ToolRegistry();
  for (const manifest of source.list()) {
    const entry = source.get(manifest.name);
    if (!entry) continue;
    wrapped.register(manifest, async (input) => {
      onInput(manifest.name, input);
      return entry.execute(input);
    });
  }
  return wrapped;
}

export function summarizeInput(input: unknown, max = INPUT_PREVIEW_CHARS): string {
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class RuntimeHost extends EventEmitter {
  readonly config: HarnessConfig;
  readonly providers: ProviderRegistry;
  readonly startedAt = Date.now();

  private readonly cwd: string;
  private readonly systemPrompt: string;
  private readonly memory: MemoryManager;
  private readonly trace: TraceWriter;
  private readonly log: (line: string) => void;

  private status: HostStatus = "starting";
  private degradedReason: string | undefined;
  private resolved: ResolvedModel | null = null;
  private runtime: AgentRuntime | null = null;
  private registry: ToolRegistry | null = null;
  private agentId: string | null = null;

  private busy = false;
  /** 智能体（工具）vs 智能问答（纯对话）——runtime 级开关，跨模型切换保留。 */
  private agentMode = true;
  private currentTraceId = "";
  private phase: TurnPhase | null = null;
  private phases: PhaseState[] = freshPhases();

  private memoryContextText = "";
  private tokens = { system: 0, memory: 0, history: 0, observations: 0 };

  private readonly stats: StatsSnapshot = {
    turns: 0,
    toolCalls: 0,
    parallelWaves: 0,
    iterations: 0,
    lastDurationMs: null,
  };
  private readonly waves = new Set<string>();

  private readonly subagents = new Map<string, SubagentSnapshot>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly alwaysAllowed = new Set<string>();

  /** UI-facing event buffer for browser-refresh replay (see TranscriptEntry). */
  private readonly transcript: TranscriptEntry[] = [];
  private readonly sessionFile: string;
  private transcriptAppends = 0;

  /** callIds waiting for their result, per tool name (results arrive in submission order). */
  private readonly startedCalls = new Map<string, string[]>();
  /** Parallel queue for input capture — the wrapper runs before the result callback. */
  private readonly inputCapture = new Map<string, string[]>();

  private qdrant: "online" | "offline" | "unknown" = "unknown";
  private qdrantCheckedAt = 0;

  /**
   * Knowledge base (design doc §5.2) — lazy handle shared across runtime rebuilds: kb.db opens
   * on the first tool call or admin API hit, never at server boot. Survives model hot-swaps.
   */
  private readonly kb: LazyKnowledgeBase = lazyKnowledgeBase();
  /** Skills (§10.1) — rescanned before every turn; the handle itself is stateless. */
  private readonly skills = new SkillRegistry();
  /** Skill block active for the in-flight turn (cleared when it settles). */
  private activeSkillSlash: string | null = null;
  /** KB ingest background jobs — last 20 kept for the UI progress poll. */
  private readonly kbJobs = new Map<string, KbIngestJob>();

  constructor(options: RuntimeHostOptions = {}) {
    super();
    this.setMaxListeners(64);
    this.cwd = options.cwd ?? process.cwd();
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.log = options.onLog ?? ((line) => console.error(line));

    this.config = loadConfig();
    this.providers = new ProviderRegistry(this.config);
    for (const entry of loadCustomModels()) this.providers.registerCustom(entry);
    this.memory = new MemoryManager(this.cwd);
    this.trace = new TraceWriter(join(this.cwd, "traces"));

    this.sessionFile =
      process.env.HARNESS_SESSION_FILE ?? join(homedir(), ".harness", "sessions", "web.jsonl");
    this.loadTranscript();

    this.tokens.system = estimateTokens(this.systemPrompt) + 4;
  }

  /**
   * Health-check the backend and build the runtime. A dead model leaves the process alive in
   * `degraded` state so `/api/health` can explain what to start (design doc §15.2).
   */
  async start(): Promise<void> {
    try {
      this.resolved = await this.providers.resolveHealthy(this.config.model.default);
    } catch (err) {
      this.status = "degraded";
      this.degradedReason =
        `${err instanceof Error ? err.message : String(err)} — 启动本地模型: ollama serve`;
      this.log(`✖ 模型后端不可用：${this.degradedReason}`);
      this.emit("state", this.snapshot());
      return;
    }

    if (this.resolved.degraded) {
      this.log(`⚠ 模型 ${this.config.model.default} 不可用，已降级到 ${this.resolved.provider}/${this.resolved.model}`);
    }

    this.buildRuntime(this.resolved);
    this.status = "ready";
    this.log(
      `✓ runtime ${this.agentId} · model ${this.resolved.model} (${this.resolved.provider}) · ` +
        `ctx ${this.resolved.capabilities.contextWindow}`,
    );
    void this.refreshQdrant();
    this.emit("state", this.snapshot());
  }

  private buildRuntime(resolved: ResolvedModel): void {
    // AgentRuntime still types `runner` as OllamaRunner; every adapter satisfies the same chat().
    const runner = resolved.adapter as unknown as OllamaRunner;

    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    // M6: kb:search / kb:read — the lazy handle opens kb.db only on the first actual call.
    registerKbTools(registry, this.kb);

    const taskTool = createTaskTool({
      parentConfig: this.config,
      runner,
      parentRegistry: registry,
      approvalHandler: this.approvalHandler,
      systemPrompt: this.systemPrompt,
      // Child events are mirrored for the subagent panel only — they never touch parent stats.
      onEvent: (event) => this.handleEvent(event),
    });
    registry.register(taskTool.manifest, taskTool.execute);

    const board = new SharedTaskBoard(this.cwd);
    const messages = new AgentMessageChannel(this.cwd);
    registerTaskBoardTools(registry, board, { agentId: () => this.agentId ?? "web" });
    registerMessageTools(registry, messages, { agentId: () => this.agentId ?? "web" });

    this.registry = withInputCapture(registry, (tool, input) => this.noteToolInput(tool, input));

    const runtime = new AgentRuntime({
      runner,
      registry: this.registry,
      config: this.config,
      systemPrompt: this.systemPrompt,
      onEvent: (event) => this.handleEvent(event),
      onDelta: (text) => this.emit("delta", { text, traceId: this.currentTraceId }),
      onToolResult: (tool, status, output, durationMs) =>
        this.noteToolResult(tool, status, output, durationMs),
      approvalHandler: this.approvalHandler,
      contextWindow: resolved.capabilities.contextWindow,
    });

    this.runtime = runtime;
    this.agentId = runtime.id;
    // Mode survives model switches: a chat-mode user switching models stays in chat mode.
    this.applyAgentMode(runtime);

    this.memoryContextText = this.memory.loadMemoryContext();
    runtime.setMemoryContext(this.memoryContextText);
    this.tokens.memory = estimateTokens(this.memoryContextText);
  }

  /** Apply the current mode to a runtime (fresh build or live toggle). */
  private applyAgentMode(runtime: AgentRuntime): void {
    runtime.setToolsEnabled(this.agentMode);
    runtime.setSystemPrompt(this.agentMode ? SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT);
  }

  /** 智能体 <-> 智能问答 toggle. Conversation carries over; busy turns must finish first. */
  setAgentMode(enabled: boolean): { agentMode: boolean } {
    if (this.busy) throw new HostBusyError();
    this.agentMode = enabled;
    if (this.runtime) this.applyAgentMode(this.runtime);
    this.emit("state", this.snapshot());
    return { agentMode: this.agentMode };
  }

  // -------------------------------------------------------------------------------------------
  // turns
  // -------------------------------------------------------------------------------------------

  /**
   * Single-flight: a second turn while one runs is a structured `busy` error, not a queue.
   * The traceId is available synchronously because `runTurn` emits `turn_started` before its
   * first await — the HTTP layer can answer 202 immediately.
   */
  submitTurn(text: string): { traceId: string } {
    if (this.status !== "ready" || !this.runtime) {
      throw new HostUnavailableError(
        this.degradedReason ?? "运行时尚未就绪（模型后端不可用或仍在启动）",
      );
    }
    if (this.busy) throw new HostBusyError();

    // §10.1 dual-channel activation, resolved before the turn starts:
    //   explicit slash — unknown command errors out (a slash is a strong signal);
    //   implicit keywords — every matching skill is injected silently.
    let skillContext = "";
    this.activeSkillSlash = null;
    try {
      const slashHit = this.skills.resolveSlash(text);
      if (slashHit) {
        skillContext = this.skills.renderContext([slashHit]);
        this.activeSkillSlash = slashHit.skill.slash;
        this.log(`⌘ 技能激活（斜杠）: ${slashHit.skill.slash}${slashHit.args ? ` · 参数: ${slashHit.args}` : ""}`);
      } else {
        const keywordHits = this.skills.matchKeywords(text);
        if (keywordHits.length) {
          skillContext = this.skills.renderContext(keywordHits.map((skill) => ({ skill })));
          this.activeSkillSlash = keywordHits[0]?.slash ?? null;
          this.log(`⌘ 技能激活（关键词）: ${keywordHits.map((s) => s.slash).join(", ")}`);
        }
      }
    } catch (err) {
      if (err instanceof SkillError) {
        const e = new Error(err.message) as Error & { code: string; status: number };
        e.code = err.code;
        e.status = 400;
        throw e;
      }
      throw err;
    }

    const runtime = this.runtime;
    if (skillContext) runtime.setSkillContext(skillContext);
    this.busy = true;
    this.currentTraceId = "";
    this.tokens.history += estimateTokens(text) + 4;

    const promise = runtime.runTurn(text);
    const traceId = this.currentTraceId || randomUUID().slice(0, 8);
    this.currentTraceId = traceId;

    // The user bubble is part of the transcript so a refresh rebuilds every session's
    // question alongside its answer (the web UI renders it from this event).
    const userEvent = {
      type: "user_message" as const,
      traceId,
      text,
      timestamp: Date.now(),
    };
    this.record("session", userEvent);
    this.emit("session", userEvent);

    promise
      .then((summary) => {
        this.stats.lastDurationMs = summary.durationMs;
        this.stats.iterations = summary.iterations;
        const payload = { ...summary, traceId: summary.traceId || traceId };
        this.record("turn", payload);
        this.emit("turn", payload);
      })
      .catch((err: unknown) => {
        const payload = {
          traceId,
          reason: "error",
          iterations: this.stats.iterations,
          durationMs: 0,
          text: err instanceof Error ? err.message : String(err),
        };
        this.record("turn", payload);
        this.emit("turn", payload);
      })
      .finally(() => {
        if (this.activeSkillSlash) {
          runtime.setSkillContext("");
          this.activeSkillSlash = null;
        }
        this.busy = false;
        this.phase = null;
        this.emit("state", this.snapshot());
      });

    this.emit("state", this.snapshot());
    return { traceId };
  }

  /**
   * Interrupt. Core's cancel capability lands in a parallel change, so it is looked up
   * dynamically: no `runtime.cancel` today means "unsupported", never a crash.
   */
  cancel(): "cancelled" | "idle" | "unsupported" {
    const runtime = this.runtime;
    if (!runtime) return "unsupported";

    const cancel = (runtime as { cancel?: (reason?: string) => void }).cancel;
    if (typeof cancel !== "function") return "unsupported";

    const wasBusy = this.busy;
    cancel.call(runtime, "user");
    return wasBusy ? "cancelled" : "idle";
  }

  // -------------------------------------------------------------------------------------------
  // approvals
  // -------------------------------------------------------------------------------------------

  /** Surface-layer hook handed to AgentRuntime; the promise is settled by POST /api/approve. */
  private approvalHandler = (request: PermissionRequest, manifest: ToolManifest): Promise<"allowed" | "denied"> => {
    const tool = request.call.tool;
    if (this.alwaysAllowed.has(tool)) return Promise.resolve("allowed");

    const requestId = request.call.id;
    return new Promise<"allowed" | "denied">((resolve) => {
      const timer = setTimeout(() => {
        this.finishApproval(requestId, "denied");
        this.log(`⏱ 审批超时（5 分钟），已自动拒绝 ${tool}`);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();

      const createdAt = Date.now();
      this.pendingApprovals.set(requestId, { request, manifest, resolve, timer, createdAt });
      this.emit("approval", {
        requestId,
        tool,
        level: request.level,
        input: summarizeInput(request.call.input),
        createdAt,
        expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
      });
      this.emit("state", this.snapshot());
    });
  };

  /** Returns false when the requestId is unknown (already decided / timed out). */
  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    if (decision === "always") this.alwaysAllowed.add(pending.request.call.tool);
    return this.finishApproval(requestId, decision === "denied" ? "denied" : "allowed");
  }

  private finishApproval(requestId: string, outcome: "allowed" | "denied"): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    this.emit("approval_resolved", { requestId, tool: pending.request.call.tool, outcome });
    pending.resolve(outcome);
    this.emit("state", this.snapshot());
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // event derivation
  // -------------------------------------------------------------------------------------------

  private handleEvent(event: SessionEvent): void {
    if (event.type === "subagent_spawned") {
      this.subagents.set(event.childRuntimeId, {
        id: event.childRuntimeId,
        profile: event.profile,
        background: event.background,
        ...(event.worktree ? { worktree: event.worktree } : {}),
        status: "running",
        spawnedAt: event.timestamp,
      });
      this.emit("state", this.snapshot());
      return;
    }

    const child = this.subagents.get(event.traceId);
    if (child) {
      if (event.type === "turn_completed") {
        child.status = "done";
        this.emit("state", this.snapshot());
      }
      return;
    }

    this.trace.write(event);
    this.noteEvent(event);
    this.record("session", event);
    this.emit("session", event);
    this.emit("state", this.snapshot());
  }

  private noteEvent(event: SessionEvent): void {
    switch (event.type) {
      case "turn_started": {
        this.currentTraceId = event.traceId;
        this.stats.turns++;
        this.stats.iterations = 0;
        this.startedCalls.clear();
        this.inputCapture.clear();
        this.phases = freshPhases();
        // TurnMachine starts in processing_input without emitting a transition for it.
        const first = this.phases[0];
        if (first) {
          first.state = "active";
          first.startedAt = Date.now();
        }
        this.phase = "processing_input";
        break;
      }

      case "phase_changed": {
        const now = Date.now();
        for (const item of this.phases) {
          if (item.state === "active") {
            item.state = "done";
            item.durationMs = now - (item.startedAt ?? now);
          }
        }
        const target = this.phases.find((item) => item.phase === event.to);
        if (target) {
          target.state = "active";
          target.startedAt = now;
          target.durationMs = null;
          this.phase = target.phase;
        }
        break;
      }

      case "message_appended": {
        const text = event.message.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("");
        this.tokens.history += estimateTokens(text) + 4;
        break;
      }

      case "tool_call_started": {
        this.stats.toolCalls++;
        if (event.parallel) {
          const key = `${event.traceId}:${event.wave}`;
          if (!this.waves.has(key)) {
            this.waves.add(key);
            this.stats.parallelWaves = this.waves.size;
          }
        }
        const queue = this.startedCalls.get(event.tool) ?? [];
        queue.push(event.callId);
        this.startedCalls.set(event.tool, queue);
        const captureQueue = this.inputCapture.get(event.tool) ?? [];
        captureQueue.push(event.callId);
        this.inputCapture.set(event.tool, captureQueue);
        break;
      }

      case "turn_completed": {
        this.stats.iterations = event.iterations;
        const now = Date.now();
        for (const item of this.phases) {
          if (item.state === "active") {
            item.state = "done";
            item.durationMs = now - (item.startedAt ?? now);
          }
        }
        break;
      }

      case "compaction_triggered": {
        const payload = {
          level: event.level,
          tokensBefore: event.tokensBefore,
          tokensAfter: event.tokensAfter,
        };
        this.record("compaction", payload);
        this.emit("compaction", payload);
        break;
      }

      default:
        break;
    }
  }

  /** Wrapper hook: the callId is the next started call of the same tool (submission order). */
  private noteToolInput(tool: string, input: unknown): void {
    const callId = this.inputCapture.get(tool)?.shift() ?? "";
    const payload = { callId, tool, traceId: this.currentTraceId, input: summarizeInput(input) };
    this.record("tool_input", payload);
    this.emit("tool_input", payload);
  }

  private noteToolResult(tool: string, status: string, output: string, durationMs: number): void {
    const callId = this.startedCalls.get(tool)?.shift() ?? "";
    this.tokens.observations += estimateTokens(output) + 4;
    const payload = {
      callId,
      tool,
      traceId: this.currentTraceId,
      status,
      durationMs,
      output: output.length > OUTPUT_PREVIEW_CHARS ? `${output.slice(0, OUTPUT_PREVIEW_CHARS)}…` : output,
    };
    this.record("tool_result", payload);
    this.emit("tool_result", payload);
  }

  // -------------------------------------------------------------------------------------------
  // transcript (replay buffer + JSONL persistence)
  // -------------------------------------------------------------------------------------------

  /** Events the UI can replay after a refresh or a server restart. */
  replay(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** Load the persisted JSONL back into the buffer. A missing/corrupt file is not fatal. */
  private loadTranscript(): void {
    try {
      const raw = readFileSync(this.sessionFile, "utf8");
      const entries: TranscriptEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as TranscriptEntry;
          if (parsed && typeof parsed.kind === "string" && "payload" in parsed) {
            entries.push(parsed);
          }
        } catch {
          /* skip torn line (crash mid-append) */
        }
      }
      this.transcript.push(...entries.slice(-TRANSCRIPT_MEMORY_LIMIT));
      if (this.transcript.length > 0) {
        this.log(`✓ 已恢复会话记录：${this.transcript.length} 条事件（${this.sessionFile}）`);
      }
    } catch {
      /* first boot or file removed — start empty */
    }
  }

  /** Append to the in-memory ring and the JSONL file (append-only, rewritten periodically). */
  private record(kind: TranscriptEntry["kind"], payload: unknown): void {
    const entry: TranscriptEntry = { kind, payload, at: Date.now() };
    this.transcript.push(entry);
    if (this.transcript.length > TRANSCRIPT_MEMORY_LIMIT) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_MEMORY_LIMIT);
    }

    try {
      mkdirSync(join(this.sessionFile, ".."), { recursive: true });
      appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
      if (++this.transcriptAppends % TRANSCRIPT_REWRITE_INTERVAL === 0) {
        this.rewriteTranscriptFile();
      }
    } catch (err) {
      this.log(`⚠ 会话记录写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Compact the JSONL to the current buffer so it cannot grow without bound. */
  private rewriteTranscriptFile(): void {
    try {
      mkdirSync(join(this.sessionFile, ".."), { recursive: true });
      const body = this.transcript.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(this.sessionFile, body ? `${body}\n` : "", "utf8");
      this.log(`✓ 会话记录已压实：${this.transcript.length} 条（${this.sessionFile}）`);
    } catch (err) {
      this.log(`⚠ 会话记录压实失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // model hot-swap (design doc §15.4)
  // -------------------------------------------------------------------------------------------

  /** Models the picker shows: config-declared + actually installed on the ollama backend. */
  async listModels(): Promise<{ current: string; models: Array<{ model: string; provider: string; declared: boolean; custom: boolean }> }> {
    const models = await this.providers.listAvailable();
    return { current: this.resolved?.model ?? this.config.model.default, models };
  }

  /**
   * Add a user-defined online model (OpenAI-compatible URL + key + id + context window).
   * Registered into the live registry immediately and persisted to ~/.harness/models.json
   * so it survives restarts. Returns the refreshed picker payload.
   */
  addCustomModel(input: CustomModelInput): Promise<{ model: string; provider: string }> {
    const url = (input.baseUrl ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Base URL 必须以 http:// 或 https:// 开头，收到 "${url}"`);
    const provider = this.providers.registerCustom(input);
    // Registry accepted it — mirror to the persistence list and flush to disk.
    const entry: CustomModelInput = {
      name: provider,
      baseUrl: url,
      apiKey: input.apiKey?.trim() || undefined,
      model: input.model.trim(),
      contextWindow: input.contextWindow,
      apiFormat: input.apiFormat,
    };
    for (const key of ["name", "apiKey", "contextWindow", "apiFormat"] as const) {
      if (entry[key] === undefined) delete entry[key];
    }
    customModels.push(entry);
    saveCustomModels();
    return Promise.resolve({ model: entry.model, provider });
  }

  /** Remove a custom online model by provider label. The active model cannot be removed. */
  removeCustomModel(provider: string): { removed: boolean } {
    if (this.resolved?.provider === provider) {
      throw new Error("该模型正在使用中，请先切换到其他模型再删除");
    }
    const removed = this.providers.removeCustom(provider);
    if (removed) {
      const index = customModels.findIndex((entry) => entry.name === provider);
      if (index >= 0) customModels.splice(index, 1);
      saveCustomModels();
    }
    return { removed };
  }

  /**
   * Edit a custom online model in place (web UI ✎). The active model is protected —
   * editing its URL/key would leave this.resolved pointing at a stale adapter. Empty
   * apiKey keeps the stored one; a health probe is NOT run here (switch re-probes).
   */
  updateCustomModel(provider: string, input: CustomModelInput): Promise<{ model: string; provider: string }> {
    if (this.resolved?.provider === provider) {
      throw new Error("该模型正在使用中，请先切换到其他模型再修改");
    }
    const url = (input.baseUrl ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Base URL 必须以 http:// 或 https:// 开头，收到 "${url}"`);
    const newProvider = this.providers.updateCustom(provider, input);
    // Mirror to the persistence list keyed by the old provider label.
    const index = customModels.findIndex((entry) => entry.name === provider);
    if (index >= 0) {
      const stored = customModels[index];
      if (stored) {
        stored.name = newProvider;
        stored.baseUrl = url;
        stored.model = input.model.trim();
        stored.apiFormat = input.apiFormat ?? stored.apiFormat;
        if (input.contextWindow && Number.isFinite(input.contextWindow)) stored.contextWindow = input.contextWindow;
        const key = input.apiKey?.trim();
        if (key) stored.apiKey = key;
      }
      saveCustomModels();
    }
    return Promise.resolve({ model: input.model.trim(), provider: newProvider });
  }

  /**
   * Rebuild the runtime on another model, carrying the conversation over. Single-flight with
   * turns: a switch while busy is a structured busy error, never a mid-turn runner swap.
   */
  async switchModel(model: string): Promise<{ model: string; provider: string }> {
    if (this.busy) throw new HostBusyError();
    if (!this.resolved) {
      throw new HostUnavailableError(this.degradedReason ?? "运行时尚未就绪，无法切换模型");
    }

    // A custom online model must come up healthy — silently landing on the ollama
    // fallback would make the user believe they switched when they did not.
    const resolved = await this.providers.resolveHealthy(model, { noFallback: this.providers.isCustomModel(model) });
    if (resolved.model === this.resolved.model && resolved.provider === this.resolved.provider) {
      return { model: resolved.model, provider: resolved.provider }; // no-op switch
    }

    const previous = this.runtime;
    const conversation = previous?.exportConversation() ?? [];
    const oldAgentId = this.agentId;
    const oldModel = this.resolved.model;

    this.resolved = resolved;
    this.buildRuntime(resolved);
    this.runtime?.loadConversation(conversation);

    // Context accounting restarts from the carried-over history (system + memory are re-added).
    this.tokens.history = conversation.reduce((sum, m) => sum + estimateTokens(String(m.content ?? "")) + 4, 0);
    this.tokens.observations = 0;

    this.log(
      `⇄ 模型切换 ${oldAgentId}(${oldModel}) → ${this.agentId}(${resolved.model}) · ` +
        `携带 ${conversation.length} 条历史消息`,
    );
    this.emit("state", this.snapshot());
    return { model: resolved.model, provider: resolved.provider };
  }

  // -------------------------------------------------------------------------------------------
  // knowledge base admin (design doc §5.2) — thin proxies over the lazy KB handle
  // -------------------------------------------------------------------------------------------

  /** Status for the UI panel: db stats + Qdrant health. Fails structured when kb.db can't open. */
  async kbStatus() {
    const stats = await this.kb.stats();
    return {
      ...stats,
      qdrant: this.qdrant,
      embedModel: "qwen3-embedding:0.6b",
      agentTools: ["kb:search", "kb:read", "kb:sources"],
    };
  }

  kbSources(opts: { page?: number; pageSize?: number; q?: string; type?: string; all?: boolean } = {}) {
    // Filter + paginate in the server: personal-scale data fits memory, and the
    // admin page needs stable paged slices with a total count. `all` returns every
    // match (capped) for the tree view, which builds its own hierarchy client-side.
    const all = this.kb.listSources();
    const q = (opts.q ?? "").trim().toLowerCase();
    const type = opts.type ?? "all";
    const mediaKinds = new Set(["video", "audio", "image"]);
    const filtered = all.filter((s) => {
      if (q && !s.path.toLowerCase().includes(q)) return false;
      if (type === "document") return !mediaKinds.has(s.type);
      if (type !== "all" && s.type !== type) return false;
      return true;
    });
    const total = filtered.length;
    if (opts.all === true) {
      const sources = filtered.slice(0, 10000).map(({ id, path, type, mtime, chunkCount }) => ({ id, path, type, mtime, chunkCount }));
      return { sources, total, all: true as const };
    }
    const pageSize = Math.min(Math.max(opts.pageSize ?? 20, 5), 100);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(opts.page ?? 1, 1), totalPages);
    const sources = filtered
      .slice((page - 1) * pageSize, page * pageSize)
      .map(({ id, path, type, mtime, chunkCount }) => ({ id, path, type, mtime, chunkCount }));
    return { sources, total, page, pageSize, totalPages };
  }

  kbIngest(
    paths: string[],
    opts: { force?: boolean; clean?: CleanOptions; chunk?: ChunkOptions } = {},
  ): { jobId: string } {
    // Media ingest runs minutes (ffmpeg+vision+whisper) — hand it to a background job
    // and let the UI poll /api/kb/jobs/:id for progress.
    const clean = opts.clean && typeof opts.clean === "object" ? opts.clean : null;
    const chunk = opts.chunk && typeof opts.chunk === "object" ? opts.chunk : null;
    const jobId = randomUUID().slice(0, 8);
    const job: KbIngestJob = {
      id: jobId,
      paths: [...paths],
      force: opts.force === true,
      clean,
      chunk,
      status: "running",
      startedAt: Date.now(),
      progress: null,
      report: null,
      error: null,
    };
    this.kbJobs.set(jobId, job);
    while (this.kbJobs.size > 20) {
      const oldest = this.kbJobs.keys().next().value;
      if (oldest === undefined) break;
      this.kbJobs.delete(oldest);
    }
    void this.kb
      .ingest(paths, {
        force: job.force,
        ...(clean ? { clean } : {}),
        ...(chunk ? { chunk } : {}),
        onProgress: (progress) => {
          job.progress = { file: progress.file, index: progress.index, total: progress.total };
        },
      })
      .then((report) => {
        job.status = "done";
        job.report = report;
        job.finishedAt = Date.now();
        job.progress = null;
      })
      .catch((err: unknown) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = Date.now();
        job.progress = null;
      });
    return { jobId };
  }

  kbJobsList(): Array<KbIngestJob> {
    return [...this.kbJobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  kbJob(jobId: string): KbIngestJob | undefined {
    return this.kbJobs.get(jobId);
  }

  kbRemoveSource(path: string): Promise<KbRemoveResult> {
    return this.kb.removeSource(path);
  }

  /** Dry-run clean+chunk for one file — powers the admin "预览切片" button. */
  kbPreview(file: string, opts: { clean?: CleanOptions; chunk?: ChunkOptions } = {}): KbPreview {
    return this.kb.previewIngest(file, opts);
  }

  // -------------------------------------------------------------------------------------------
  // filesystem browse/read (admin UI: import path picker + source preview/download)
  // -------------------------------------------------------------------------------------------

  /** The agent's working directory — root of the workspace file manager (files it produced). */
  workspaceDir(): string {
    return this.cwd;
  }

  // -------------------------------------------------------------------------------------------
  // data viewer (admin UI): SQLite kb.db inspector + Qdrant collection browser
  // -------------------------------------------------------------------------------------------

  /** SQLite file backing the knowledge base. */
  private kbDbFile(): string {
    return DEFAULT_KB_DB_PATH;
  }

  /** Open kb.db read-only for a one-shot query; throws structured on missing/corrupt. */
  private openKbDbReadonly(): DatabaseSync {
    const file = this.kbDbFile();
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`数据库文件不存在: ${file}`);
    // node:sqlite read-only mode — the viewer must never mutate kb.db.
    return new DatabaseSync(`file:${file}?mode=ro`, { readOnly: true });
  }

  /** Tables + row counts + column lists for the viewer's table browser. */
  dbInspect(): {
    path: string;
    tables: Array<{ name: string; count: number; columns: string[] }>;
  } {
    const file = this.kbDbFile();
    const db = this.openKbDbReadonly();
    try {
      const tables: Array<{ name: string; count: number; columns: string[] }> = [];
      // user tables only — skip sqlite_* internals and FTS shadow tables (chunks_fts_*)
      const rows = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY name",
      )?.all() as Array<{ name: string }> | undefined;
      for (const r of rows ?? []) {
        const name = r.name;
        let count = 0;
        try {
          count = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`)?.get() as { c?: number })?.c ?? 0;
        } catch {
          // FTS virtual tables etc. may refuse COUNT — report -1 so the UI shows "—"
          count = -1;
        }
        let columns: string[] = [];
        try {
          const pragma = db.prepare(`PRAGMA table_info("${name}")`)?.all() as
            | Array<{ name: string }>
            | undefined;
          columns = (pragma ?? []).map((c) => c.name);
        } catch {
          /* leave empty */
        }
        tables.push({ name, count, columns });
      }
      return { path: file, tables };
    } finally {
      db.close();
    }
  }

  /**
   * Read-only SELECT probe for the viewer. SQL must start with SELECT (case-insensitive),
   * contain no statement separator, and no write keywords anywhere — a defensive belt
   * alongside the readOnly=1 connection. LIMIT is forced when absent.
   */
  dbQuery(rawSql: string, limit = 100): { columns: string[]; rows: unknown[][]; truncated: boolean } {
    const sql = String(rawSql ?? "").trim().replace(/;+\s*$/, "");
    if (!sql) throw new Error("SQL 不能为空");
    if (!/^select\b/i.test(sql)) throw new Error("只允许 SELECT 查询（只读查看页）");
    if (/;\s*\S/.test(sql)) throw new Error("禁止多条语句（仅单条 SELECT）");
    if (/\b(insert|update|delete|drop|alter|create|attach|pragma\s+writing)\b/i.test(sql)) {
      throw new Error("查询包含写操作关键字，已拒绝");
    }
    const forced = /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
    const db = this.openKbDbReadonly();
    try {
      const stmt = db.prepare(forced);
      const rows = (stmt?.all() as Array<Record<string, unknown>> | undefined) ?? [];
      const columns = stmt?.columns()?.map((c) => c.name) ?? (rows[0] ? Object.keys(rows[0]) : []);
      const limited = rows.slice(0, Math.min(Math.max(limit, 1), 1000));
      return { columns, rows: limited.map((r) => columns.map((c) => r[c])), truncated: rows.length > limited.length };
    } finally {
      db.close();
    }
  }

  /** Qdrant collections list (proxied; offline → throws with the transport error). */
  async qdrantCollections(): Promise<{ online: boolean; collections: unknown[]; raw?: unknown }> {
    const url = this.config.vector_store.url;
    try {
      const res = await fetch(`${url}/collections`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { online: false, collections: [], raw: { status: res.status } };
      const body = (await res.json()) as { result?: { collections?: unknown[] } };
      return { online: true, collections: body.result?.collections ?? [] };
    } catch (err) {
      return { online: false, collections: [], raw: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Scroll points from one collection (POST /collections/{name}/points/scroll). */
  async qdrantPoints(
    collection: string,
    limit = 20,
    offset?: string,
  ): Promise<{ online: boolean; points: unknown[]; nextOffset?: string; raw?: unknown }> {
    const url = this.config.vector_store.url;
    const name = encodeURIComponent(collection);
    try {
      const res = await fetch(`${url}/collections/${name}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: Math.min(Math.max(limit, 1), 100), offset: offset ?? null, with_payload: true, with_vector: false }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { online: false, points: [], raw: { status: res.status } };
      const body = (await res.json()) as { result?: { points?: unknown[]; next_page_offset?: string } };
      return {
        online: true,
        points: body.result?.points ?? [],
        nextOffset: body.result?.next_page_offset,
      };
    } catch (err) {
      return { online: false, points: [], raw: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** List one directory for the import path picker; dotfiles hidden, dirs first. */
  fsList(dirPath?: string) {
    const target = resolveFsPath(dirPath ?? "~");
    let stat;
    try {
      stat = statSync(target);
    } catch {
      throw new Error(`路径不存在: ${target}`);
    }
    if (!stat.isDirectory()) throw new Error(`不是目录: ${target}`);
    let dirents;
    try {
      dirents = readdirSync(target, { withFileTypes: true });
    } catch (err) {
      throw new Error(`目录不可读: ${target}（${err instanceof Error ? err.message : String(err)}）`);
    }

    const entries: Array<{
      name: string;
      path: string;
      isDir: boolean;
      ingestable: boolean;
      kind: string | null;
      size: number;
      mtime: number;
    }> = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue; // match ingest's walk: hidden files never indexed
      const full = join(target, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, path: full, isDir: true, ingestable: true, kind: null, size: 0, mtime: 0 });
        continue;
      }
      if (!dirent.isFile()) continue;
      let size = 0;
      let mtime = 0;
      try {
        const s = statSync(full);
        size = s.size;
        mtime = Math.round(s.mtimeMs);
      } catch {
        // unreadable entry: still listed, just without metadata
      }
      const kind = classifyFile(full);
      entries.push({
        name: dirent.name,
        path: full,
        isDir: false,
        ingestable: isMediaFile(full) || (kind !== "unknown" && kind !== "deferred"),
        kind: kind === "unknown" ? null : kind,
        size,
        mtime,
      });
    }
    entries.sort(
      (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    const parent = dirname(target);
    return {
      path: target,
      parent: parent !== target ? parent : null,
      entries,
    };
  }

  /** Metadata for /api/fs/download — the body itself is streamed in http.ts. */
  fsFileInfo(filePath: string) {
    const target = resolveFsPath(filePath);
    const stat = statSync(target); // throws with ENOENT → caller maps to 400/404
    if (!stat.isFile()) throw new Error(`不是普通文件: ${target}`);
    return { path: target, name: basename(target), size: stat.size, mtime: Math.round(stat.mtimeMs) };
  }

  /** First 512 KiB of text for the preview dialog; media has no text to show. */
  fsRead(filePath: string) {
    const target = resolveFsPath(filePath);
    const stat = statSync(target);
    if (!stat.isFile()) throw new Error(`不是普通文件: ${target}`);
    if (isMediaFile(target)) throw new Error("视频/音频/图片不支持文本预览，请使用下载");
    const PREVIEW_MAX_BYTES = 512 * 1024;
    const kind = classifyFile(target);

    // Binary office/pdf formats would decode as garbage — run the ingest parser instead.
    if (kind === "pdf" || kind === "office") {
      const doc = parseFile(target);
      const truncated = doc.text.length > PREVIEW_MAX_BYTES;
      return {
        path: target,
        name: basename(target),
        kind,
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
        truncated,
        content: truncated ? doc.text.slice(0, PREVIEW_MAX_BYTES) : doc.text,
      };
    }

    const truncated = stat.size > PREVIEW_MAX_BYTES;
    const buf = truncated ? readFirstBytes(target, PREVIEW_MAX_BYTES) : readFileSync(target);
    return {
      path: target,
      name: basename(target),
      kind,
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      truncated,
      content: buf.toString("utf8"),
    };
  }

  /** Skill list for the UI panel — body included so the panel can preview it. */
  listSkills(): Array<SkillManifest> {
    return this.skills.list();
  }

  kbSearch(query: string, topK = 8) {
    return this.kb.search(query, topK);
  }

  // -------------------------------------------------------------------------------------------
  // snapshots
  // -------------------------------------------------------------------------------------------

  snapshot(): HostSnapshot {
    return {
      status: this.status,
      busy: this.busy,
      agentId: this.agentId,
      traceId: this.currentTraceId,
      agentMode: this.agentMode,
      phase: this.phase,
      phases: this.phases.map((item) => ({
        phase: item.phase,
        state: item.state,
        durationMs: item.durationMs,
      })),
      context: this.contextSnapshot(),
      stats: { ...this.stats },
      subagents: [...this.subagents.values()],
      approvals: [...this.pendingApprovals.values()].map((pending) => ({
        requestId: pending.request.call.id,
        tool: pending.request.call.tool,
        level: pending.request.level,
        input: summarizeInput(pending.request.call.input),
        createdAt: pending.createdAt,
        expiresAt: pending.createdAt + APPROVAL_TIMEOUT_MS,
      })),
      health: this.healthSnapshot(),
      startedAt: this.startedAt,
    };
  }

  private contextSnapshot(): ContextSnapshot {
    const window = this.resolved?.capabilities.contextWindow ?? 32768;
    const used = this.tokens.system + this.tokens.memory + this.tokens.history + this.tokens.observations;
    return {
      window,
      used,
      percent: window > 0 ? Math.min(100, Math.round((used / window) * 1000) / 10) : 0,
      segments: {
        system: this.tokens.system,
        memory: this.tokens.memory,
        history: this.tokens.history,
        observations: this.tokens.observations,
      },
    };
  }

  healthSnapshot(): HealthSnapshot {
    const base: HealthSnapshot = {
      ok: this.status === "ready",
      status: this.status,
      model: this.resolved?.model ?? this.config.model.default,
      provider: this.resolved?.provider ?? "(unresolved)",
      qdrant: this.qdrant,
      degraded: this.status === "degraded",
      toolCalling: this.resolved?.capabilities.toolCalling ?? false,
      contextWindow: this.resolved?.capabilities.contextWindow ?? 32768,
    };
    return this.degradedReason ? { ...base, hint: this.degradedReason } : base;
  }

  /** Probe Qdrant (soft dependency — offline only means KB retrieval is unavailable). */
  private async refreshQdrant(): Promise<void> {
    const now = Date.now();
    if (now - this.qdrantCheckedAt < 5000) return;
    this.qdrantCheckedAt = now;
    try {
      const res = await fetch(this.config.vector_store.url, { signal: AbortSignal.timeout(1500) });
      this.qdrant = res.ok ? "online" : "offline";
    } catch {
      this.qdrant = "offline";
    }
    this.emit("state", this.snapshot());
  }

  /** `/api/health` re-probes Qdrant so the badge reflects reality, not the boot-time guess. */
  async health(): Promise<HealthSnapshot> {
    this.qdrantCheckedAt = 0;
    await this.refreshQdrant().catch(() => undefined);
    return this.healthSnapshot();
  }
}
