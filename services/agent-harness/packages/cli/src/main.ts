/**
 * harness CLI — M2: argv task or interactive REPL over the scheduled/moderated AgentRuntime loop.
 * Usage: harness "统计当前目录下最大的 3 个文件"   |   harness (REPL)
 */
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { join } from "node:path";
import type { PermissionRequest, SessionEvent, ToolManifest } from "@harness/contracts";
import { lazyKnowledgeBase, registerKbTools } from "@harness/kb";
import * as coreApi from "@harness/core";
import {
  AgentMessageChannel,
  AgentRuntime,
  MemoryManager,
  ProviderRegistry,
  SharedTaskBoard,
  ToolRegistry,
  TraceWriter,
  loadConfig,
  registerBuiltinTools,
  registerMessageTools,
  registerTaskBoardTools,
  type HarnessConfig,
  type OllamaRunner,
  type ResolvedModel,
} from "@harness/core";

// M7: `harness auto …` is its own surface. Dispatch before the chat machinery so `auto list/add/
// remove` works without touching the model backend.
if (process.argv[2] === "auto") {
  const { runAuto } = await import("./auto.js");
  await runAuto(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

// M6: `harness kb …` (ingest/search/stats) must also work with the model backend down.
if (process.argv[2] === "kb") {
  const { runKb } = await import("./kb.js");
  await runKb(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

/** M7: one added sentence — collaboration is offered, not enforced. */
const MAIN_SYSTEM_PROMPT =
  "You are a precise personal agent. Use tools to accomplish the user's goal. " +
  "Validate assumptions with tools instead of guessing. Report key evidence (paths, command output) in your final answer. " +
  "如果被要求协作，用 task:list/task:claim 认领任务，用 msg:send 与其他 agent 通信。";

const config = loadConfig();
const providers = new ProviderRegistry(config);

// M5: resolve the configured model through the registry (fallback + health check).
const resolved = await resolveModel(providers, config.model.default);
// AgentRuntime still types `runner` as OllamaRunner (runtime/ is out of M5 scope);
// every adapter satisfies the same chat() contract.
const runner = resolved.adapter as unknown as OllamaRunner;
const registry = new ToolRegistry();
registerBuiltinTools(registry);
registerSubagentTool();

// M6: knowledge-base tools. The KB handle is lazy — kb.db is opened on the first tool call,
// not at REPL startup, and a missing/broken index surfaces as a structured tool message.
const kb = lazyKnowledgeBase();
registerKbTools(registry, kb);

// M7: coordination layer — shared task board + agent message channel (design doc §8.1).
const board = new SharedTaskBoard(process.cwd());
const messageChannel = new AgentMessageChannel(process.cwd());
/** Rebound once the runtime exists; tools act on behalf of this session's agent id. */
let sessionAgentId = "main";
registerTaskBoardTools(registry, board, { agentId: () => sessionAgentId });
registerMessageTools(registry, messageChannel, { agentId: () => sessionAgentId });

const trace = new TraceWriter(join(process.cwd(), "traces"));

// M3: three-layer memory (L2 user / L3 workspace) injected into the system prompt at startup.
const memory = new MemoryManager(process.cwd());

/** "总是允许" for this process only, keyed by tool name. */
const alwaysAllowed = new Set<string>();
/** Set while the REPL owns stdin, so approval prompts can pause it. */
let replRl: Interface | undefined;

/** Session totals, aggregated from the event stream the runtime already emits (see report()). */
const stats = {
  turns: 0,
  toolCalls: 0,
  /** `${traceId}:${wave}` of every parallel wave — distinct waves, not parallel calls. */
  parallelWaves: new Set<string>(),
  traceId: "",
};

/** Started calls awaiting their result, per tool name (results arrive in submission order). */
const pendingWaves = new Map<string, { wave: number; parallel: boolean }[]>();

const runtime = new AgentRuntime({
  runner,
  registry,
  config,
  systemPrompt: MAIN_SYSTEM_PROMPT,
  onEvent: (e) => {
    trace.write(e);
    noteEvent(e);
  },
  onDelta: (t) => process.stdout.write(stripThink(t)),
  onToolResult: (tool, status, output, ms) => printToolResult(tool, status, output, ms),
  approvalHandler: approve,
  // M3: compaction budget comes from the resolved provider's capabilities, not a guess.
  contextWindow: resolved.capabilities.contextWindow,
});

sessionAgentId = runtime.id;

runtime.setMemoryContext(memory.loadMemoryContext());

/** Thinking models may emit <think> blocks; keep them out of the visible chat. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "");
}

/**
 * Pre-flight model resolution (design doc §15.2): health check the backend, fall
 * back to `model.fallback` when it is unreachable, and otherwise explain how to
 * start Ollama and exit cleanly — no stack trace, no half-working REPL.
 */
async function resolveModel(registry: ProviderRegistry, model: string): Promise<ResolvedModel> {
  try {
    const resolved = await registry.resolveHealthy(model);
    if (resolved.degraded) {
      console.error(`⚠ 模型 ${model} 不可用，已降级到 ${resolved.provider}/${resolved.model}`);
    }
    if (!resolved.capabilities.toolCalling) {
      console.error(`⚠ ${resolved.model} 不支持 tool calling → 纯对话降级模式`);
    }
    return resolved;
  } catch (err) {
    console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
    console.error("  启动本地模型: brew services start ollama   (或前台 ollama serve)");
    process.exit(1);
  }
}

/** Surface-layer approval UI: [y] this once, [a] always for this tool, [n] deny. */
async function approve(request: PermissionRequest): Promise<"allowed" | "denied"> {
  const tool = request.call.tool;
  if (alwaysAllowed.has(tool)) return "allowed";

  if (!process.stdin.isTTY) {
    console.error(`\n  ⚠ 需要人工审批（${tool}），但 stdin 非交互 → 已拒绝`);
    return "denied";
  }

  const detail = describeInput(request.call.input);
  replRl?.pause();
  try {
    const answer = await askLine(
      `\n审批: ${tool}（${request.level}）${detail}\n  [y]允许本次 [a]总是允许 [n]拒绝 > `,
    );
    const choice = answer.trim().toLowerCase();
    if (choice === "a" || choice === "always") {
      alwaysAllowed.add(tool);
      console.error(`  ✓ 本进程内将自动允许 ${tool}`);
      return "allowed";
    }
    if (choice === "y" || choice === "yes") return "allowed";
    console.error(`  ✗ 已拒绝 ${tool}`);
    return "denied";
  } finally {
    replRl?.resume();
  }
}

/** One-shot readline on stdin — closed immediately so no handle outlives the question. */
function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function describeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === "string") return ` ${obj.command.replace(/\s+/g, " ").slice(0, 100)}`;
  if (typeof obj.path === "string") return ` ${obj.path}`;
  return ` ${JSON.stringify(obj).slice(0, 100)}`;
}

// §17.4: cancellation is cooperative. First Ctrl+C收口 the running turn (AbortSignal through model
// stream and tool processes), a second one force-quits — the operator decides how hard to stop.
let turnActive = false;
let cancelRequested = false;

process.on("SIGINT", () => {
  if (!turnActive) {
    console.error("\n⏹ 已退出");
    process.exit(0);
  }
  if (cancelRequested) {
    console.error("\n⏹ 再次中断 → 强制退出（当前 turn 未收口）");
    process.exit(130);
  }
  cancelRequested = true;
  console.error("\n⏹ 正在中断当前 turn…（再按一次强制退出）");
  runtime.cancel("user");
});

/** One turn at a time, with the cooperative-cancel bookkeeping the SIGINT handler relies on. */
async function runGuarded(input: string) {
  turnActive = true;
  cancelRequested = false;
  try {
    return await runtime.runTurn(input);
  } finally {
    turnActive = false;
  }
}

const task = process.argv.slice(2).join(" ");

if (task) {
  const summary = await runGuarded(task);
  report(summary);
  logTurn(task, summary);
  await noteClaimedTasks();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "harness> " });
replRl = rl;
console.error(`Agent Harness — model: ${resolved.model} (${resolved.provider}). 空行退出。`);
rl.prompt();
for await (const line of rl) {
  const input = line.trim();
  if (!input) break;
  const summary = await runGuarded(input);
  report(summary);
  logTurn(input, summary);
  await noteClaimedTasks();
  rl.prompt();
}
rl.close();

function report(summary: {
  traceId: string;
  reason: string;
  iterations: number;
  durationMs: number;
  text: string;
}) {
  console.log(`\n[${summary.reason}] ${summary.iterations} iterations, ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.reason === "user_interrupted") {
    console.error("  ⏹ 已按用户要求中断（trace 保留已完成部分）");
  }
  console.log(
    `[统计] ${stats.turns} turns · ${stats.toolCalls} 次工具调用 · ${stats.parallelWaves.size} 个并行 wave · ` +
      `trace: ${summary.traceId || stats.traceId}`,
  );
  if (summary.reason === "error") console.error(summary.text);
}

/** M3: one line per finished turn in `.harness/memory/YYYY-MM-DD.md` — time + task + outcome. */
function logTurn(input: string, summary: { reason: string }): void {
  const time = new Date().toTimeString().slice(0, 8);
  const goal = input.replace(/\s+/g, " ").trim().slice(0, 80);
  memory.appendDailyLog(`- ${time} ${goal} → ${summary.reason}`);
}

/**
 * M7: after each turn, remind the session of work it owns on the shared board. Purely advisory —
 * a broken board must never break the chat.
 */
async function noteClaimedTasks(): Promise<void> {
  try {
    const mine = (await board.list()).filter(
      (t) => t.status === "claimed" && t.claimedBy === sessionAgentId,
    );
    if (mine.length === 0) return;
    const list = mine.map((t) => `${t.id} ${t.title}`).join(" · ");
    console.error(`[任务板] 你有 ${mine.length} 个已认领任务: ${list}`);
  } catch {
    /* board unreadable — stay silent */
  }
}

// ---------------------------------------------------------------------------------------------
// M4 — subagent spawn registration + wave/statistics instrumentation
// ---------------------------------------------------------------------------------------------

/** Factory exposed by `@harness/core`; looked up on the root entry so this surface stays thin. */
type TaskSpawnFactory = (opts: {
  parentConfig: HarnessConfig;
  runner: OllamaRunner;
  parentRegistry: ToolRegistry;
  systemPrompt?: string;
  approvalHandler?: (request: PermissionRequest, manifest: ToolManifest) => Promise<"allowed" | "denied">;
  onEvent?: (event: SessionEvent) => void;
}) => { manifest: ToolManifest; execute: (input: unknown) => Promise<string> };

/** Register `task:spawn` on the main registry (design doc §8); the tool itself lives in core. */
function registerSubagentTool(): void {
  const createTaskTool = (coreApi as unknown as { createTaskTool?: TaskSpawnFactory }).createTaskTool;
  if (typeof createTaskTool !== "function") {
    console.error("⚠ @harness/core 尚未导出 createTaskTool → task:spawn 未注册");
    return;
  }
  const tool = createTaskTool({
    parentConfig: config,
    runner,
    parentRegistry: registry,
    approvalHandler: approve,
    // M7: subagents get the same collaboration hint (they inherit the board/message tools too).
    systemPrompt: MAIN_SYSTEM_PROMPT,
    // Child events are mirrored into the trace only — they must not inflate the parent's stats.
    onEvent: (event) => trace.write(event),
  });
  registry.register(tool.manifest, tool.execute);
}

function noteEvent(event: SessionEvent): void {
  switch (event.type) {
    case "turn_started":
      stats.turns++;
      stats.traceId = event.traceId;
      pendingWaves.clear();
      break;
    case "tool_call_started":
      stats.toolCalls++;
      if (event.parallel) stats.parallelWaves.add(`${event.traceId}:${event.wave}`);
      queueFor(event.tool).push({ wave: event.wave, parallel: event.parallel });
      break;
    default:
      break;
  }
}

function printToolResult(tool: string, status: string, output: string, ms: number): void {
  const pending = queueFor(tool).shift();
  const waveTag = pending ? `${pending.parallel ? "⚡" : "🔒"}W${pending.wave + 1} ` : "";
  const oneLine = output.replace(/\s+/g, " ").slice(0, 120);
  console.error(`\n  ⚙ ${waveTag}${tool} [${status}] ${ms}ms — ${oneLine}`);
}

function queueFor(tool: string): { wave: number; parallel: boolean }[] {
  const queue = pendingWaves.get(tool);
  if (queue) return queue;
  const created: { wave: number; parallel: boolean }[] = [];
  pendingWaves.set(tool, created);
  return created;
}
