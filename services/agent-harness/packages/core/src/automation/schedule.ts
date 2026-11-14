/**
 * Lightweight schedule expressions for Automation (design doc §10, mechanism 5).
 *
 *   @once     2026-11-08T09:00        one-shot, local wall clock
 *   @daily    09:00                   every day
 *   @weekdays 09:00                   Monday–Friday
 *   @weekly   MO,WE,FR 09:00          explicit weekday set
 *
 * Parsing is pure and strict: an illegal expression throws `ScheduleError` with a stable `code`
 * so callers (CLI, tools, scheduler) can react without string-matching the message. `nextRunAt`
 * always returns a **strictly later** local instant for repeating schedules, which is what keeps
 * the scheduler's re-arm loop from firing the same occurrence twice.
 */

export type ScheduleKind = "once" | "daily" | "weekdays" | "weekly";

export type ScheduleErrorCode =
  | "EMPTY_SPEC"
  | "UNKNOWN_KIND"
  | "MISSING_FIELD"
  | "INVALID_ARGS"
  | "INVALID_TIME"
  | "INVALID_DATE"
  | "INVALID_WEEKDAY"
  | "SCHEDULE_IN_PAST"
  | "NO_OCCURRENCE";

/** Structured schedule failure — `code` is the contract, `message` is for humans. */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    readonly spec: string,
    readonly detail: string,
  ) {
    super(`[${code}] 非法调度表达式 "${spec}": ${detail}`);
    this.name = "ScheduleError";
  }
}

export interface ParsedSchedule {
  kind: ScheduleKind;
  /** Trimmed, whitespace-normalised source expression. */
  raw: string;
  /** Epoch ms — `@once` only. */
  onceAt?: number;
  /** Local hour 0–23 — repeating kinds only. */
  hour?: number;
  /** Local minute 0–59 — repeating kinds only. */
  minute?: number;
  /** Local weekdays, 0=Sunday … 6=Saturday — `@weekdays` / `@weekly` only. */
  days?: number[];
}

/** RFC-5545 style two-letter weekday codes → JS `getDay()` values. */
const WEEKDAY_CODES: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Longest window scanned for the next occurrence (weekday sets always hit inside a week). */
const MAX_SCAN_DAYS = 400;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Parse and validate one expression. Throws `ScheduleError` — never returns a half-parsed spec. */
export function parseSchedule(spec: string): ParsedSchedule {
  const raw = typeof spec === "string" ? spec.trim() : "";
  if (!raw) throw new ScheduleError("EMPTY_SPEC", String(spec), "表达式为空");

  const tokens = raw.split(/\s+/);
  const head = tokens[0] ?? "";
  if (!head.startsWith("@")) {
    throw new ScheduleError("UNKNOWN_KIND", raw, `表达式必须以 "@once|@daily|@weekdays|@weekly" 开头`);
  }
  const kind = head.slice(1).toLowerCase();
  const args = tokens.slice(1);
  const normalised = `@${kind} ${args.join(" ")}`.trim();

  switch (kind) {
    case "once":
      return parseOnce(raw, normalised, args);
    case "daily":
      return parseRepeating(raw, normalised, "daily", args);
    case "weekdays":
      return parseRepeating(raw, normalised, "weekdays", args);
    case "weekly":
      return parseWeekly(raw, normalised, args);
    default:
      throw new ScheduleError("UNKNOWN_KIND", raw, `未知的调度类型 "@${kind}"`);
  }
}

function parseOnce(raw: string, normalised: string, args: string[]): ParsedSchedule {
  if (args.length === 0) throw new ScheduleError("MISSING_FIELD", raw, "缺少 ISO 时间，例如 @once 2026-11-08T09:00");
  if (args.length > 1) throw new ScheduleError("INVALID_ARGS", raw, `时间中不能包含空格（${args.length} 段）`);
  const at = parseInstant(args[0] ?? "", raw);
  return { kind: "once", raw: normalised, onceAt: at };
}

function parseRepeating(
  raw: string,
  normalised: string,
  kind: "daily" | "weekdays",
  args: string[],
): ParsedSchedule {
  if (args.length === 0) throw new ScheduleError("MISSING_FIELD", raw, `缺少时间，例如 @${kind} 09:00`);
  if (args.length > 1) throw new ScheduleError("INVALID_ARGS", raw, `"@${kind}" 只接受一个 HH:mm 参数`);
  const { hour, minute } = parseTime(args[0] ?? "", raw);
  return {
    kind,
    raw: normalised,
    hour,
    minute,
    ...(kind === "weekdays" ? { days: [...WEEKDAYS] } : {}),
  };
}

function parseWeekly(raw: string, normalised: string, args: string[]): ParsedSchedule {
  if (args.length < 2) {
    throw new ScheduleError("MISSING_FIELD", raw, "缺少参数，例如 @weekly MO,WE,FR 09:00");
  }
  if (args.length > 2) throw new ScheduleError("INVALID_ARGS", raw, `"@weekly" 只接受 <周几列表> <HH:mm>`);
  const days = parseWeekdays(args[0] ?? "", raw);
  const { hour, minute } = parseTime(args[1] ?? "", raw);
  return { kind: "weekly", raw: normalised, hour, minute, days };
}

/** `HH:mm` in local wall-clock time. */
function parseTime(token: string, spec: string): { hour: number; minute: number } {
  const match = TIME_RE.exec(token);
  if (!match) throw new ScheduleError("INVALID_TIME", spec, `"${token}" 不是合法的 24 小时时间（HH:mm）`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** `MO,WE,FR` → sorted, de-duplicated `getDay()` values. */
function parseWeekdays(token: string, spec: string): number[] {
  const parts = token
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new ScheduleError("INVALID_WEEKDAY", spec, "周几列表为空");

  const days = new Set<number>();
  for (const part of parts) {
    const day = WEEKDAY_CODES[part.toUpperCase()];
    if (day === undefined) {
      throw new ScheduleError(
        "INVALID_WEEKDAY",
        spec,
        `未知的周几 "${part}"（可用：MO TU WE TH FR SA SU）`,
      );
    }
    days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * ISO-ish instant. Bare `YYYY-MM-DDTHH:mm[:ss]` is read as local time (the same wall clock the
 * repeating kinds use); a `Z`/offset suffix is honoured as an absolute instant.
 */
function parseInstant(token: string, spec: string): number {
  const local = LOCAL_DATE_RE.exec(token);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s ?? "0");
    if (month < 1 || month > 12) throw new ScheduleError("INVALID_DATE", spec, `月份越界：${mo}`);
    if (day < 1 || day > 31) throw new ScheduleError("INVALID_DATE", spec, `日期越界：${d}`);
    if (hour > 23 || minute > 59 || second > 59) {
      throw new ScheduleError("INVALID_DATE", spec, `时间越界：${h}:${mi}:${s ?? "00"}`);
    }
    const date = new Date(year, month - 1, day, hour, minute, second, 0);
    // 2026-02-31 would silently roll over to March — round-trip and reject instead.
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute
    ) {
      throw new ScheduleError("INVALID_DATE", spec, `"${token}" 不是真实存在的时刻`);
    }
    return date.getTime();
  }

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(token)) {
    const parsed = Date.parse(token);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new ScheduleError(
    "INVALID_DATE",
    spec,
    `"${token}" 不是合法 ISO 时间（示例：2026-11-08T09:00 或 2026-11-08T09:00:00Z）`,
  );
}

/**
 * Next fire time (epoch ms). For repeating schedules the result is **strictly after** `from`;
 * `@once` returns its instant and throws `SCHEDULE_IN_PAST` when it already elapsed.
 */
export function nextRunAt(spec: string, from: number = Date.now()): number {
  const parsed = parseSchedule(spec);
  if (parsed.kind === "once") {
    const at = parsed.onceAt ?? 0;
    if (at <= from) {
      throw new ScheduleError("SCHEDULE_IN_PAST", parsed.raw, `${new Date(at).toISOString()} 已经过去`);
    }
    return at;
  }
  const at = nextOccurrence(parsed, from);
  if (at === null) {
    throw new ScheduleError("NO_OCCURRENCE", parsed.raw, `未来 ${MAX_SCAN_DAYS} 天内没有可触发的时刻`);
  }
  return at;
}

/**
 * Scheduler-facing variant, tolerant by design:
 *   - repeating → next occurrence strictly after `from`, or `null` when none exists;
 *   - `@once`    → its instant even when it already elapsed (the caller decides on catch-up).
 */
export function nextRunAtFrom(parsed: ParsedSchedule, from: number): number | null {
  if (parsed.kind === "once") return parsed.onceAt ?? null;
  return nextOccurrence(parsed, from);
}

/** Walk forward one local day at a time until the wall-clock time and weekday both match. */
function nextOccurrence(parsed: ParsedSchedule, from: number): number | null {
  const { hour = 0, minute = 0, days } = parsed;
  const base = new Date(from);
  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hour, minute, 0, 0);
    const at = candidate.getTime();
    if (at <= from) continue;
    if (days && !days.includes(candidate.getDay())) continue;
    return at;
  }
  return null;
}

/** Human-readable one-liner, used by `harness auto list` and scheduler logs. */
export function describeSchedule(spec: string): string {
  const parsed = parseSchedule(spec);
  switch (parsed.kind) {
    case "once":
      return `一次性 @ ${formatLocal(parsed.onceAt ?? 0)}`;
    case "daily":
      return `每天 ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    case "weekdays":
      return `工作日 ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    case "weekly": {
      const names = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      const days = (parsed.days ?? []).map((d) => names[d] ?? "??").join(",");
      return `每周 ${days} ${pad(parsed.hour)}:${pad(parsed.minute)}`;
    }
    default:
      return parsed.raw;
  }
}

function formatLocal(epochMs: number): string {
  const d = new Date(epochMs);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function pad(value: number | undefined): string {
  return String(value ?? 0).padStart(2, "0");
}
