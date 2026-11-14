/**
 * Three-layer memory (design doc §5) — Markdown is the source of truth.
 *
 *   L1 Profile   — learned server-side, read-only here (not implemented locally).
 *   L2 User      — `~/.harness/memory/MEMORY.md`, cross-project, hard cap (default 4000 chars).
 *   L3 Workspace — `{workspace}/.harness/memory/YYYY-MM-DD.md` (append-only daily log) plus a
 *                  long-term `MEMORY.md` with its own cap (default 3000 chars).
 *
 * Appending past a cap is refused (not silently truncated): the caller must distil first.
 * `rotateOldLogs` is that distillation step for the personal edition — old daily logs are folded
 * into the long-term notes verbatim and only deleted once the fold has been persisted.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_L2_MAX_CHARS = 4000;
export const DEFAULT_L3_MAX_CHARS = 3000;
export const DEFAULT_LOG_ROTATE_DAYS = 30;
/** How many trailing daily-log lines are injected into the system prompt. */
export const RECENT_LOG_LINES = 50;

const DAILY_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** Thrown when a memory file would exceed its character budget — the fix is distillation. */
export class MemoryLimitError extends Error {
  constructor(
    readonly file: string,
    readonly limit: number,
  ) {
    super(`记忆文件已达上限（${file} 共 ${limit} 字符），拒绝追加：请先蒸馏（合并/删除旧条目）后再写入`);
    this.name = "MemoryLimitError";
  }
}

export interface MemoryManagerOptions {
  /** Override `~` (tests / alternate profiles). */
  homeDir?: string;
  l2MaxChars?: number;
  l3MaxChars?: number;
  logRotateDays?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class MemoryManager {
  private readonly l2File: string;
  private readonly l3Dir: string;
  private readonly longTermFile: string;
  private readonly l2MaxChars: number;
  private readonly l3MaxChars: number;
  private readonly logRotateDays: number;
  private readonly now: () => Date;

  constructor(
    private readonly workspace: string,
    opts: MemoryManagerOptions = {},
  ) {
    const home = opts.homeDir ?? homedir();
    this.l2File = join(home, ".harness", "memory", "MEMORY.md");
    this.l3Dir = join(workspace, ".harness", "memory");
    this.longTermFile = join(this.l3Dir, "MEMORY.md");
    this.l2MaxChars = opts.l2MaxChars ?? DEFAULT_L2_MAX_CHARS;
    this.l3MaxChars = opts.l3MaxChars ?? DEFAULT_L3_MAX_CHARS;
    this.logRotateDays = opts.logRotateDays ?? DEFAULT_LOG_ROTATE_DAYS;
    this.now = opts.now ?? (() => new Date());
  }

  get userMemoryPath(): string {
    return this.l2File;
  }

  get workspaceMemoryDir(): string {
    return this.l3Dir;
  }

  get longTermMemoryPath(): string {
    return this.longTermFile;
  }

  /**
   * The block injected at the end of the system prompt: L2 full text, L3 long-term notes, and the
   * last 50 lines of recent daily logs. Returns "" when nothing has been remembered yet.
   */
  loadMemoryContext(): string {
    const parts: string[] = [];

    const l2 = this.read(this.l2File).trim();
    if (l2) parts.push(`## L2 · 跨项目用户记忆\n${l2}`);

    const longTerm = this.read(this.longTermFile).trim();
    if (longTerm) parts.push(`## L3 · 工作区长期笔记\n${longTerm}`);

    const recent = this.recentLogLines(RECENT_LOG_LINES);
    if (recent.length > 0) parts.push(`## L3 · 近期工作日志（最后 ${recent.length} 行）\n${recent.join("\n")}`);

    return parts.join("\n\n");
  }

  /** Append one line to today's workspace log (temporary noise should never land here). */
  appendDailyLog(entry: string): void {
    const text = entry.trim();
    if (!text) return;
    this.ensureDir(this.l3Dir);
    appendFileSync(this.dailyFile(), `${text}\n`, "utf8");
  }

  /** Append to the workspace long-term notes (`{workspace}/.harness/memory/MEMORY.md`, ≤3000). */
  appendLongTerm(entry: string): void {
    this.appendWithinLimit(this.longTermFile, this.l3MaxChars, entry);
  }

  /** Append to the cross-project user memory (`~/.harness/memory/MEMORY.md`, ≤4000). */
  appendUserMemory(entry: string): void {
    this.appendWithinLimit(this.l2File, this.l2MaxChars, entry);
  }

  /**
   * Distil daily logs older than `days` into the workspace long-term notes, then delete them.
   * Personal-edition distillation = concatenate each log line verbatim under a dated heading.
   * If the fold would blow the long-term cap we throw *before* deleting anything — never lose data.
   *
   * @returns the daily log file names that were rotated.
   */
  rotateOldLogs(days: number = this.logRotateDays): string[] {
    const cutoff = this.startOfDay(this.now());
    cutoff.setDate(cutoff.getDate() - days);

    const old = this.dailyLogFiles().filter((name) => this.dailyLogDate(name).getTime() < cutoff.getTime());
    if (old.length === 0) return [];

    const blocks = old.map((name) => {
      const lines = this.read(join(this.l3Dir, name))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      return [`## 归档 ${name.slice(0, 10)}`, ...lines].join("\n");
    });

    // Persist first: a throw here leaves every source log in place.
    this.appendLongTerm(blocks.join("\n\n"));
    for (const name of old) unlinkSync(join(this.l3Dir, name));
    return old;
  }

  private dailyFile(): string {
    return join(this.l3Dir, `${this.dateKey(this.now())}.md`);
  }

  private appendWithinLimit(file: string, limit: number, entry: string): void {
    const text = entry.trim();
    if (!text) return;
    const current = this.read(file);
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    const nextLength = current.length + separator.length + text.length + 1; // + trailing newline
    if (nextLength > limit) throw new MemoryLimitError(file, limit);

    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${separator}${text}\n`, "utf8");
  }

  /** Newest files contribute first; the tail of the newest log wins when the budget runs out. */
  private recentLogLines(limit: number): string[] {
    const lines: string[] = [];
    const files = this.dailyLogFiles();
    for (let index = files.length - 1; index >= 0 && lines.length < limit; index--) {
      const fileLines = this.read(join(this.l3Dir, files[index]!))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      const take = fileLines.slice(-(limit - lines.length));
      lines.unshift(...take);
    }
    return lines;
  }

  private dailyLogFiles(): string[] {
    if (!existsSync(this.l3Dir)) return [];
    return readdirSync(this.l3Dir)
      .filter((name) => DAILY_LOG_RE.test(name))
      .sort();
  }

  private dailyLogDate(name: string): Date {
    const match = DAILY_LOG_RE.exec(name);
    return match ? new Date(`${match[1]}T00:00:00`) : new Date(0);
  }

  private dateKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private read(file: string): string {
    if (!existsSync(file)) return "";
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }
}
