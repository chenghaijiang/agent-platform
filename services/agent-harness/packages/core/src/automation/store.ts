/**
 * Automation store (design doc §10, mechanism 5) — `~/.harness/automations.json`.
 *
 * Writes are atomic: the whole array is serialised into a sibling temp file and `rename`d over the
 * target, so a crash mid-write can never leave a half-written schedule list. The file itself is a
 * plain JSON array of `AutomationRecord` — scripts must not edit it while the scheduler runs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** One persisted automation. `lastResult` is a running log line, not a transcript. */
export interface AutomationRecord {
  id: string;
  name: string;
  /** Raw schedule expression — see `automation/schedule.ts`. */
  schedule: string;
  /** Self-contained prompt: the future run cannot see the conversation that created it. */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: string;
}

export type AutomationStoreErrorCode = "READ_FAILED" | "INVALID_STORE" | "WRITE_FAILED";

export class AutomationStoreError extends Error {
  constructor(
    readonly code: AutomationStoreErrorCode,
    readonly file: string,
    readonly detail: string,
  ) {
    super(`[${code}] ${file}: ${detail}`);
    this.name = "AutomationStoreError";
  }
}

export interface AutomationStoreOptions {
  /** Override `~` (tests / alternate profiles). */
  homeDir?: string;
  /** Full path override; wins over `homeDir`. */
  file?: string;
}

export class AutomationStore {
  readonly file: string;

  constructor(opts: AutomationStoreOptions = {}) {
    this.file = opts.file ?? join(opts.homeDir ?? homedir(), ".harness", "automations.json");
  }

  /** Read the whole list. A missing file is an empty list; corrupt JSON is a hard error. */
  read(): AutomationRecord[] {
    if (!existsSync(this.file)) return [];
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      throw new AutomationStoreError("READ_FAILED", this.file, errorText(err));
    }
    if (!text.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AutomationStoreError("INVALID_STORE", this.file, `JSON 解析失败：${errorText(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new AutomationStoreError("INVALID_STORE", this.file, "顶层结构必须是数组");
    }
    return parsed.map((item, index) => coerceRecord(item, this.file, index));
  }

  /** Atomic full-list write (temp file + rename in the same directory). */
  write(items: readonly AutomationRecord[]): void {
    const dir = dirname(this.file);
    const tmp = join(dir, `.${randomUUID().slice(0, 8)}.automations.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best-effort cleanup — the rename may already have consumed it */
      }
      throw new AutomationStoreError("WRITE_FAILED", this.file, errorText(err));
    }
  }

  /** Read-modify-write under one call; `undefined` return from the mutator means "unchanged". */
  update(mutator: (items: AutomationRecord[]) => void): AutomationRecord[] {
    const items = this.read();
    mutator(items);
    this.write(items);
    return items;
  }

  /** Patch one record by id. Returns the updated copy, or `undefined` when the id is unknown. */
  patch(id: string, patch: Partial<AutomationRecord>): AutomationRecord | undefined {
    let result: AutomationRecord | undefined;
    this.update((items) => {
      const target = items.find((item) => item.id === id);
      if (!target) return;
      Object.assign(target, patch);
      result = { ...target };
    });
    return result;
  }
}

function coerceRecord(value: unknown, file: string, index: number): AutomationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AutomationStoreError("INVALID_STORE", file, `第 ${index + 1} 项不是对象`);
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const schedule = typeof raw.schedule === "string" ? raw.schedule : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
  if (!id || !schedule || !prompt) {
    throw new AutomationStoreError("INVALID_STORE", file, `第 ${index + 1} 项缺少 id/schedule/prompt`);
  }
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
    schedule,
    prompt,
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    ...(typeof raw.lastRunAt === "number" ? { lastRunAt: raw.lastRunAt } : {}),
    ...(typeof raw.lastResult === "string" ? { lastResult: raw.lastResult } : {}),
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
