/**
 * OpenAIResponsesAdapter — POST {base}/v1/responses (SSE streaming).
 * The newer OpenAI surface: `instructions` replaces the system message, history is
 * a flat `input` item list, tool calls ride as function_call/function_call_output
 * items keyed by call_id, and deltas arrive as response.output_text.delta /
 * response.function_call_arguments.delta events.
 */
import type { ChatOptions, ProviderAdapter, ProviderCapabilities } from "./types.js";
import { DEFAULT_CAPABILITIES } from "./types.js";
import { CancelledError, cancelReasonOf } from "./cancelled.js";
import type { ChatResult, RunnerMessage, RunnerToolCall } from "./runner.js";
import { consumeSse, ProviderResponseError, requireStream } from "./sse.js";
import { pairMessages } from "./anthropic.js";
import { normalizeBaseUrl } from "./openai.js";

export interface ResponsesAdapterConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  capabilities?: ProviderCapabilities;
  signal?: AbortSignal;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  id?: string;
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  arguments?: string;
  response?: {
    error?: { message?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number };
    output?: ResponsesInputItem[];
  };
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly root: string;

  constructor(private readonly config: ResponsesAdapterConfig) {
    this.name = config.name ?? "openai-responses";
    this.capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
    this.root = normalizeBaseUrl(config.baseUrl);
  }

  async chat(messages: RunnerMessage[], tools: unknown[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const url = `${this.root}/v1/responses`;
    const signal = opts.signal ?? this.config.signal;
    if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));

    const { system, messages: turns } = pairMessages(messages);
    const input: ResponsesInputItem[] = [];
    for (const turn of turns) {
      if (turn.role === "assistant") {
        if (turn.text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] });
        for (const use of turn.toolUses ?? []) {
          input.push({ type: "function_call", call_id: use.id, name: use.name, arguments: JSON.stringify(use.arguments ?? {}) });
        }
        continue;
      }
      if (turn.text) {
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] });
      }
      for (const result of turn.toolResults ?? []) {
        input.push({ type: "function_call_output", call_id: result.id, output: result.content });
      }
    }

    const body = {
      model: this.config.model,
      stream: true,
      ...(system ? { instructions: system } : {}),
      input,
      ...(tools.length
        ? {
            tools: tools.map((tool) => {
              // Registry native shape {type:"function", function:{...}} -> Responses flat shape.
              const fn =
                (tool as { function?: { name: string; description: string; parameters: unknown } }).function ??
                (tool as { name: string; description: string; parameters: unknown });
              return {
                type: "function",
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters ?? { type: "object", properties: {} },
                strict: false,
              };
            }),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));
      throw new ProviderResponseError(
        `Cannot reach ${this.name} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const stream = await requireStream(res, url, this.name);

    const contentParts: string[] = [];
    // Function calls keyed by output_index: identity arrives via output_item.added,
    // arguments stream in via response.function_call_arguments.delta.
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    let promptTokens = 0;
    let responseTokens = 0;
    let failed: string | undefined;

    const handleEvent = (payload: string): void => {
      if (!payload) return;
      let event: ResponsesEvent;
      try {
        event = JSON.parse(payload) as ResponsesEvent;
      } catch {
        throw new ProviderResponseError(`${this.name} sent a malformed SSE chunk: ${payload.slice(0, 200)}`);
      }
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) {
            contentParts.push(event.delta);
            opts.onDelta?.(event.delta);
          }
          break;
        case "response.output_item.added":
          if (event.item?.type === "function_call") {
            calls.set(event.output_index ?? calls.size, {
              id: event.item.call_id,
              name: event.item.name ?? "",
              args: event.item.arguments ?? "",
            });
          }
          break;
        case "response.function_call_arguments.delta": {
          const call = calls.get(event.output_index ?? -1);
          if (call && event.delta) call.args += event.delta;
          break;
        }
        case "response.function_call_arguments.done": {
          const call = calls.get(event.output_index ?? -1);
          if (call && typeof event.arguments === "string") call.args = event.arguments;
          break;
        }
        case "response.completed":
          promptTokens = event.response?.usage?.input_tokens ?? promptTokens;
          responseTokens = event.response?.usage?.output_tokens ?? responseTokens;
          if (event.response?.error) failed = event.response.error.message ?? "response.failed";
          break;
        case "response.failed":
          failed = event.response?.error?.message ?? "response.failed";
          break;
        default:
          break; // response.created / response.in_progress / *.done noise
      }
    };

    await consumeSse(stream, signal, this.name, handleEvent);
    if (failed) throw new ProviderResponseError(`${this.name} error: ${failed}`);

    const toolCalls: RunnerToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call], seq) => {
        const name = call.name.trim();
        if (!name) throw new ProviderResponseError(`${this.name} streamed a function_call with no name`);
        let args: unknown = {};
        if (call.args.trim()) {
          try {
            args = JSON.parse(call.args);
          } catch (err) {
            throw new ProviderResponseError(
              `${this.name} function_call "${name}" arguments are not valid JSON: ${call.args.slice(0, 300)}`,
            );
          }
        }
        return { id: call.id ?? `call_${seq}_${index}`, name, arguments: args };
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
