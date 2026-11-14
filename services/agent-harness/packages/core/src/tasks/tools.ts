/**
 * Task-board tools (design doc §7 + §8.1 coordination). Four tools, names are the contract:
 *
 *   task:list     read-only   → safe to run in parallel, never blocks another agent
 *   task:add      write       → creates a pending task
 *   task:claim    write       → takes ownership; contention returns a structured conflict
 *   task:complete write       → closes the task with an optional result note
 *
 * Tool output is always JSON so an agent can parse `ok` / `code` instead of scraping prose.
 */
import type { ToolManifest } from "@harness/contracts";
import type { ToolRegistry } from "../tool/registry.js";
import { SharedTaskBoard, TaskBoardError, type BoardTask, type ClaimOutcome } from "./board.js";

export interface TaskBoardToolOptions {
  /** Default agent id when a call omits one; a function is resolved at call time (runtime ids). */
  agentId?: string | (() => string);
}

export function registerTaskBoardTools(
  registry: ToolRegistry,
  board: SharedTaskBoard,
  opts: TaskBoardToolOptions = {},
): void {
  const resolveAgent = (raw: unknown): string | undefined => {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return typeof opts.agentId === "function" ? opts.agentId() : opts.agentId;
  };

  registry.register(TASK_LIST_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    try {
      const all = await board.list();
      const status = typeof raw.status === "string" ? raw.status : undefined;
      const onlyMine = raw.mine === true;
      const me = onlyMine ? resolveAgent(raw.agentId) : undefined;

      const tasks = all.filter((task) => {
        if (status && task.status !== status) return false;
        if (onlyMine && task.claimedBy !== me) return false;
        return true;
      });
      return JSON.stringify(
        {
          ok: true,
          total: all.length,
          counts: countByStatus(all),
          tasks: tasks.map((task) => ({ ...task })),
        },
        null,
        2,
      );
    } catch (err) {
      return errorJson(err);
    }
  });

  registry.register(TASK_ADD_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    try {
      const task = await board.add(String(raw.title ?? ""), {
        ...(typeof raw.assignee === "string" && raw.assignee.trim() ? { assignee: raw.assignee.trim() } : {}),
      });
      return JSON.stringify({ ok: true, task }, null, 2);
    } catch (err) {
      return errorJson(err);
    }
  });

  registry.register(TASK_CLAIM_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const agent = resolveAgent(raw.agentId);
    if (!agent) return JSON.stringify({ ok: false, code: "missing_agent_id", message: "缺少 agentId" }, null, 2);
    try {
      const outcome: ClaimOutcome = await board.claim(String(raw.id ?? ""), agent);
      if (!outcome.ok) {
        return JSON.stringify(
          {
            ok: false,
            code: outcome.code,
            message: outcome.message,
            // Full task so the agent can pick another one without a second round trip.
            task: { ...outcome.task },
          },
          null,
          2,
        );
      }
      return JSON.stringify({ ok: true, task: { ...outcome.task }, ...(outcome.reclaimed ? { reclaimed: true } : {}) }, null, 2);
    } catch (err) {
      return errorJson(err);
    }
  });

  registry.register(TASK_COMPLETE_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const agent = resolveAgent(raw.agentId);
    if (!agent) return JSON.stringify({ ok: false, code: "missing_agent_id", message: "缺少 agentId" }, null, 2);
    try {
      const task = await board.complete(
        String(raw.id ?? ""),
        agent,
        typeof raw.result === "string" ? raw.result : undefined,
      );
      return JSON.stringify({ ok: true, task }, null, 2);
    } catch (err) {
      return errorJson(err);
    }
  });
}

export const TASK_LIST_MANIFEST: ToolManifest = {
  name: "task:list",
  description:
    "List the shared task board (file .harness/tasks.json). Read-only and safe to run in parallel. " +
    "Use it before claiming work so you do not duplicate another agent.",
  permission: "read",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 8_000,
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "claimed", "done"], description: "filter by status" },
      mine: { type: "boolean", description: "only tasks claimed by this agent" },
      agentId: { type: "string", description: "agent id used with mine=true" },
    },
    required: [],
  },
};

export const TASK_ADD_MANIFEST: ToolManifest = {
  name: "task:add",
  description:
    "Add a task to the shared board. Keep titles short and actionable: another agent may pick it up " +
    "with no other context. Returns the created task with its id.",
  permission: "write",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 2_000,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "what has to be done", minLength: 1 },
      assignee: { type: "string", description: "optional suggested owner" },
    },
    required: ["title"],
  },
};

export const TASK_CLAIM_MANIFEST: ToolManifest = {
  name: "task:claim",
  description:
    "Claim a pending task for this agent. If another agent already holds it, returns " +
    "{ ok: false, code: 'already_claimed' } with the task so you can pick a different one.",
  permission: "write",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 2_000,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "task id from task:list", minLength: 1 },
      agentId: { type: "string", description: "agent id (defaults to this session)" },
    },
    required: ["id"],
  },
};

export const TASK_COMPLETE_MANIFEST: ToolManifest = {
  name: "task:complete",
  description:
    "Mark a claimed task done and attach a short result. Only the claimant may complete a task; " +
    "the result is what the coordinator reads afterwards.",
  permission: "write",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 2_000,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "task id", minLength: 1 },
      result: { type: "string", description: "short outcome note (paths, verdict, next step)" },
      agentId: { type: "string", description: "agent id (defaults to this session)" },
    },
    required: ["id"],
  },
};

function countByStatus(tasks: BoardTask[]): Record<string, number> {
  const counts: Record<string, number> = { pending: 0, claimed: 0, done: 0 };
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function errorJson(err: unknown): string {
  const code = err instanceof TaskBoardError ? err.code : "TASK_BOARD_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ ok: false, code, message }, null, 2);
}
