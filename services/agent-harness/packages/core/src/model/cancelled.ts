/**
 * Cooperative turn cancellation (design doc §17.4).
 *
 * One error type is shared by the model adapters, tool execution and the runtime so that an
 * aborted stream/child process is never mistaken for a provider failure or a tool error: the
 * runtime unwinds it into `cancelling -> completing` and a `user_interrupted` summary instead.
 */
export class CancelledError extends Error {
  constructor(public readonly reason: string = "user") {
    super(`Cancelled: ${reason}`);
    this.name = "CancelledError";
  }
}

/** `fetch` rejects with a DOMException named "AbortError"; both shapes mean "user cancelled". */
export function isCancelledError(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** The reason carried by an aborted signal, defaulting to "user". */
export function cancelReasonOf(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof CancelledError) return reason.reason;
  return "user";
}
