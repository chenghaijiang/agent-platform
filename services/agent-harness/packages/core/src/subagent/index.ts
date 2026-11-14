/** Subagent runtime (design doc §8) — Task tool + worktree-isolated child runtimes. */
export {
  createTaskTool,
  TASK_TOOL_NAME,
  TASK_TOOL_MANIFEST,
  type SubagentProfile,
  type SubagentIsolation,
  type TaskTool,
  type TaskToolOptions,
} from "./task-tool.js";
export { WorktreeManager, WorktreeError, type WorktreeInfo, type WorktreeErrorCode } from "../worktree/worktree.js";
