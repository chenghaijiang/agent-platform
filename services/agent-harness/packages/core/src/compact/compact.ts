/**
 * Three-level context compression (design doc §4.2).
 *
 *   1. micro-compact      — blank out tool output of turns that are no longer recent, keeping the
 *                           message structure (assistant.tool_calls ↔ tool) fully intact.
 *   2. auto-compact       — replace the older half of the conversation with a locally generated
 *                           summary (no LLM call), keeping [system, summary, recent turns].
 *   3. rapid-refill guard — if we are still near the ceiling right after compacting, stop
 *                           auto-compacting for the rest of the run (compact-thrash protection).
 */
import type { RunnerMessage } from "../model/runner.js";
import { messagesTokens } from "../context/tokens.js";

/** How many trailing user turns are always kept verbatim. */
export const DEFAULT_KEEP_RECENT_TURNS = 3;
/** Post-compaction fill ratio above which the rapid-refill guard arms itself. */
export const GUARD_REFILL_RATIO = 0.8;

const TOOL_PLACEHOLDER_PREFIX = "[tool result omitted:";
const FIRST_LINE_LIMIT = 80;
const NO_CONCLUSION = "（未完成／无明确结论）";

/**
 * Level 1 — drop the *content* of tool results from everything older than the last N user turns.
 *
 * Only `content` is rewritten: assistant messages carrying `tool_calls` and the tool messages
 * answering them stay in place and stay paired, so the provider never sees an orphaned call or
 * an orphaned result. Tool messages are positional in `RunnerMessage` (there is no tool_call_id
 * field), so "not deleting anything" is exactly what keeps the chain valid.
 */
export function microCompact(
  messages: readonly RunnerMessage[],
  keepRecentTurns: number = DEFAULT_KEEP_RECENT_TURNS,
): RunnerMessage[] {
  const keepFrom = recentTurnsStart(messages, keepRecentTurns);
  return messages.map((message, index) =>
    index >= keepFrom || message.role !== "tool" ? message : omitToolResult(message),
  );
}

/**
 * Level 2 — collapse history into `[system..., summary, recent turns]`.
 *
 * The summary is derived locally: one line per earlier turn ("user goal → final conclusion"),
 * so it costs no model call and is deterministic/replayable.
 */
export function autoCompact(
  messages: readonly RunnerMessage[],
  keepRecentTurns: number = DEFAULT_KEEP_RECENT_TURNS,
): RunnerMessage[] {
  const keepFrom = recentTurnsStart(messages, keepRecentTurns);
  const history = messages.slice(0, keepFrom);
  const tail = messages.slice(keepFrom);
  const lines = summarizeTurns(history);

  // Nothing worth summarizing (e.g. everything is still "recent") — leave the transcript alone
  // rather than injecting an empty summary message.
  if (lines.length === 0) return [...messages];

  const system = history.filter((message) => message.role === "system");
  return [...system, { role: "user", content: buildSummary(lines) }, ...tail];
}

/** Local, deterministic conversation summary — no model round-trip. */
export function buildSummary(lines: readonly string[]): string {
  return `[CONVERSATION COMPACTED] 早前对话摘要：\n${lines.join("\n")}`;
}

/**
 * Level 3 — compact-thrash protection.
 *
 * Once a compaction leaves the context above 80% of the trigger threshold, further auto-compacts
 * would only re-summarize a conversation that is already minimal, so the guard latches and the
 * runtime skips them (emitting a single warning) until the context drops well below the limit.
 */
export class RapidRefillGuard {
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Record the post-compaction fill ratio. Returns true when the guard is armed after this call.
   * Disabled by config (`context.rapid_refill_guard: false`) → never armed.
   */
  check(tokensAfter: number, thresholdTokens: number, enabled = true): boolean {
    if (!enabled) return false;
    if (tokensAfter > thresholdTokens * GUARD_REFILL_RATIO) this.active = true;
    return this.active;
  }

  reset(): void {
    this.active = false;
  }
}

export interface CompactionInput {
  /** Absolute trigger budget: `contextWindow * auto_compact_threshold`. */
  thresholdTokens: number;
  /** Shared guard instance so state survives across loop iterations. */
  guard?: RapidRefillGuard;
  /** `config.context.rapid_refill_guard`. */
  guardEnabled?: boolean;
  keepRecentTurns?: number;
}

export interface CompactionOutcome {
  /** The transcript to use from now on (the original array when nothing happened). */
  messages: RunnerMessage[];
  /** Which level actually ran, or null when the context is still small enough. */
  level: "micro" | "auto" | null;
  tokensBefore: number;
  tokensAfter: number;
  /** Guard state after this call. */
  guardActive: boolean;
  /** True only on the call that armed the guard (emit the warning once). */
  guardActivated: boolean;
}

/**
 * One compaction decision for the top of a turn: no-op while under the threshold, micro-compact
 * first, auto-compact only if micro was not enough, and never auto-compact while the guard latches.
 */
export function compactContext(
  messages: readonly RunnerMessage[],
  input: CompactionInput,
): CompactionOutcome {
  const { thresholdTokens } = input;
  const guard = input.guard ?? new RapidRefillGuard();
  const guardEnabled = input.guardEnabled ?? true;
  const keepRecentTurns = input.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const tokensBefore = messagesTokens(messages);

  // Recovered: plenty of room again → let auto-compact back in.
  if (guardEnabled && tokensBefore <= thresholdTokens * 0.5) guard.reset();

  const skipped = (): CompactionOutcome => ({
    messages: [...messages],
    level: null,
    tokensBefore,
    tokensAfter: tokensBefore,
    guardActive: guard.isActive,
    guardActivated: false,
  });

  if (tokensBefore <= thresholdTokens) return skipped();

  // Latched: auto-compact is off the table, but a cheap micro-compact is still allowed when it
  // actually frees tokens (idempotent, so a second pass is silent instead of event spam).
  if (guardEnabled && guard.isActive) {
    const trimmed = microCompact(messages, keepRecentTurns);
    const trimmedTokens = messagesTokens(trimmed);
    if (trimmedTokens >= tokensBefore) return skipped();
    return {
      messages: trimmed,
      level: "micro",
      tokensBefore,
      tokensAfter: trimmedTokens,
      guardActive: true,
      guardActivated: false,
    };
  }

  const micro = microCompact(messages, keepRecentTurns);
  const microTokens = messagesTokens(micro);
  const compacted = microTokens > thresholdTokens ? autoCompact(micro, keepRecentTurns) : micro;
  const level: "micro" | "auto" = microTokens > thresholdTokens ? "auto" : "micro";
  const tokensAfter = messagesTokens(compacted);

  const wasActive = guard.isActive;
  const isActive = guard.check(tokensAfter, thresholdTokens, guardEnabled);

  return {
    messages: compacted,
    level,
    tokensBefore,
    tokensAfter,
    guardActive: isActive,
    guardActivated: !wasActive && isActive,
  };
}

/** Index of the user message that opens the Nth-from-last turn (0 = keep everything). */
function recentTurnsStart(messages: readonly RunnerMessage[], keepRecentTurns: number): number {
  if (keepRecentTurns <= 0) return messages.length;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== "user") continue;
    seen++;
    if (seen === keepRecentTurns) return index;
  }
  return 0;
}

/** One line per turn: `- 用户: <goal> → 结论: <final assistant text>`. */
function summarizeTurns(history: readonly RunnerMessage[]): string[] {
  const lines: string[] = [];
  let goal: string | null = null;
  let conclusion: string | null = null;

  const flush = (): void => {
    if (goal === null && conclusion === null) return;
    lines.push(`- 用户: ${goal ?? "（无）"} → 结论: ${conclusion ?? NO_CONCLUSION}`);
    goal = null;
    conclusion = null;
  };

  for (const message of history) {
    if (message.role === "user") {
      flush();
      goal = firstLine(message.content) || "（无）";
    } else if (message.role === "assistant" && message.content && message.content.trim()) {
      // The last assistant text of the turn is its final conclusion.
      conclusion = firstLine(message.content) || NO_CONCLUSION;
    }
  }
  flush();
  return lines;
}

/** Replace a tool result's body with a one-line placeholder; idempotent. */
function omitToolResult(message: RunnerMessage): RunnerMessage {
  const content = message.content ?? "";
  if (content.startsWith(TOOL_PLACEHOLDER_PREFIX)) return message;

  const tool = message.tool_name ?? "unknown";
  const status = inferToolStatus(content);
  const line = firstLine(content);
  const detail = line ? ` ${line.slice(0, FIRST_LINE_LIMIT)}` : "";
  return { ...message, content: `${TOOL_PLACEHOLDER_PREFIX} ${tool} ${status}${detail}]` };
}

/**
 * `RunnerMessage` tool results do not carry a status field, so recover it from the structured
 * prefixes the runtime writes (`DENIED…`, `TOOL_ERROR…`, `INPUT_VALIDATION_FAILED…`, …).
 */
function inferToolStatus(content: string): string {
  const head = content.trimStart();
  if (!head) return "ok";
  if (head.startsWith("DENIED")) return "denied";
  if (
    head.startsWith("TOOL_ERROR") ||
    head.startsWith("INPUT_VALIDATION_FAILED") ||
    head.startsWith("UNKNOWN_TOOL")
  ) {
    return "error";
  }
  return "ok";
}

function firstLine(content: string | null | undefined): string {
  if (!content) return "";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
