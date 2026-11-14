/**
 * SharedTaskBoard — file-based coordination layer for multi-agent work (design doc §8.1 note).
 *
 * State lives in `{workspace}/.harness/tasks.json` so several processes (CLI session, subagents,
 * scheduled runs) can cooperate without a broker. Safety model:
 *   - in-process: every read-modify-write goes through one Promise queue (no interleaved writes);
 *   - cross-process: the full file is written to a temp sibling and `rename`d into place, and the
 *     write is preceded by an mtime/size check — if another process touched the file in between,
 *     the operation is replayed once against the fresh snapshot instead of clobbering it.
 *
 * Every task carries `status` (pending|claimed|done), `claimedBy` and `updatedAt`; claiming is the
 * only way to take ownership, and a conflicting claim returns a structured conflict (never throws).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export type TaskStatus = "pending" | "claimed" | "done";

export interface BoardTask {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Suggested owner recorded at creation time (advisory). */
  assignee?: string;
  /** Agent that currently owns the task (set by `claim`). */
  claimedBy?: string;
  /** Free-form completion note from the agent that finished it. */
  result?: string;
}

export type TaskBoardErrorCode =
  | "INVALID_TITLE"
  | "NOT_FOUND"
  | "ALREADY_DONE"
  | "NOT_CLAIMANT"
  | "WRITE_CONFLICT"
  | "READ_FAILED";

export class TaskBoardError extends Error {
  constructor(
    readonly code: TaskBoardErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "TaskBoardError";
  }
}

/** Claim never throws on contention — the caller (an agent) needs the conflict, not a stack trace. */
export type ClaimConflictCode = "already_claimed" | "already_done";

export type ClaimOutcome =
  | { ok: true; task: BoardTask; reclaimed?: boolean }
  | { ok: false; code: ClaimConflictCode; task: BoardTask; message: string };

export interface TaskBoardOptions {
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface TaskBoardFile {
  version: 1;
  tasks: BoardTask[];
}

export class SharedTaskBoard {
  readonly file: string;
  private readonly now: () => number;
  /** Single-flight queue: read-modify-write is atomic inside this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    opts: TaskBoardOptions = {},
  ) {
    this.file = join(workspace, ".harness", "tasks.json");
    this.now = opts.now ?? (() => Date.now());
  }

  /** All tasks, oldest first. */
  async list(): Promise<BoardTask[]> {
    return this.snapshot().tasks.map(cloneTask).sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<BoardTask | undefined> {
    const task = this.snapshot().tasks.find((item) => item.id === id);
    return task ? cloneTask(task) : undefined;
  }

  async add(title: string, opts: { assignee?: string } = {}): Promise<BoardTask> {
    const clean = typeof title === "string" ? title.trim() : "";
    if (!clean) throw new TaskBoardError("INVALID_TITLE", "任务标题不能为空");
    const assignee = opts.assignee?.trim();

    return this.mutate((tasks) => {
      const timestamp = this.now();
      const task: BoardTask = {
        id: `t_${randomUUID().slice(0, 8)}`,
        title: clean,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(assignee ? { assignee } : {}),
      };
      tasks.push(task);
      return cloneTask(task);
    });
  }

  /** Take ownership. Idempotent for the current owner; a foreign claim is a structured conflict. */
  async claim(id: string, agentId: string): Promise<ClaimOutcome> {
    const agent = requireAgent(agentId);
    return this.mutate((tasks) => {
      const task = findTask(tasks, id);
      if (task.status === "done") {
        return {
          ok: false,
          code: "already_done",
          task: cloneTask(task),
          message: `任务 ${id} 已完成，无需认领`,
        } satisfies ClaimOutcome;
      }
      if (task.status === "claimed") {
        if (task.claimedBy === agent) return { ok: true, task: cloneTask(task), reclaimed: true } satisfies ClaimOutcome;
        return {
          ok: false,
          code: "already_claimed",
          task: cloneTask(task),
          message: `任务 ${id} 已被 agent "${task.claimedBy ?? "?"}" 认领（updatedAt=${task.updatedAt}）`,
        } satisfies ClaimOutcome;
      }
      task.status = "claimed";
      task.claimedBy = agent;
      task.updatedAt = this.now();
      return { ok: true, task: cloneTask(task) } satisfies ClaimOutcome;
    });
  }

  /** Mark done. Only the claimant (or an unclaimed task) may complete; others get NOT_CLAIMANT. */
  async complete(id: string, agentId: string, result?: string): Promise<BoardTask> {
    const agent = requireAgent(agentId);
    const note = typeof result === "string" ? result.trim() : "";

    return this.mutate((tasks) => {
      const task = findTask(tasks, id);
      if (task.status === "done") {
        throw new TaskBoardError("ALREADY_DONE", `任务 ${id} 已经是 done 状态`);
      }
      if (task.claimedBy && task.claimedBy !== agent) {
        throw new TaskBoardError(
          "NOT_CLAIMANT",
          `任务 ${id} 由 agent "${task.claimedBy}" 认领，agent "${agent}" 不能完成它`,
        );
      }
      task.status = "done";
      task.claimedBy = agent;
      task.updatedAt = this.now();
      if (note) task.result = note;
      return cloneTask(task);
    });
  }

  /** Return a claimed task to the pool (owner gave up / crash recovery). */
  async release(id: string): Promise<BoardTask> {
    return this.mutate((tasks) => {
      const task = findTask(tasks, id);
      if (task.status === "done") {
        throw new TaskBoardError("ALREADY_DONE", `任务 ${id} 已完成，不能释放`);
      }
      if (task.status === "claimed") {
        task.status = "pending";
        delete task.claimedBy;
        task.updatedAt = this.now();
      }
      return cloneTask(task);
    });
  }

  // -------------------------------------------------------------------------------------------
  // storage
  // -------------------------------------------------------------------------------------------

  /** Read-only snapshot; a missing file is an empty board. */
  private snapshot(): TaskBoardFile {
    if (!existsSync(this.file)) return { version: 1, tasks: [] };
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      throw new TaskBoardError("READ_FAILED", `读取任务板失败：${errText(err)}`);
    }
    if (!text.trim()) return { version: 1, tasks: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new TaskBoardError("READ_FAILED", `任务板 JSON 解析失败：${errText(err)}`);
    }
    const tasks = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? ((parsed as { tasks?: unknown }).tasks ?? [])
        : [];
    if (!Array.isArray(tasks)) throw new TaskBoardError("READ_FAILED", "任务板 tasks 字段必须是数组");
    return { version: 1, tasks: tasks.map((item) => coerceTask(item)) };
  }

  /**
   * Serialised read-modify-write. The mutator runs against a snapshot; the write only happens if
   * the file has not moved under us (mtime + size), otherwise the whole operation is retried once.
   */
  private mutate<T>(mutator: (tasks: BoardTask[]) => T): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const stampBefore = stamp(this.file);
        const current = this.snapshot();
        const outcome = mutator(current.tasks);

        if (stamp(this.file) !== stampBefore) continue; // another process wrote — replay on fresh data
        this.writeAtomic(current.tasks);
        return outcome;
      }
      throw new TaskBoardError("WRITE_CONFLICT", `任务板 ${this.file} 在写入期间被其他进程修改，请重试`);
    };

    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private writeAtomic(tasks: BoardTask[]): void {
    const dir = dirname(this.file);
    const tmp = join(dir, `.${randomUUID().slice(0, 8)}.tasks.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      const payload: TaskBoardFile = { version: 1, tasks };
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw new TaskBoardError("WRITE_CONFLICT", `写入任务板失败：${errText(err)}`);
    }
  }
}

/** `${mtimeMs}:${size}` or "missing" — cheap cross-process change detector. */
function stamp(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

function findTask(tasks: BoardTask[], id: string): BoardTask {
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new TaskBoardError("NOT_FOUND", `任务 ${id} 不存在`);
  return task;
}

function requireAgent(agentId: string): string {
  const agent = typeof agentId === "string" ? agentId.trim() : "";
  if (!agent) throw new TaskBoardError("NOT_CLAIMANT", "缺少 agentId（谁在操作任务板？）");
  return agent;
}

function coerceTask(value: unknown): BoardTask {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const status = raw.status === "claimed" || raw.status === "done" ? raw.status : "pending";
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" ? raw.title : "",
    status,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    ...(typeof raw.assignee === "string" ? { assignee: raw.assignee } : {}),
    ...(typeof raw.claimedBy === "string" ? { claimedBy: raw.claimedBy } : {}),
    ...(typeof raw.result === "string" ? { result: raw.result } : {}),
  };
}

function cloneTask(task: BoardTask): BoardTask {
  return { ...task };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
