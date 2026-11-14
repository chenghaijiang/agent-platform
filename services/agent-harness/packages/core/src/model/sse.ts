/**
 * Shared SSE reader for streaming model adapters (design doc §15.1).
 * All three wire formats (chat-completions / anthropic-messages / responses) ship
 * newline-delimited `data:` frames; the event-shaped differences live in each
 * adapter's payload handler, the transport loop lives here once.
 */
import { CancelledError, cancelReasonOf } from "./cancelled.js";

export class ProviderResponseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

/**
 * Read an SSE body to completion, invoking `onData` with each `data:` payload
 * (multiple data lines of one event are joined with "\n", as the SSE spec says).
 * Aborts throw CancelledError immediately; a malformed frame is a protocol error.
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  name: string,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];

  const flush = (final: boolean): void => {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (pending.length) {
          onData(pending.join("\n").trim());
          pending = [];
        }
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) pending.push(line.slice(5).replace(/^ /, ""));
      // `event:` / `id:` / `retry:` — every relevant protocol repeats the event
      // type inside the JSON payload, so the data frame alone is authoritative.
    }
    if (final && pending.length) {
      onData(pending.join("\n").trim());
      pending = [];
    }
  };

  for (;;) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw new CancelledError(cancelReasonOf(signal));
    }
    let chunkRead: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunkRead = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));
      throw err;
    }
    const { done, value } = chunkRead;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  buffer += decoder.decode();
  flush(true);
  void name;
}

/** Shared guard: non-2xx or empty body is a protocol failure with a body preview. */
export async function requireStream(res: Response, url: string, name: string): Promise<ReadableStream<Uint8Array>> {
  if (!res.ok || !res.body) {
    const preview = await res.text().catch(() => "");
    throw new ProviderResponseError(`${name} ${url} failed (${res.status}): ${preview.slice(0, 500)}`, res.status);
  }
  return res.body;
}
