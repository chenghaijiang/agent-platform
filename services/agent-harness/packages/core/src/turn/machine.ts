/** Runtime Turn state machine — wraps contracts' transition table with a current phase + history. */
import {
  TURN_PHASES,
  assertTransition,
  canTransition,
  type TurnEndReason,
  type TurnPhase,
} from "@harness/contracts";

export class TurnMachine {
  private _phase: TurnPhase = "processing_input";
  readonly history: { from: TurnPhase | null; to: TurnPhase; at: number }[] = [];
  readonly startedAt = Date.now();

  constructor(private readonly onTransition?: (from: TurnPhase | null, to: TurnPhase) => void) {
    this.history.push({ from: null, to: this._phase, at: this.startedAt });
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  to(next: TurnPhase): void {
    assertTransition(this._phase, next);
    const from = this._phase;
    this._phase = next;
    this.history.push({ from, to: next, at: Date.now() });
    this.onTransition?.(from, next);
  }

  canGo(next: TurnPhase): boolean {
    return canTransition(this._phase, next);
  }

  finish(reason: TurnEndReason): { reason: TurnEndReason; iterations: number; durationMs: number } {
    this.to("completing");
    return { reason, iterations: this.history.filter((h) => h.to === "awaiting_model").length, durationMs: Date.now() - this.startedAt };
  }

  static isValidPhase(p: string): p is TurnPhase {
    return (TURN_PHASES as readonly string[]).includes(p);
  }
}
