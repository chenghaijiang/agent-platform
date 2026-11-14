/**
 * Turn phase state machine — the explicit contract for Agent Loop (design doc §4.1).
 * Illegal transitions MUST throw; the loop may never be an implicit while-loop.
 */
export const TURN_PHASES = [
  "processing_input",
  "awaiting_model",
  "streaming",
  "scheduling_tools",
  "awaiting_permission",
  "executing_tools",
  "aggregating_results",
  /** Cooperative interruption: in-flight work is unwound, never crashed (design doc §17.4). */
  "cancelling",
  "completing",
] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

/** Legal phase transitions. Anything not listed here is a bug. */
export const PHASE_TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  processing_input: ["awaiting_model", "completing"],
  awaiting_model: ["streaming", "cancelling", "completing"],
  streaming: ["scheduling_tools", "cancelling", "completing"],
  scheduling_tools: ["awaiting_permission", "executing_tools", "awaiting_model", "cancelling", "completing"],
  awaiting_permission: ["executing_tools", "awaiting_model", "cancelling", "completing"],
  executing_tools: ["aggregating_results", "cancelling", "completing"],
  aggregating_results: ["awaiting_model", "cancelling", "completing"],
  /** Cancellation always unwinds into the normal completion tail — one way out. */
  cancelling: ["completing"],
  completing: [],
};

export class IllegalPhaseTransitionError extends Error {
  constructor(
    public readonly from: TurnPhase,
    public readonly to: TurnPhase,
  ) {
    super(`Illegal phase transition: ${from} -> ${to}`);
    this.name = "IllegalPhaseTransitionError";
  }
}

export function canTransition(from: TurnPhase, to: TurnPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/** Throw on illegal transition — callers must surface this as a hard failure. */
export function assertTransition(from: TurnPhase, to: TurnPhase): void {
  if (!canTransition(from, to)) throw new IllegalPhaseTransitionError(from, to);
}

/** Turn termination reasons (design doc §4.3). */
export type TurnEndReason =
  | "goal_completed"
  | "max_iterations_reached"
  | "needs_user_decision"
  | "guardrail_rejected"
  | "user_interrupted"
  | "error";
