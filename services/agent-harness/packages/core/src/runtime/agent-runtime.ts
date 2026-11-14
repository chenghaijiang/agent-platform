/**
 * AgentRuntime — think -> schedule -> authorize -> act -> observe -> loop (design doc §4).
 *
 * Tool execution is metadata-driven: the scheduler turns this turn's calls into waves, the
 * permission service gates every single call, and the phase machine is the only way in or out.
 */
import { randomUUID } from "node:crypto";
import {
  type PermissionDecision,
  type PermissionRequest,
  type SessionEvent,
  type ToolCall,
  type ToolManifest,
  type ToolStatus,
  type TurnEndReason,
} from "@harness/contracts";
import type { HarnessConfig } from "../config/schema.js";
import { compactContext, GUARD_REFILL_RATIO, RapidRefillGuard } from "../compact/compact.js";
import { CancelledError, isCancelledError } from "../model/cancelled.js";
import type { ChatResult, OllamaRunner, RunnerMessage } from "../model/runner.js";
import { PermissionService, type ApprovalHandler } from "../permission/service.js";
import { ToolRegistry } from "../tool/registry.js";
import { scheduleCalls, type ScheduledCall } from "../tool/scheduler.js";
import { TurnMachine } from "../turn/machine.js";

export interface AgentRuntimeOptions {
  runner: OllamaRunner;
  registry: ToolRegistry;
  config: HarnessConfig;
  systemPrompt?: string;
  onEvent?: (event: SessionEvent) => void;
  /** Called for assistant text deltas (CLI streaming display). */
  onDelta?: (text: string) => void;
  /** Called after each tool execution (CLI tool-card display). */
  onToolResult?: (tool: string, status: string, output: string, durationMs: number) => void;
  /** Injected by the surface layer; drives the `awaiting_permission` phase. */
  approvalHandler?: ApprovalHandler;
  /** Provider context window in tokens (CLI passes `capabilities.contextWindow`). Default 32768. */
  contextWindow?: number;
  /** Memory block appended to the system prompt; see `setMemoryContext`. */
  memoryContext?: string;
}

/** Default system prompt when the surface layer does not supply one. */
const DEFAULT_SYSTEM_PROMPT =
  "You are a precise personal agent. Use tools to accomplish the user's goal. " +
  "Validate assumptions with tools instead of guessing. Report key evidence (paths, command output) in your final answer.";

/** Fallback context window when the caller has no provider capability at hand. */
const DEFAULT_CONTEXT_WINDOW = 32768;

/** Header that marks the memory block at the tail of the system prompt (design doc §5). */
const MEMORY_CONTEXT_HEADER = "[MEMORY CONTEXT]";
const SKILL_CONTEXT_HEADER = "[SKILL CONTEXT] — 以下技能内容是本回合的高优先级指令，请按其流程执行";

/** Omit that distributes over the SessionEvent union. */
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributedOmit<SessionEvent, "traceId" | "timestamp">;

export interface TurnSummary {
  traceId: string;
  reason: TurnEndReason;
  iterations: number;
  durationMs: number;
  text: string;
}

/**
 * A call to a tool the registry does not know still has to be scheduled and reported. It is
 * treated as destructive/non-concurrent so it can never be batched with real work.
 */
const UNKNOWN_TOOL_MANIFEST: ToolManifest = {
  name: "unknown:unknown",
  description: "unregistered tool",
  permission: "write",
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  needsApproval: false,
  timeoutMs: 1,
  outputBudget: 1,
  inputSchema: {},
};

interface ToolOutcome {
  /** `cancelled` is a runtime-only status: the call was unwound, never a tool failure. */
  status: ToolStatus | "cancelled";
  output: string;
  durationMs: number;
}

/** Observation recorded for every call cut short by a cancel (design doc §17.4). */
const CANCELLED_OUTPUT = "CANCELLED: turn interrupted by user";

/** Sentinel returned by `untilAborted` when the turn was cancelled mid-flight. */
const CANCELLED = Symbol("turn-cancelled");

/** Per-iteration bookkeeping so a cancel can still close every tool call it announced. */
interface InterruptedCalls {
  calls: readonly ToolCall[];
  started: Set<string>;
  finalized: Set<string>;
}

export class AgentRuntime {
  readonly id = randomUUID().slice(0, 8);
  private messages: RunnerMessage[] = [];
  private traceId = "";
  private readonly permissions: PermissionService;
  private readonly contextWindow: number;
  /** Latches after a compaction that leaves the context near the ceiling (§4.2 level 3). */
  private readonly refillGuard = new RapidRefillGuard();
  private memoryContext: string;
  /** Per-turn skill block (§10.1) — set before runTurn, cleared when the turn settles. */
  private skillContext: string;
  /** Per-turn abort scope — replaced at the start of every runTurn. */
  private turnAbort: AbortController | null = null;
  /** True from the first cancel() of the current turn until the turn settles. */
  private cancelled = false;
  private cancelReason: string | null = null;
  /** Observations that survived the current turn; reported by `turn_cancelled`. */
  private completedToolCalls = 0;
  /** 智能体 (tools) vs 智能问答 (plain chat) — see setToolsEnabled(). Default agent. */
  private toolsEnabled = true;

  constructor(private readonly opts: AgentRuntimeOptions) {
    this.permissions = new PermissionService({
      permissions: opts.config.permissions,
      approvalHandler: opts.approvalHandler,
    });
    this.contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.memoryContext = opts.memoryContext?.trim() ?? "";
    this.skillContext = "";
    this.messages.push({ role: "system", content: this.buildSystemPrompt() });
  }

  /**
   * Attach (or replace) the memory block. It is appended to the tail of the system prompt so the
   * static instructions stay first and memory reads as the most recent background knowledge.
   */
  setMemoryContext(memoryContext: string): void {
    this.memoryContext = memoryContext.trim();
    const system = this.messages[0];
    const content = this.buildSystemPrompt();
    if (system && system.role === "system") system.content = content;
    else this.messages.unshift({ role: "system", content });
  }

  /** Attach (or replace) the per-turn skill block (§10.1). Pass "" to clear. */
  setSkillContext(skillContext: string): void {
    this.skillContext = skillContext.trim();
    const system = this.messages[0];
    const content = this.buildSystemPrompt();
    if (system && system.role === "system") system.content = content;
    else this.messages.unshift({ role: "system", content });
  }

  /** Replace the base instructions (agent <-> chat mode switch); system message updated in place. */
  setSystemPrompt(prompt: string): void {
    this.opts.systemPrompt = prompt.trim();
    const system = this.messages[0];
    const content = this.buildSystemPrompt();
    if (system && system.role === "system") system.content = content;
    else this.messages.unshift({ role: "system", content });
  }

  /**
   * Chat mode (智能问答): tools stay registered but are withheld from the model and
   * hallucinated tool calls are ignored, so a turn is a single plain completion.
   * The conversation is untouched — toggling back restores full agent behavior.
   */
  setToolsEnabled(enabled: boolean): void {
    this.toolsEnabled = enabled;
  }

  isToolsEnabled(): boolean {
    return this.toolsEnabled;
  }

  /**
   * Conversation migration for model hot-swap (design doc §15.4): export the non-system
   * transcript so a rebuilt runtime can continue the same conversation on another model.
   */
  exportConversation(): RunnerMessage[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  /** Append a previous conversation (system messages are dropped — the new runtime has its own). */
  loadConversation(messages: RunnerMessage[]): void {
    this.messages.push(...messages.filter((m) => m.role !== "system"));
  }

  private buildSystemPrompt(): string {
    let base = this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    if (this.skillContext) base = `${base}\n\n${SKILL_CONTEXT_HEADER}\n${this.skillContext}`;
    if (!this.memoryContext) return base;
    return `${base}\n\n${MEMORY_CONTEXT_HEADER}\n${this.memoryContext}`;
  }

  /**
   * Cooperative turn interruption (design doc §17.4). The first call unwinds the running turn —
   * model stream, in-flight tools and pending approval all see the abort — and the loop settles
   * through `cancelling -> completing` with `user_interrupted`. Repeated calls are no-ops; the
   * surface layer (CLI SIGINT handler, POST /api/cancel) decides when a second press means "kill".
   */
  cancel(reason = "user"): void {
    if (this.cancelled) return; // idempotent: the first cancel owns the reason
    this.cancelled = true;
    this.cancelReason = reason;
    // Abort immediately so fetch()/child processes stop without waiting for the next boundary.
    this.turnAbort?.abort(new CancelledError(reason));
  }

  async runTurn(userInput: string): Promise<TurnSummary> {
    const { config, runner, registry } = this.opts;
    const machine = new TurnMachine((from, to) =>
      this.emit({ type: "phase_changed", from: from ?? "start", to }),
    );
    this.traceId = randomUUID().slice(0, 8);
    const traceId = this.traceId;

    // A fresh turn owns a fresh cancellation scope: yesterday's Ctrl+C must not leak into it.
    const controller = new AbortController();
    const signal = controller.signal;
    this.turnAbort = controller;
    this.cancelled = false;
    this.cancelReason = null;
    this.completedToolCalls = 0;

    // 1. processing_input
    this.messages.push({ role: "user", content: userInput });
    this.emit({ type: "turn_started", turn: 1 });

    let iterations = 0;
    let lastText = "";
    let reason: TurnEndReason = "max_iterations_reached";
    let cancelled = false;
    /** Tool calls announced by the current iteration — a cancel still has to close them. */
    let interrupted: InterruptedCalls | null = null;

    try {
      while (iterations < config.loop.max_iterations) {
        // Phase boundary: cancellation is only ever observed at a boundary, never mid-step.
        if (this.cancelled) {
          cancelled = true;
          break;
        }

        // 1b. context budget: micro-compact -> auto-compact -> rapid-refill guard (§4.2).
        this.compactIfNeeded();

        // 2. awaiting_model
        machine.to("awaiting_model");
        iterations++;
        if (this.cancelled) {
          cancelled = true;
          break;
        }

        // 3. streaming — transient model failures (e.g. Ollama-side malformed
        //    function-call XML → HTTP 500) retry within the loop retry budget
        //    instead of killing the whole turn (design doc §15.1).
        machine.to("streaming");
        const retryBudget = this.opts.config?.loop?.retry_budget ?? 2;
        let modelAttempts = 0;
        let result: ChatResult | undefined;
        for (;;) {
          try {
            result = await runner.chat(this.messages, this.toolsEnabled ? registry.toNativeTools() : [], {
              onDelta: this.opts.onDelta,
              signal,
            });
            break;
          } catch (err) {
            // An aborted stream is not a turn failure — it falls through to the cancellation tail.
            if (this.isCancellation(err)) {
              cancelled = true;
              break;
            }
            modelAttempts++;
            if (modelAttempts > retryBudget) throw err;
            const delayMs = Math.min(4000, 500 * modelAttempts);
            this.emit({
              type: "message_appended",
              message: {
                role: "system",
                content: [{ type: "text", text: `[model_retry] 模型调用失败（${err instanceof Error ? err.message : String(err)}），${delayMs}ms 后第 ${modelAttempts}/${retryBudget} 次重试` }],
                timestamp: Date.now(),
              },
            });
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (cancelled || result === undefined) break;
        lastText = result.content;
        this.emit({
          type: "message_appended",
          message: { role: "assistant", content: [{ type: "text", text: result.content }], timestamp: Date.now() },
        });

        if (this.cancelled) {
          cancelled = true;
          break;
        }

        // 4. no tool calls -> done. In chat mode hallucinated calls (no tools were
        //    offered) are treated as plain text — never executed.
        if (result.toolCalls.length === 0 || !this.toolsEnabled) {
          reason = "goal_completed";
          break;
        }

        this.messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // 5. scheduling_tools — metadata decides the wave plan.
        machine.to("scheduling_tools");
        const calls: ToolCall[] = result.toolCalls.map((tc) => ({
          id: tc.id,
          tool: tc.name,
          input: tc.arguments,
        }));
        const iteration: InterruptedCalls = { calls, started: new Set(), finalized: new Set() };
        interrupted = iteration;
        if (this.cancelled) {
          cancelled = true;
          break;
        }

        const entries: ScheduledCall[] = calls.map((call) => ({
          call,
          manifest: registry.get(call.tool)?.manifest ?? UNKNOWN_TOOL_MANIFEST,
        }));
        const waves = scheduleCalls(entries, config.loop.parallel_tool_limit);

        // Authorize the whole turn first: the phase machine allows exactly one suspension point
        // per iteration (executing_tools cannot go back to awaiting_permission).
        const decisions = new Map<string, PermissionDecision>();
        const pending: { request: PermissionRequest; manifest: ToolManifest }[] = [];
        for (const { call, manifest } of entries) {
          const request: PermissionRequest = { call, level: manifest.permission };
          const decision = this.permissions.evaluate(request, manifest);
          if (decision.kind === "needs_user_approval") pending.push({ request, manifest });
          else decisions.set(call.id, decision);
        }

        if (pending.length > 0) {
          machine.to("awaiting_permission");
          for (const { request, manifest } of pending) {
            if (this.cancelled) {
              cancelled = true;
              break;
            }
            this.emit({
              type: "permission_requested",
              callId: request.call.id,
              tool: request.call.tool,
              level: request.level,
            });
            // A human may take forever to answer — the abort must be what ends the wait.
            const resolved = await this.untilAborted(
              this.permissions.requestApproval(request, manifest),
              signal,
            );
            if (resolved === CANCELLED) {
              cancelled = true;
              break;
            }
            this.emit({
              type: "permission_resolved",
              callId: request.call.id,
              kind: resolved.kind,
              source: resolved.source,
            });
            decisions.set(request.call.id, resolved);
          }
          if (cancelled) break;
        }

        // 6. executing_tools — parallel waves via Promise.all, everything else one by one.
        machine.to("executing_tools");
        for (const wave of waves) {
          const concurrent = wave.parallel && wave.calls.length > 1;
          if (concurrent) {
            for (const call of wave.calls) {
              this.emitStarted(call, wave.index, true);
              iteration.started.add(call.id);
            }
            const outcomes = await Promise.all(
              wave.calls.map((call) => this.executeCall(call, decisions.get(call.id), signal)),
            );
            // Observations are appended in submission order, whatever the completion order was.
            wave.calls.forEach((call, i) => {
              this.finalizeCall(call, outcomes[i]!);
              iteration.finalized.add(call.id);
            });
          } else {
            for (const call of wave.calls) {
              this.emitStarted(call, wave.index, false);
              iteration.started.add(call.id);
              this.finalizeCall(call, await this.executeCall(call, decisions.get(call.id), signal));
              iteration.finalized.add(call.id);
              if (this.cancelled) break;
            }
          }
          if (this.cancelled) {
            cancelled = true;
            break;
          }
        }
        if (cancelled) break;

        // 7. aggregating_results -> back to model
        machine.to("aggregating_results");
      }
    } catch (err) {
      if (this.isCancellation(err)) {
        cancelled = true;
      } else {
        reason = "error";
        lastText = `RUNTIME_ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      this.turnAbort = null;
    }

    // Cancellation is a graceful close, not a crash: every announced call gets an observation and
    // the trace gets `cancelling` + `turn_cancelled` before the regular completion tail.
    if (cancelled) {
      if (interrupted) this.closeInterrupted(interrupted);
      const phase = machine.phase;
      reason = "user_interrupted";
      if (machine.canGo("cancelling")) machine.to("cancelling");
      this.emit({
        type: "turn_cancelled",
        reason: this.cancelReason ?? "user",
        phase,
        completedToolCalls: this.completedToolCalls,
      });
    }

    const summary = machine.finish(reason);
    this.emit({ type: "turn_completed", reason, iterations: summary.iterations });
    return { traceId, reason, iterations: summary.iterations, durationMs: summary.durationMs, text: lastText };
  }

  /**
   * Resolve with the sentinel as soon as the signal aborts. Work that ignores the signal keeps
   * running on its own (we cannot kill an arbitrary promise), but the turn never waits for it.
   */
  private untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof CANCELLED> {
    if (signal.aborted) return Promise.resolve(CANCELLED);
    return new Promise<T | typeof CANCELLED>((resolve, reject) => {
      const onAbort = () => resolve(CANCELLED);
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  /** True only for "the user cancelled" — never for a genuine provider or tool failure. */
  private isCancellation(err: unknown): boolean {
    return this.cancelled || isCancelledError(err);
  }

  /**
   * Cancel landed between "the model asked for tools" and "every call reported back". Calls that
   * started are finalized with status `cancelled`; calls that never started still get an
   * observation so the transcript keeps a valid tool-call/tool-result pairing.
   */
  private closeInterrupted(state: InterruptedCalls): void {
    for (const call of state.calls) {
      if (state.finalized.has(call.id)) continue;
      const outcome: ToolOutcome = { status: "cancelled", output: CANCELLED_OUTPUT, durationMs: 0 };
      if (state.started.has(call.id)) this.finalizeCall(call, outcome);
      else this.messages.push({ role: "tool", content: CANCELLED_OUTPUT, tool_name: call.tool });
    }
  }

  /**
   * Keep the transcript inside the model's window: micro-compact first, auto-compact only if that
   * was not enough, and a single warning once the rapid-refill guard latches (design doc §4.2).
   */
  private compactIfNeeded(): void {
    const thresholdTokens = Math.floor(
      this.contextWindow * this.opts.config.context.auto_compact_threshold,
    );
    const outcome = compactContext(this.messages, {
      thresholdTokens,
      guard: this.refillGuard,
      guardEnabled: this.opts.config.context.rapid_refill_guard,
    });

    if (outcome.level) {
      this.messages = outcome.messages;
      this.emit({
        type: "compaction_triggered",
        level: outcome.level,
        tokensBefore: outcome.tokensBefore,
        tokensAfter: outcome.tokensAfter,
      });
    }

    if (outcome.guardActivated) {
      console.error(
        `[context] rapid-refill guard ON: 压缩后仍占 ${outcome.tokensAfter}/${thresholdTokens} tokens ` +
          `(> ${Math.round(GUARD_REFILL_RATIO * 100)}%) → 后续跳过 auto-compact，避免 compact-thrash`,
      );
    }
  }

  /** `wave`/`parallel` are the real plan values — no more hardcoded 0/false. */
  private emitStarted(call: ToolCall, wave: number, parallel: boolean): void {
    this.emit({ type: "tool_call_started", callId: call.id, tool: call.tool, wave, parallel });
  }

  /** Close the book on one call: event, surface callback, and the observation fed back to the model. */
  private finalizeCall(call: ToolCall, outcome: ToolOutcome): void {
    this.emit({
      type: "tool_call_finished",
      callId: call.id,
      status: outcome.status,
      durationMs: outcome.durationMs,
    });
    this.opts.onToolResult?.(call.tool, outcome.status, outcome.output, outcome.durationMs);
    this.messages.push({
      role: "tool",
      content: outcome.output.slice(0, 20_000),
      tool_name: call.tool,
    });
    // `turn_cancelled.completedToolCalls` counts observations, not attempts.
    if (outcome.status !== "cancelled") this.completedToolCalls++;
  }

  private async executeCall(
    call: ToolCall,
    decision: PermissionDecision | undefined,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    // No decision means the gate never saw this call — refuse rather than run it.
    if (!decision || decision.kind !== "allowed") {
      return {
        status: "denied",
        output:
          decision && decision.source === "denylist" ? `DENIED: ${decision.reason}` : "DENIED by user",
        durationMs: 0,
      };
    }

    const started = Date.now();
    const cancelledOutcome = (): ToolOutcome => ({
      status: "cancelled",
      output: CANCELLED_OUTPUT,
      durationMs: Date.now() - started,
    });
    if (signal.aborted) return cancelledOutcome();

    const entry = this.opts.registry.get(call.tool);
    if (!entry) {
      return { status: "error", output: `UNKNOWN_TOOL: ${call.tool}`, durationMs: Date.now() - started };
    }

    const validation = this.opts.registry.validateInput(call.tool, call.input);
    if (!validation.ok) {
      return {
        status: "error",
        output: `INPUT_VALIDATION_FAILED: ${validation.errors.join("; ")}`,
        durationMs: Date.now() - started,
      };
    }

    try {
      // The signal lets the tool kill its own work; untilAborted keeps a tool that ignores it
      // from holding the turn hostage.
      const output = await this.untilAborted(entry.execute(call.input, { signal }), signal);
      if (output === CANCELLED) return cancelledOutcome();
      return { status: "ok", output, durationMs: Date.now() - started };
    } catch (err) {
      // Never retry/report an interrupted call as a failure — it was the user's decision.
      if (this.isCancellation(err) || signal.aborted) return cancelledOutcome();
      return {
        status: "error",
        output: `TOOL_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  }

  private emit(event: EventInput) {
    const full = { traceId: this.traceId, timestamp: Date.now(), ...event } as SessionEvent;
    this.opts.onEvent?.(full);
  }
}
