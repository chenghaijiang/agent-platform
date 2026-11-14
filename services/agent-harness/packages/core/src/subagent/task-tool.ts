/**
 * `task:spawn` — the Task tool that runs a child AgentRuntime (design doc §8).
 *
 * Each spawn gets its own runtime, its own context and a filtered registry, so a subagent can
 * explore or implement without polluting the parent conversation. Two built-in profiles:
 *   - `explore`: read-only scout — only `fs:read_file` + `shell:run`, shell restricted to
 *     provably read-only commands (the shell read-only policy is forced on, §8.1).
 *   - `general`: every tool the parent has.
 *
 * `isolate: "worktree"` puts the child in a git worktree of its own (§8.1): the child's fs/shell
 * tools are re-registered against that directory (same tool names, so the permission service
 * still recognizes `shell:run`), writes are confined to the worktree prefix, and the closing
 * report carries `git diff --stat`. The worktree is intentionally kept — merging is a
 * `needsApproval` decision of the parent session, and M4 only supplies the diff.
 */
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { checkRedLines, type SessionEvent, type ToolManifest } from "@harness/contracts";
import type { HarnessConfig } from "../config/schema.js";
import type { OllamaRunner } from "../model/runner.js";
import type { ApprovalHandler } from "../permission/service.js";
import { AgentRuntime, type TurnSummary } from "../runtime/agent-runtime.js";
import { ToolRegistry } from "../tool/registry.js";
import { WorktreeError, WorktreeManager, type WorktreeInfo } from "../worktree/worktree.js";

export const TASK_TOOL_NAME = "task:spawn";

export type SubagentProfile = "explore" | "general";
export type SubagentIsolation = "none" | "worktree";

export interface TaskToolOptions {
  /** Parent config: permissions policy, loop budget and the model section are inherited. */
  parentConfig: HarnessConfig;
  /** Resolved provider adapter — whatever the surface (ProviderRegistry) selected. */
  runner: OllamaRunner;
  /** Parent registry: the source of the child's tool set (and its metadata). */
  parentRegistry: ToolRegistry;
  systemPrompt?: string;
  approvalHandler?: ApprovalHandler;
  /** Working directory for the child's fs/shell tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Repository root for worktree isolation. Defaults to `cwd`. */
  repoRoot?: string;
  /** Session-event sink; child events are mirrored here (design doc §8). */
  onEvent?: (event: SessionEvent) => void;
  /** Custom manager (layout override / tests). */
  worktrees?: WorktreeManager;
}

export interface TaskTool {
  manifest: ToolManifest;
  execute(input: unknown): Promise<string>;
}

export const TASK_TOOL_MANIFEST: ToolManifest = {
  name: TASK_TOOL_NAME,
  description:
    "Spawn a subagent with its own AgentRuntime and context. profile=explore is a read-only scout; " +
    "profile=general has all tools. isolate=worktree runs it in a git worktree (diff returned, never merged).",
  permission: "write",
  readOnly: false,
  destructive: false,
  concurrentSafe: false, // subagents run one at a time — no two child loops share a parent turn
  needsApproval: false,
  timeoutMs: 600_000,
  outputBudget: 20_000,
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "the task for the subagent", minLength: 1 },
      profile: {
        type: "string",
        enum: ["explore", "general"],
        default: "general",
        description: "explore = read-only recon, general = full toolset",
      },
      isolate: {
        type: "string",
        enum: ["none", "worktree"],
        default: "none",
        description: "worktree = isolated git working tree; requires a git repository",
      },
    },
    required: ["task"],
  },
};

export function createTaskTool(opts: TaskToolOptions): TaskTool {
  return {
    manifest: TASK_TOOL_MANIFEST,
    execute: (input) => runTask(opts, input),
  };
}

// ---------------------------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------------------------

const DEFAULT_PROMPT =
  "You are a precise personal agent. Use tools to accomplish the user's goal. " +
  "Validate assumptions with tools instead of guessing. Report key evidence (paths, command output) in your final answer.";

const EXPLORE_PROMPT =
  "You are the Explore subagent: a read-only scout. Use fs:read_file and shell:run (read-only commands " +
  "only) to gather evidence, then report findings concisely with file paths and command output. " +
  "You cannot modify anything — do not try.";

const MAX_RESULT_CHARS = 6_000;

async function runTask(opts: TaskToolOptions, rawInput: unknown): Promise<string> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) return "SUBAGENT_ERROR: `task` must be a non-empty string";

  const profile: SubagentProfile = input.profile === "explore" ? "explore" : "general";
  const isolate: SubagentIsolation = input.isolate === "worktree" ? "worktree" : "none";
  if (isolate === "worktree" && profile === "explore") {
    return "SUBAGENT_ERROR: explore is read-only and must not create a worktree (design doc §8.1)";
  }

  const cwd = resolvePath(opts.cwd ?? process.cwd());
  const repoRoot = resolvePath(opts.repoRoot ?? cwd);
  const taskId = randomUUID().slice(0, 8);

  let worktree: WorktreeInfo | undefined;
  const manager = opts.worktrees ?? new WorktreeManager({ repoRoot });
  if (isolate === "worktree") {
    try {
      worktree = await manager.create(repoRoot, taskId);
    } catch (err) {
      return formatError("SUBAGENT_WORKTREE_FAILED", err);
    }
  }

  const childCwd = worktree?.path ?? cwd;
  const registry = buildChildRegistry(opts.parentRegistry, {
    cwd: childCwd,
    writeRoot: worktree?.path,
    allow: profile === "explore" ? EXPLORE_TOOLS : undefined,
  });

  const child = new AgentRuntime({
    runner: opts.runner,
    registry,
    config: childConfig(opts.parentConfig, profile),
    systemPrompt: buildPrompt(opts.systemPrompt, profile, worktree),
    // explore fails closed: no approval handler means nothing write-ish can ever be approved.
    approvalHandler: profile === "explore" ? undefined : opts.approvalHandler,
    onEvent: (event) => emit(opts, event),
  });

  emit(opts, {
    type: "subagent_spawned",
    traceId: child.id,
    childRuntimeId: child.id,
    profile,
    background: false,
    ...(worktree ? { worktree: worktree.path } : {}),
    timestamp: Date.now(),
  });

  let summary: TurnSummary;
  try {
    summary = await child.runTurn(task);
  } catch (err) {
    return formatError("SUBAGENT_FAILED", err);
  }

  return asReport(profile, isolate, child.id, summary, worktree, manager, taskId);
}

/** Report: one-line status, result digest, and (when isolated) the diff the parent must judge. */
async function asReport(
  profile: SubagentProfile,
  isolate: SubagentIsolation,
  childId: string,
  summary: TurnSummary,
  worktree: WorktreeInfo | undefined,
  manager: WorktreeManager,
  taskId: string,
): Promise<string> {
  const lines = [
    `[subagent] profile=${profile} isolate=${isolate} id=${childId} reason=${summary.reason} ` +
      `iterations=${summary.iterations} duration=${(summary.durationMs / 1000).toFixed(1)}s`,
  ];
  if (worktree) {
    lines.push(
      `worktree: ${worktree.path} (branch ${worktree.branch}, kept — merge is the parent's approval decision)`,
    );
  }
  lines.push("--- result ---", clip(summary.text.trim() || "(no final text)", MAX_RESULT_CHARS));

  if (worktree) {
    lines.push(`--- diff (main...${worktree.branch}) ---`);
    try {
      lines.push(await manager.diffSummary(taskId));
    } catch (err) {
      lines.push(`diff unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// child tool set
// ---------------------------------------------------------------------------------------------

/** explore is limited to these two (design doc §8). */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set(["fs:read_file", "shell:run"]);

/** Replaced by cwd-aware versions so the child writes into its own tree, not the parent's cwd. */
const CWD_TOOLS: ReadonlySet<string> = new Set(["fs:read_file", "fs:write_file", "shell:run"]);

const MAX_FILE_BYTES = 512 * 1024;

interface ChildToolsOptions {
  cwd: string;
  /** Isolated worktree prefix — writes outside it are refused (§8.1). */
  writeRoot?: string;
  allow?: ReadonlySet<string>;
}

function buildChildRegistry(parent: ToolRegistry, opts: ChildToolsOptions): ToolRegistry {
  const child = new ToolRegistry();
  for (const manifest of parent.list()) {
    if (opts.allow && !opts.allow.has(manifest.name)) continue;
    if (CWD_TOOLS.has(manifest.name)) continue; // registered below, bound to the child's cwd
    const entry = parent.get(manifest.name);
    if (!entry) continue;
    child.register(manifest, entry.execute);
  }
  registerCwdTools(child, parent, opts);
  return child;
}

/** Same names as the parent tools — the permission service's `shell:run` policy keys off the name. */
function registerCwdTools(child: ToolRegistry, parent: ToolRegistry, opts: ChildToolsOptions): void {
  const allowed = (name: string) => !opts.allow || opts.allow.has(name);
  const read = parent.get("fs:read_file")?.manifest;
  const write = parent.get("fs:write_file")?.manifest;
  const shell = parent.get("shell:run")?.manifest;

  if (read && allowed(read.name)) {
    child.register(
      { ...read, description: `${read.description} Paths resolve against the subagent cwd (${opts.cwd}).` },
      async (input) => {
        const target = underCwd(opts.cwd, String((input as { path: string }).path));
        const st = statSync(target);
        if (st.isDirectory()) return `ERROR: ${target} is a directory`;
        return withLineNumbers(readFileSync(target, "utf8").slice(0, MAX_FILE_BYTES));
      },
    );
  }

  if (write && allowed(write.name)) {
    child.register(
      { ...write, description: `${write.description} Paths resolve against the subagent cwd (${opts.cwd}).` },
      async (input) => {
        const { path, content } = input as { path: string; content: string };
        const target = underCwd(opts.cwd, path);
        if (opts.writeRoot && !isInside(opts.writeRoot, target)) {
          return `DENIED: write outside the worktree prefix (${opts.writeRoot}): ${target}`;
        }
        writeFileSync(target, content, "utf8");
        return `OK: wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`;
      },
    );
  }

  if (shell && allowed(shell.name)) {
    child.register(
      { ...shell, description: `${shell.description} Runs with cwd = ${opts.cwd}.` },
      async (input) => {
        const { command, timeoutMs } = input as { command: string; timeoutMs?: number };
        const redLine = checkRedLines(command);
        if (redLine) return `DENIED by hard red line: ${redLine}`;
        const timeout = Math.min(timeoutMs ?? 30_000, 60_000);
        return new Promise<string>((resolve) => {
          exec(
            command,
            { cwd: opts.cwd, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
            (err, stdout, stderr) => {
              const parts: string[] = [];
              if (stdout) parts.push(stdout.slice(0, 32_000));
              if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 8_000)}`);
              if (err) parts.push(`[exit ${err.code ?? "?"}]${err.killed ? " (timeout)" : ""}`);
              resolve(parts.join("\n") || "(no output)");
            },
          );
        });
      },
    );
  }
}

/**
 * explore: add `write` to the confirmation levels so the shell read-only policy is the only way a
 * shell command can pass — everything else needs approval, and explore has no approval handler.
 */
function childConfig(parent: HarnessConfig, profile: SubagentProfile): HarnessConfig {
  if (profile !== "explore") return parent;
  const confirmLevels = [...parent.permissions.confirm_levels];
  if (!confirmLevels.includes("write")) confirmLevels.push("write");
  return { ...parent, permissions: { ...parent.permissions, confirm_levels: confirmLevels } };
}

function buildPrompt(
  base: string | undefined,
  profile: SubagentProfile,
  worktree: WorktreeInfo | undefined,
): string {
  const parts = [base ?? DEFAULT_PROMPT];
  if (profile === "explore") parts.push(EXPLORE_PROMPT);
  if (worktree) {
    parts.push(
      `Your working directory is an isolated git worktree: ${worktree.path} (branch ${worktree.branch}). ` +
        `Only that tree is writable; the parent session reviews your diff and decides on the merge.`,
    );
  }
  return parts.join("\n\n");
}

function emit(opts: TaskToolOptions, event: SessionEvent): void {
  if (opts.onEvent) {
    opts.onEvent(event);
    return;
  }
  if (event.type === "subagent_spawned") {
    console.error(
      `[subagent] spawned ${event.childRuntimeId} profile=${event.profile}` +
        (event.worktree ? ` worktree=${event.worktree}` : ""),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function underCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolvePath(root), target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function withLineNumbers(content: string, offset = 1): string {
  const lines = content.split("\n");
  return (
    lines
      .slice(0, 2000)
      .map((l, i) => `${String(offset + i).padStart(6)}\t${l}`)
      .join("\n") + (lines.length > 2000 ? `\n... (${lines.length - 2000} more lines truncated)` : "")
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} chars truncated)` : text;
}

function formatError(code: string, err: unknown): string {
  if (err instanceof WorktreeError) {
    return `${code}: ${err.code}: ${err.message}${err.detail ? `\n${err.detail}` : ""}`;
  }
  return `${code}: ${err instanceof Error ? err.message : String(err)}`;
}
