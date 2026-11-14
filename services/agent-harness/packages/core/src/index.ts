/**
 * @harness/core — the ONLY public entry point.
 * Clients (cli/server/web) may import this specifier and nothing deeper.
 */
export { loadConfig, DEFAULT_CONFIG_PATH, STARTER_CONFIG_YAML } from "./config/loader.js";
export { configSchema, type HarnessConfig } from "./config/schema.js";
export { TurnMachine } from "./turn/machine.js";
export { OllamaRunner, ModelConnectionError, type RunnerMessage, type ChatResult } from "./model/runner.js";
export {
  type ProviderAdapter,
  type ProviderCapabilities,
  type ChatOptions,
  type AdapterChatResult,
} from "./model/types.js";
export { OpenAICompatibleAdapter, ProviderResponseError, ToolCallParseError } from "./model/openai.js";
export { CancelledError, isCancelledError, cancelReasonOf } from "./model/cancelled.js";
export { ProviderRegistry, API_FORMATS, type ApiFormat, type CustomModelInput, type ResolvedModel } from "./model/registry.js";
export { AnthropicMessagesAdapter, pairMessages } from "./model/anthropic.js";
export { OpenAIResponsesAdapter } from "./model/responses.js";
export {
  ToolRegistry,
  ToolRegistrationError,
  type ToolEntry,
  type ToolExecute,
  type ToolExecutionContext,
} from "./tool/registry.js";
export { registerBuiltinTools } from "./tools/builtin.js";
export { AgentRuntime, type TurnSummary, type AgentRuntimeOptions } from "./runtime/agent-runtime.js";
export { TraceWriter } from "./runtime/trace.js";
export { estimateTokens, messageTokens, messagesTokens } from "./context/tokens.js";
export {
  autoCompact,
  buildSummary,
  compactContext,
  GUARD_REFILL_RATIO,
  DEFAULT_KEEP_RECENT_TURNS,
  microCompact,
  RapidRefillGuard,
  type CompactionInput,
  type CompactionOutcome,
} from "./compact/compact.js";
export {
  MemoryManager,
  MemoryLimitError,
  DEFAULT_L2_MAX_CHARS,
  DEFAULT_L3_MAX_CHARS,
  DEFAULT_LOG_ROTATE_DAYS,
  type MemoryManagerOptions,
} from "./memory/manager.js";
export { createTaskTool, type TaskToolOptions } from "./subagent/task-tool.js";
export { WorktreeManager, WorktreeError } from "./worktree/worktree.js";

// Skills (design doc §10.1 — dual-channel activation: slash command + keyword trigger)
export {
  SkillRegistry,
  SkillError,
  type SkillManifest,
  type SkillRegistryOptions,
} from "./skills/loader.js";

// M7 — Automation (design doc §10, mechanism 5)
export {
  parseSchedule,
  nextRunAt,
  nextRunAtFrom,
  describeSchedule,
  ScheduleError,
  AutomationStore,
  AutomationStoreError,
  AutomationScheduler,
  AutomationError,
  type ParsedSchedule,
  type ScheduleErrorCode,
  type ScheduleKind,
  type AutomationRecord,
  type AutomationStoreErrorCode,
  type AutomationStoreOptions,
  type AutomationErrorCode,
  type AutomationInput,
  type AutomationRunResult,
  type AutomationSchedulerOptions,
  type AutomationStatus,
  type RuntimeFactory,
} from "./automation/index.js";

// M7 — multi-agent coordination (design doc §8.1): shared task board + message channel
export {
  SharedTaskBoard,
  TaskBoardError,
  registerTaskBoardTools,
  TASK_ADD_MANIFEST,
  TASK_CLAIM_MANIFEST,
  TASK_COMPLETE_MANIFEST,
  TASK_LIST_MANIFEST,
  AgentMessageChannel,
  MessageChannelError,
  registerMessageTools,
  MSG_DRAIN_MANIFEST,
  MSG_SEND_MANIFEST,
  type BoardTask,
  type ClaimConflictCode,
  type ClaimOutcome,
  type TaskBoardErrorCode,
  type TaskBoardFile,
  type TaskBoardOptions,
  type TaskStatus,
  type TaskBoardToolOptions,
  type AgentMessage,
  type MessageChannelErrorCode,
  type MessageChannelOptions,
  type MessageToolOptions,
} from "./tasks/index.js";
