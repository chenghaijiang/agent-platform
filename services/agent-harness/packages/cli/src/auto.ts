/**
 * `harness auto` — Automation surface (M7, design doc §10 mechanism 5).
 *
 *   harness auto list
 *   harness auto add --name "晨报" --schedule "@daily 09:00" --prompt "…"
 *   harness auto add 晨报 "@daily 09:00" "…"          (positional form)
 *   harness auto remove <id>
 *   harness auto run <id>
 *   harness auto start                                (foreground resident, Ctrl+C to quit)
 *
 * Each firing builds a brand-new AgentRuntime: no conversation is carried over, which is why the
 * prompt must be self-contained. There is nobody at the keyboard during a scheduled run, so every
 * approval request fails closed (denied) instead of blocking the scheduler.
 */
import { join } from "node:path";
import type { PermissionRequest } from "@harness/contracts";
import {
  AgentMessageChannel,
  AgentRuntime,
  AutomationScheduler,
  MemoryManager,
  ProviderRegistry,
  SharedTaskBoard,
  ToolRegistry,
  TraceWriter,
  createTaskTool,
  describeSchedule,
  loadConfig,
  nextRunAt,
  registerBuiltinTools,
  registerMessageTools,
  registerTaskBoardTools,
  type OllamaRunner,
  type ResolvedModel,
} from "@harness/core";

/** Scheduled runs are unattended: the prompt carries the context, not the chat history. */
const AUTOMATION_SYSTEM_PROMPT =
  "You are a precise personal agent running as a scheduled automation with no human at the keyboard. " +
  "The prompt is self-contained — there is no earlier conversation to recall. " +
  "Use tools to do the work end to end, then finish with a short self-contained report that makes sense " +
  "to someone reading only that report. If a tool needs approval it will be denied; find another way. " +
  "如果被要求协作，用 task:list/task:claim 认领任务，用 msg:send 与其他 agent 通信。";

interface AutoSurface {
  /** Fresh runtime per run (new session), with this run's agent id wired into the board tools. */
  createRuntime: () => AgentRuntime;
}

export async function runAuto(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list":
      return listAutomations();
    case "add":
      return addAutomation(rest);
    case "remove":
    case "rm":
      return removeAutomation(rest);
    case "run":
      return runAutomation(rest);
    case "start":
      return startScheduler();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      console.error(`✖ 未知的 auto 子命令: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}

function printUsage(): void {
  console.error(
    [
      "用法:",
      '  harness auto list',
      '  harness auto add [--name 名称] --schedule "@daily 09:00" --prompt "自包含的任务描述"',
      '  harness auto add 名称 "@daily 09:00" "自包含的任务描述"',
      "  harness auto remove <id>",
      "  harness auto run <id>",
      "  harness auto start        # 前台常驻，Ctrl+C 退出",
      "",
      "调度表达式:",
      "  @once 2026-11-08T09:00 / @daily 09:00 / @weekdays 09:00 / @weekly MO,WE,FR 09:00",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// sub-commands
// ---------------------------------------------------------------------------------------------

/** Local-only: listing must work even when the model backend is down. */
function listAutomations(): void {
  const scheduler = new AutomationScheduler({ log: () => {} });
  let records: ReturnType<AutomationScheduler["list"]>;
  try {
    records = scheduler.list();
  } catch (err) {
    console.error(`✖ ${errText(err)}`);
    process.exitCode = 1;
    return;
  }

  if (records.length === 0) {
    console.log(`（没有自动化任务） 存储: ${scheduler.storePath}`);
    return;
  }

  const upcoming = new Map(scheduler.upcoming().map((item) => [item.id, item.at]));
  console.log(`自动化任务（${records.length}） 存储: ${scheduler.storePath}\n`);
  for (const record of records) {
    const state = record.enabled ? "on " : "off";
    const next = upcoming.get(record.id);
    console.log(`${record.id}  [${state}]  ${record.name}`);
    console.log(`  调度: ${record.schedule}  → ${describeSafe(record.schedule)}`);
    console.log(`  下次: ${next ? formatTime(next) : "—（无后续触发）"}`);
    if (record.lastRunAt) console.log(`  上次: ${formatTime(record.lastRunAt)} — ${record.lastResult ?? "(无结果)"}`);
    console.log(`  prompt: ${oneLine(record.prompt, 100)}`);
    console.log("");
  }
}

function addAutomation(argv: string[]): void {
  const parsed = parseArgs(argv);
  const positional = [...parsed.positionals];

  const name = flag(parsed, "name") ?? positional.shift();
  const schedule = flag(parsed, "schedule") ?? positional.shift();
  const promptFlag = flag(parsed, "prompt");
  const prompt = promptFlag ?? (positional.length > 0 ? positional.join(" ") : undefined);

  if (!schedule || !prompt) {
    console.error('✖ 需要 --schedule 与 --prompt（示例: harness auto add 晨报 "@daily 09:00" "汇总今天的新闻")');
    process.exitCode = 1;
    return;
  }

  const scheduler = new AutomationScheduler({ log: () => {} });
  try {
    const record = scheduler.add({ ...(name ? { name } : {}), schedule, prompt });
    const at = nextRunAt(record.schedule);
    console.log(`✓ 已添加 ${record.id} "${record.name}"`);
    console.log(`  调度: ${record.schedule} → ${describeSafe(record.schedule)}`);
    console.log(`  首次触发: ${formatTime(at)}`);
    console.log(`  prompt 必须自包含：未来运行看不到当前对话。`);
  } catch (err) {
    console.error(`✖ ${errText(err)}`);
    process.exitCode = 1;
  }
}

function removeAutomation(argv: string[]): void {
  const id = argv[0];
  if (!id) {
    console.error("✖ 需要任务 id（harness auto list 可查看）");
    process.exitCode = 1;
    return;
  }
  const scheduler = new AutomationScheduler({ log: () => {} });
  try {
    if (scheduler.remove(id)) console.log(`✓ 已删除 ${id}`);
    else {
      console.error(`✖ 没有找到任务 ${id}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`✖ ${errText(err)}`);
    process.exitCode = 1;
  }
}

async function runAutomation(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.error("✖ 需要任务 id（harness auto list 可查看）");
    process.exitCode = 1;
    return;
  }

  const surface = await buildSurface();
  const scheduler = new AutomationScheduler({ runtimeFactory: surface.createRuntime });
  const result = await scheduler.runNow(id);

  console.log(`\n[${result.status}] ${result.name} — ${result.reason ?? "-"}`);
  if (result.text) console.log(result.text);
  if (result.lastResult) console.log(`\nlastResult: ${oneLine(result.lastResult, 200)}`);
  if (result.status !== "ok") process.exitCode = 1;
}

/** Foreground resident scheduler. The keep-alive interval holds the process open even with no tasks. */
async function startScheduler(): Promise<void> {
  const surface = await buildSurface();
  const scheduler = new AutomationScheduler({ runtimeFactory: surface.createRuntime });

  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = (signal: string) => {
    console.error(`\n${signal} — 正在退出调度器`);
    clearInterval(keepAlive);
    scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  scheduler.start(surface.createRuntime);

  const upcoming = scheduler.upcoming();
  if (upcoming.length === 0) console.error("[automation] 当前没有启用的任务，等待新任务（harness auto add …）");
  else {
    console.error("[automation] 下次触发时间:");
    for (const item of upcoming) console.error(`  ${formatTime(item.at)}  ${item.name} (${item.id})`);
  }
  console.error("[automation] Ctrl+C 退出");
}

// ---------------------------------------------------------------------------------------------
// surface
// ---------------------------------------------------------------------------------------------

async function buildSurface(): Promise<AutoSurface> {
  const config = loadConfig();
  const providers = new ProviderRegistry(config);
  let resolved: ResolvedModel;
  try {
    resolved = await providers.resolveHealthy(config.model.default);
  } catch (err) {
    console.error(`\n✖ ${errText(err)}`);
    console.error("  启动本地模型: brew services start ollama   (或前台 ollama serve)");
    process.exit(1);
  }

  const runner = resolved.adapter as unknown as OllamaRunner;
  const trace = new TraceWriter(join(process.cwd(), "traces"));
  const memory = new MemoryManager(process.cwd());

  const board = new SharedTaskBoard(process.cwd());
  const messages = new AgentMessageChannel(process.cwd());
  /** Rebound by every `createRuntime()` so tools act on behalf of the run that is executing. */
  let activeAgent = "auto";

  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const taskTool = createTaskTool({
    parentConfig: config,
    runner,
    parentRegistry: registry,
    approvalHandler: denyApproval,
    onEvent: (event) => trace.write(event),
  });
  registry.register(taskTool.manifest, taskTool.execute);
  registerTaskBoardTools(registry, board, { agentId: () => activeAgent });
  registerMessageTools(registry, messages, { agentId: () => activeAgent });

  const createRuntime = (): AgentRuntime => {
    const runtime = new AgentRuntime({
      runner,
      registry,
      config,
      systemPrompt: AUTOMATION_SYSTEM_PROMPT,
      approvalHandler: denyApproval,
      onEvent: (event) => trace.write(event),
      onToolResult: (tool, status, output, ms) =>
        console.error(`  ⚙ ${tool} [${status}] ${ms}ms — ${oneLine(output, 120)}`),
      contextWindow: resolved.capabilities.contextWindow,
    });
    activeAgent = runtime.id;
    runtime.setMemoryContext(memory.loadMemoryContext());
    return runtime;
  };

  return { createRuntime };
}

/** Nobody is watching a scheduled run — approvals must fail closed, never hang the scheduler. */
async function denyApproval(request: PermissionRequest): Promise<"denied"> {
  console.error(`  ⚠ 无人值守：需要审批的 ${request.call.tool} 已拒绝`);
  return "denied";
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** `--name x` / `--name=x` / `-h`; everything else is positional. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function flag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

/** A hand-edited store may hold a broken expression — never let that crash `auto list`. */
function describeSafe(spec: string): string {
  try {
    return describeSchedule(spec);
  } catch (err) {
    return `(非法表达式：${errText(err)})`;
  }
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
