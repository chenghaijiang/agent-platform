/**
 * OpenAICompatibleAdapter — POST {base}/v1/chat/completions with SSE streaming.
 * Covers any OpenAI-compatible surface: OpenAI, Ollama's /v1 shim, vLLM,
 * LM Studio, OpenRouter. Non-Ollama providers never get `num_ctx`; their
 * context window comes from `capabilities.context_window` instead.
 *
 * Streaming tool calls arrive as *fragments*: `delta.tool_calls[i].function
 * .arguments` is a slice of a JSON string. Fragments are aggregated per
 * `index`, and the JSON is parsed once at the end — a parse failure raises
 * ToolCallParseError (structured, never silently swallowed).
 */
import type { ChatResult, RunnerMessage, RunnerToolCall } from "./runner.js";
import { CancelledError, cancelReasonOf } from "./cancelled.js";
import { DEFAULT_CAPABILITIES, type ChatOptions, type ProviderAdapter, type ProviderCapabilities } from "./types.js";

export interface OpenAIAdapterConfig {
  /** Provider entry name from config; used in error messages. */
  name?: string;
  /** May end with `/v1` (as config.yaml does) or not — normalized internally. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  capabilities?: ProviderCapabilities;
  /** Default abort signal for every chat() call; a per-call `ChatOptions.signal` overrides it. */
  signal?: AbortSignal;
}

/** Protocol violation (non-2xx, malformed SSE frame, tool call without a name). */
export class ProviderResponseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

/** Streamed tool-call arguments did not form valid JSON. Carries the raw slices. */
export class ToolCallParseError extends Error {
  readonly tool: string;
  readonly index: number;
  readonly rawArguments: string;

  constructor(tool: string, index: number, rawArguments: string, cause: unknown) {
    super(
      `Tool call arguments for "${tool}" (tool_calls[${index}]) are not valid JSON: ${rawArguments.slice(0, 300)}`,
      { cause },
    );
    this.name = "ToolCallParseError";
    this.tool = tool;
    this.index = index;
    this.rawArguments = rawArguments;
  }
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

/** `http://host:11434/v1` and `http://host:11434` both mean root `http://host:11434`. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly root: string;

  constructor(private readonly config: OpenAIAdapterConfig) {
    this.name = config.name ?? "openai-compatible";
    this.capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
    this.root = normalizeBaseUrl(config.baseUrl);
  }

  async chat(messages: RunnerMessage[], tools: unknown[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const url = `${this.root}/v1/chat/completions`;
    const signal = opts.signal ?? this.config.signal;
    if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: toOpenAIMessages(messages),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length ? { tools } : {}),
        }),
        signal,
      });
    } catch (err) {
      // An aborted turn is not a provider failure — never wrap it as ProviderResponseError.
      if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));
      throw new ProviderResponseError(
        `Cannot reach ${this.name} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderResponseError(
        `${this.name} /v1/chat/completions failed (${res.status}): ${body.slice(0, 500)}`,
        res.status,
      );
    }

    const contentParts: string[] = [];
    const fragments = new Map<number, { id?: string; name: string; args: string }>();
    let promptTokens = 0;
    let responseTokens = 0;
    let seenDone = false;

    const handleEvent = (payload: string): void => {
      if (!payload) return;
      if (payload === "[DONE]") {
        seenDone = true;
        return;
      }
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        throw new ProviderResponseError(`${this.name} sent a malformed SSE chunk: ${payload.slice(0, 200)}`);
      }
      if (chunk.error) {
        throw new ProviderResponseError(`${this.name} error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      }

      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        contentParts.push(delta.content);
        opts.onDelta?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Missing index => single/sequential stream: fall back to stream order.
          const index = typeof tc.index === "number" ? tc.index : fragments.size;
          let entry = fragments.get(index);
          if (!entry) {
            entry = { name: "", args: "" };
            fragments.set(index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
        }
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        responseTokens = chunk.usage.completion_tokens ?? responseTokens;
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingDataLines: string[] = [];

    const consumeLines = (final: boolean): void => {
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          // Blank line terminates an SSE event.
          if (pendingDataLines.length) {
            handleEvent(pendingDataLines.join("\n").trim());
            pendingDataLines = [];
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("data:")) {
          pendingDataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // `event:` / `id:` / `retry:` are irrelevant for chat completions.
      }
      if (final && pendingDataLines.length) {
        handleEvent(pendingDataLines.join("\n").trim());
        pendingDataLines = [];
      }
    };

    for (;;) {
      // Abort may arrive between chunks: stop parsing immediately, never drain to [DONE].
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
      consumeLines(false);
      if (seenDone) break;
    }
    buffer += decoder.decode();
    consumeLines(true);

    const toolCalls: RunnerToolCall[] = [...fragments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, entry]) => {
        const name = entry.name.trim();
        if (!name) {
          throw new ProviderResponseError(`${this.name} streamed a tool call at index ${index} with no function name`);
        }
        const raw = entry.args.trim();
        let args: unknown = {};
        if (raw) {
          try {
            args = JSON.parse(raw);
          } catch (err) {
            throw new ToolCallParseError(name, index, raw, err);
          }
        }
        return { id: entry.id ?? `call_${index}`, name, arguments: args };
      });

    return {
      content: contentParts.join(""),
      toolCalls,
      totalDurationMs: Date.now() - started,
      promptTokens,
      responseTokens,
    };
  }
}

/**
 * RunnerMessage -> OpenAI wire format. RunnerMessage carries no tool_call ids,
 * so ids are minted here and paired with the following tool messages by name
 * (the runtime appends tool results in call order).
 */
function toOpenAIMessages(messages: RunnerMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  const pendingIds = new Map<string, string[]>();
  let seq = 0;

  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls.map((call) => {
        const id = `call_${seq++}`;
        const queue = pendingIds.get(call.function.name) ?? [];
        queue.push(id);
        pendingIds.set(call.function.name, queue);
        return {
          id,
          type: "function" as const,
          function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) },
        };
      });
      out.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
      continue;
    }
    if (message.role === "tool") {
      const queue = message.tool_name ? pendingIds.get(message.tool_name) : undefined;
      const id = queue?.shift() ?? message.tool_name ?? "";
      out.push({ role: "tool", content: message.content ?? "", tool_call_id: id });
      continue;
    }
    out.push({ role: message.role, content: message.content ?? "" });
  }

  return out;
}
