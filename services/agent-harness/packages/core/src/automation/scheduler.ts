/**
 * AutomationScheduler (design doc §10, mechanism 5).
 *
 * One timer at a time: it wakes up for the nearest enabled automation, spins up a **fresh
 * AgentRuntime** for that run (new session, so the prompt must be self-contained), records
 * `lastRunAt` / `lastResult`, then re-arms. Nothing in a run may break the loop — every failure is
 * captured into `lastResult` and the scheduler keeps going.
 *
 * Re-entrancy: a record that is currently executing is skipped by the planner, so a long run can
 * never overlap with itself even if its next occurrence is already due.
 */
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { parseSchedule, nextRunAt, nextRunAtFrom, type ParsedSchedule } from "./schedule.js";
import { AutomationStore, type AutomationRecord, type AutomationStoreOptions } from "./store.js";

/** Creates a brand-new runtime per run — separate conversation, separate trace. */
export type RuntimeFactory = () => AgentRuntime;

export type AutomationStatus = "ok" | "error" | "busy" | "missing" | "no_runtime";

export interface AutomationRunResult {
  id: string;
  name: string;
  status: AutomationStatus;
  startedAt: number;
  finishedAt: number;
  /** Turn end reason from the runtime (`goal_completed`, `max_iterations_reached`, …). */
  reason?: string;
  /** Final assistant text (or the failure message). */
  text?: string;
  /** What was persisted to `lastResult`. */
  lastResult?: string;
}

export interface AutomationInput {
  name?: string;
  schedule: string;
  prompt: string;
  enabled?: boolean;
}

export type AutomationErrorCode = "INVALID_INPUT";

export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AutomationError";
  }
}

export interface AutomationSchedulerOptions {
  store?: AutomationStore;
  storeOptions?: AutomationStoreOptions;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Diagnostics sink; defaults to stderr. */
  log?: (line: string) => void;
  /** Optional factory so `runNow` works without `start()`. */
  runtimeFactory?: RuntimeFactory;
}

/** setTimeout's ceiling is ~24.8 days — cap the wait and re-arm instead of overflowing. */
const MAX_TIMER_DELAY = 86_400_000;

/** `lastResult` is a status line, not a report — keep the store small. */
const MAX_RESULT_CHARS = 2_000;

/** Grace so an occurrence at "exactly now" is not skipped when `start()` lands on it. */
const START_LOOKBACK_MS = 1_000;

/** Idle rescan interval — picks up automations added by another process. */
const PARK_DELAY_MS = 60_000;

export class AutomationScheduler {
  private readonly store: AutomationStore;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly parsed = new Map<string, ParsedSchedule>();
  private readonly inFlight = new Set<string>();

  private factory: RuntimeFactory | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private idleNotified = false;
  /** Occurrence scan floor; advances monotonically so a fired slot is never replayed. */
  private cursor = 0;

  constructor(opts: AutomationSchedulerOptions = {}) {
    this.store = opts.store ?? new AutomationStore(opts.storeOptions ?? {});
    this.now = opts.now ?? (() => Date.now());
    const sink = opts.log ?? ((line: string) => console.error(line));
    this.log = sink;
    this.factory = opts.runtimeFactory;
  }

  /** Where the schedule list lives — surfaced by `harness auto list`. */
  get storePath(): string {
    return this.store.file;
  }

  get isRunning(): boolean {
    return this.started;
  }

  list(): AutomationRecord[] {
    return this.store.read().sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): AutomationRecord | undefined {
    return this.store.read().find((record) => record.id === id);
  }

  /** Validate the expression **before** persisting, so a broken schedule never enters the store. */
  add(input: AutomationInput): AutomationRecord {
    const schedule = (input.schedule ?? "").trim();
    const prompt = (input.prompt ?? "").trim();
    if (!schedule) throw new AutomationError("INVALID_INPUT", "缺少 --schedule 调度表达式");
    if (!prompt) throw new AutomationError("INVALID_INPUT", "缺少 --prompt（必须自包含，未来运行看不到当前对话）");

    // Throws ScheduleError (structured) for illegal expressions or an already-elapsed @once.
    nextRunAt(schedule, this.now());

    const record: AutomationRecord = {
      id: `auto_${Math.random().toString(36).slice(2, 8)}`,
      name: (input.name ?? "").trim() || prompt.replace(/\s+/g, " ").slice(0, 40),
      schedule,
      prompt,
      enabled: input.enabled !== false,
      createdAt: this.now(),
    };
    this.store.update((items) => {
      items.push(record);
    });
    this.log(`[automation] 已添加 ${record.id} "${record.name}" (${record.schedule})`);
    this.arm();
    return record;
  }

  remove(id: string): boolean {
    let removed = false;
    this.store.update((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) {
        items.splice(index, 1);
        removed = true;
      }
    });
    if (removed) {
      this.log(`[automation] 已删除 ${id}`);
      this.arm();
    }
    return removed;
  }

  setEnabled(id: string, enabled: boolean): AutomationRecord | undefined {
    const updated = this.store.patch(id, { enabled });
    this.arm();
    return updated;
  }

  /** Enabled automations that will fire again, nearest first. */
  upcoming(): { id: string; name: string; at: number }[] {
    const now = this.now();
    const result: { id: string; name: string; at: number }[] = [];
    for (const record of this.list()) {
      if (!record.enabled) continue;
      const at = this.nextAtSafely(record, Math.max(this.cursor, record.lastRunAt ?? 0, now - START_LOOKBACK_MS));
      if (at !== null) result.push({ id: record.id, name: record.name, at });
    }
    return result.sort((a, b) => a.at - b.at);
  }

  /** Run one automation immediately, out of band. Safe to call before `start()`. */
  async runNow(id: string): Promise<AutomationRunResult> {
    const startedAt = this.now();
    const record = this.get(id);
    if (!record) {
      return {
        id,
        name: id,
        status: "missing",
        startedAt,
        finishedAt: this.now(),
        text: `未找到自动化任务 ${id}`,
      };
    }
    return this.execute(record);
  }

  /** Begin scheduling. `factory` may also be supplied through the constructor. */
  start(runtimeFactory: RuntimeFactory): void {
    this.factory = runtimeFactory;
    this.started = true;
    this.cursor = this.now() - START_LOOKBACK_MS;
    this.log(`[automation] 调度器已启动（${this.list().length} 个任务，Ctrl+C 退出）`);
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    this.log("[automation] 调度器已停止");
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.started) return;
    const now = this.now();

    const due: { record: AutomationRecord; at: number }[] = [];
    for (const record of this.readSafely()) {
      if (!record.enabled || this.inFlight.has(record.id)) continue;
      const at = this.nextAtSafely(record, this.refFor(record));
      if (at !== null && at <= now) due.push({ record, at });
    }
    due.sort((a, b) => a.at - b.at);

    for (const { record } of due) {
      if (!this.started) return;
      await this.execute(record);
    }

    this.cursor = Math.max(this.cursor, now);
    this.arm();
  }

  private arm(): void {
    this.clearTimer();
    if (!this.started) return;

    const now = this.now();
    let best: { record: AutomationRecord; at: number } | undefined;
    for (const record of this.readSafely()) {
      if (!record.enabled || this.inFlight.has(record.id)) continue;
      const at = this.nextAtSafely(record, this.refFor(record));
      if (at === null) continue;
      if (!best || at < best.at) best = { record, at };
    }

    if (!best) {
      // Nothing to fire now, but another process may add a task — rescan on a slow tick instead
      // of sleeping forever (a resident `harness auto start` must notice new work).
      if (!this.idleNotified) {
        this.log(`[automation] 没有待触发的任务（每 ${PARK_DELAY_MS / 1000}s 重新扫描）`);
        this.idleNotified = true;
      }
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick();
      }, PARK_DELAY_MS);
      return;
    }

    this.idleNotified = false;
    const delay = Math.max(0, Math.min(best.at - now, MAX_TIMER_DELAY));
    this.log(`[automation] 下次触发: ${best.record.name} @ ${formatTime(best.at)}`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async execute(record: AutomationRecord): Promise<AutomationRunResult> {
    const startedAt = this.now();
    if (this.inFlight.has(record.id)) {
      return {
        id: record.id,
        name: record.name,
        status: "busy",
        startedAt,
        finishedAt: startedAt,
        text: `任务 ${record.name} 正在执行中，本次触发被跳过`,
      };
    }
    if (!this.factory) {
      return {
        id: record.id,
        name: record.name,
        status: "no_runtime",
        startedAt,
        finishedAt: startedAt,
        text: "未提供 runtimeFactory，无法执行",
      };
    }

    this.inFlight.add(record.id);
    let status: AutomationStatus = "ok";
    let reason = "goal_completed";
    let text = "";
    try {
      // A fresh runtime per run: new conversation, and the prompt alone has to carry the context.
      const runtime = this.factory();
      const summary = await runtime.runTurn(record.prompt);
      reason = summary.reason;
      text = summary.text;
      if (summary.reason === "error") status = "error";
    } catch (err) {
      status = "error";
      reason = "exception";
      text = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight.delete(record.id);
    }

    const finishedAt = this.now();
    const lastResult = clip(`${status === "ok" ? "OK" : "ERROR"} [${reason}] ${text}`, MAX_RESULT_CHARS);
    try {
      this.store.patch(record.id, { lastRunAt: startedAt, lastResult });
    } catch (err) {
      this.log(`[automation] 写回 lastResult 失败: ${errText(err)}`);
    }
    this.log(
      `[automation] ${record.name} ${status === "ok" ? "完成" : "失败"} ` +
        `(${reason}, ${((finishedAt - startedAt) / 1000).toFixed(1)}s)`,
    );

    return { id: record.id, name: record.name, status, startedAt, finishedAt, reason, text, lastResult };
  }

  /** For `@once`, a recorded run means the schedule is exhausted (returns `null`). */
  private nextAt(record: AutomationRecord, ref: number): number | null {
    let parsed = this.parsed.get(record.schedule);
    if (!parsed) {
      parsed = parseSchedule(record.schedule);
      this.parsed.set(record.schedule, parsed);
    }
    if (parsed.kind === "once" && record.lastRunAt !== undefined) return null;
    return nextRunAtFrom(parsed, ref);
  }

  private nextAtSafely(record: AutomationRecord, ref: number): number | null {
    try {
      return this.nextAt(record, ref);
    } catch (err) {
      this.log(`[automation] 跳过 ${record.id}：${errText(err)}`);
      return null;
    }
  }

  private refFor(record: AutomationRecord): number {
    return Math.max(this.cursor, record.lastRunAt ?? 0);
  }

  private readSafely(): AutomationRecord[] {
    try {
      return this.store.read();
    } catch (err) {
      this.log(`[automation] 读取任务列表失败: ${errText(err)}`);
      return [];
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
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

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
