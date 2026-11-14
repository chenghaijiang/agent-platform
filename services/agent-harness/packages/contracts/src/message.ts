/** Session messages & typed events (design doc §3 contracts layer). */
import type { TurnPhase } from "./turn.js";

export type Role = "user" | "assistant" | "system" | "tool";

export interface TextBlock { type: "text"; text: string }
export interface ToolCallBlock { type: "tool_call"; callId: string; tool: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; callId: string; resultJson: string }

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
  timestamp: number;
}

/** Every observable thing that happens in a session — the trace & UI consume these. */
export type SessionEvent =
  | { type: "turn_started"; traceId: string; turn: number; timestamp: number }
  | { type: "phase_changed"; traceId: string; from: string; to: string; timestamp: number }
  | { type: "message_appended"; traceId: string; message: Message; timestamp: number }
  | { type: "tool_call_started"; traceId: string; callId: string; tool: string; wave: number; parallel: boolean; timestamp: number }
  | { type: "tool_call_finished"; traceId: string; callId: string; status: string; durationMs: number; timestamp: number }
  | { type: "permission_requested"; traceId: string; callId: string; tool: string; level: string; timestamp: number }
  | { type: "permission_resolved"; traceId: string; callId: string; kind: string; source: string; timestamp: number }
  | { type: "compaction_triggered"; traceId: string; level: "micro" | "auto"; tokensBefore: number; tokensAfter: number; timestamp: number }
  | { type: "subagent_spawned"; traceId: string; childRuntimeId: string; profile: string; background: boolean; worktree?: string; timestamp: number }
  /**
   * The turn was interrupted cooperatively (design doc §17.4): `phase` is where the loop stood
   * when cancel() landed, `completedToolCalls` counts observations that survived the unwind.
   */
  | { type: "turn_cancelled"; traceId: string; reason: string; phase: TurnPhase; completedToolCalls: number; timestamp: number }
  | { type: "turn_completed"; traceId: string; reason: string; iterations: number; timestamp: number };

export type SessionEventType = SessionEvent["type"];
