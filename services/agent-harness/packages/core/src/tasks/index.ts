/** Multi-agent coordination layer (design doc §8.1) — shared task board + message channel. */
export {
  SharedTaskBoard,
  TaskBoardError,
  type BoardTask,
  type ClaimConflictCode,
  type ClaimOutcome,
  type TaskBoardErrorCode,
  type TaskBoardFile,
  type TaskBoardOptions,
  type TaskStatus,
} from "./board.js";
export {
  registerTaskBoardTools,
  TASK_ADD_MANIFEST,
  TASK_CLAIM_MANIFEST,
  TASK_COMPLETE_MANIFEST,
  TASK_LIST_MANIFEST,
  type TaskBoardToolOptions,
} from "./tools.js";
export {
  AgentMessageChannel,
  MessageChannelError,
  registerMessageTools,
  MSG_DRAIN_MANIFEST,
  MSG_SEND_MANIFEST,
  type AgentMessage,
  type MessageChannelErrorCode,
  type MessageChannelOptions,
  type MessageToolOptions,
} from "./message.js";
