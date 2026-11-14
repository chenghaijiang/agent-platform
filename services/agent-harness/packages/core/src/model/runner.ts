/**
 * Model Runner — Ollama native /api/chat (route decision: Ollama-first).
 * Native endpoint (vs /v1 OpenAI-compat) because it supports `options.num_ctx`
 * explicitly — the 4K/8K default context trap — plus native tool calling.
 *
 * Implements ProviderAdapter (§15.1) so the registry can treat it like any
 * other backend; the runner itself stays Ollama-specific.
 */
import {
  DEFAULT_CAPABILITIES,
  type ChatOptions,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "./types.js";
import { CancelledError, cancelReasonOf } from "./cancelled.js";

export interface RunnerToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface RunnerMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

export interface ChatResult {
  content: string;
  toolCalls: RunnerToolCall[];
  totalDurationMs: number;
  promptTokens: number;
  responseTokens: number;
}

export class ModelConnectionError extends Error {
  constructor(
    url: string,
    cause: unknown,
    /** Probe-classified reason (auth/timeout/unreachable); local-Ollama keeps the classic hint. */
    detail?: string,
  ) {
    super(
      detail
        ? `无法连接模型服务 ${url}：${detail}`
        : `Cannot reach model provider at ${url}. Is Ollama running? Try: brew services start ollama (or \`ollama serve\`)`,
    );
    this.name = "ModelConnectionError";
    this.cause = cause;
  }
}

export interface OllamaRunnerOptions {
  /** Provider entry name from config (`ollama-local`). */
  name?: string;
  capabilities?: ProviderCapabilities;
  /**
   * Default abort signal for every chat() call; a per-call `ChatOptions.signal` overrides it.
   * The runtime normally owns the per-turn controller and passes the signal per call.
   */
  signal?: AbortSignal;
}

export class OllamaRunner implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly defaultSignal: AbortSignal | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    /** Ollama defaults to 4K/8K context — must be raised explicitly (§15.3). */
    private readonly numCtx: number = 32768,
    opts: OllamaRunnerOptions = {},
  ) {
    this.name = opts.name ?? "ollama";
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.defaultSignal = opts.signal;
  }

  /** Streaming chat; onDelta receives assistant text deltas as they arrive. */
  async chat(messages: RunnerMessage[], tools: unknown[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const signal = opts.signal ?? this.defaultSignal;
    if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.length ? tools : undefined,
          stream: true,
          options: { num_ctx: this.numCtx },
        }),
        signal,
      });
    } catch (err) {
      // An aborted turn is not a broken provider — surface it as cancellation, not a connect error.
      if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));
      throw new ModelConnectionError(this.baseUrl, err);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const contentParts: string[] = [];
    const toolCalls: RunnerToolCall[] = [];
    let promptTokens = 0;
    let responseTokens = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      // Abort may arrive between chunks: stop parsing immediately, don't finish the stream.
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
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue; // tolerate partial/garbage lines
        }
        if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
        const msg = chunk.message ?? {};
        // Thinking models: `thinking` field stays out of content by design.
        if (typeof msg.content === "string" && msg.content) {
          contentParts.push(msg.content);
          opts.onDelta?.(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            toolCalls.push({
              id: `call_${toolCalls.length}`,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? {},
            });
          }
        }
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? promptTokens;
          responseTokens = chunk.eval_count ?? responseTokens;
        }
      }
    }

    return {
      content: contentParts.join(""),
      toolCalls,
      totalDurationMs: Date.now() - started,
      promptTokens,
      responseTokens,
    };
  }
}
