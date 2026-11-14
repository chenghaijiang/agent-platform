/**
 * AnthropicMessagesAdapter — POST {base}/v1/messages (SSE streaming).
 * Wire differences vs OpenAI chat-completions: `system` is a top-level parameter
 * (not a message role), auth is `x-api-key` + `anthropic-version`, tools take
 * `input_schema`, and tool calls/results travel as content blocks (tool_use /
 * tool_result) instead of message fields.
 */
import type { ChatOptions, ProviderAdapter, ProviderCapabilities } from "./types.js";
import { DEFAULT_CAPABILITIES } from "./types.js";
import { CancelledError, cancelReasonOf } from "./cancelled.js";
import type { ChatResult, RunnerMessage, RunnerToolCall } from "./runner.js";
import { consumeSse, ProviderResponseError, requireStream } from "./sse.js";
import { normalizeBaseUrl } from "./openai.js";

export interface AnthropicAdapterConfig {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  capabilities?: ProviderCapabilities;
  signal?: AbortSignal;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicEvent {
  type?: string;
  error?: { type?: string; message?: string };
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly root: string;

  constructor(private readonly config: AnthropicAdapterConfig) {
    this.name = config.name ?? "anthropic";
    this.capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
    this.root = normalizeBaseUrl(config.baseUrl);
  }

  async chat(messages: RunnerMessage[], tools: unknown[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const url = `${this.root}/v1/messages`;
    const signal = opts.signal ?? this.config.signal;
    if (signal?.aborted) throw new CancelledError(cancelReasonOf(signal));

    const { system, messages: turns } = pairMessages(messages);
    const body = {
      model: this.config.model,
      max_tokens: this.capabilities.maxOutputTokens || 8192,
      stream: true,
      ...(system ? { system } : {}),
      messages: turns.map(toAnthropicMessage),
      ...(tools.length
        ? {
            tools: tools.map((tool) => {
              // The registry hands over OpenAI shape; unwrap to Anthropic's flat tool.
              const fn = (tool as { function?: { name: string; description: string; parameters: unknown } }).function ?? (tool as Record<string, never>);
              return {
                name: (fn as { name: string }).name,
                description: (fn as { description: string }).description,
                input_schema: (fn as { parameters: unknown }).parameters ?? { type: "object", properties: {} },
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
          "anthropic-version": "2023-06-01",
          ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
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
    // tool_use blocks indexed by Anthropic's block index; args stream in via input_json_delta.
    const blocks = new Map<number, { id?: string; name: string; args: string }>();
    let promptTokens = 0;
    let responseTokens = 0;
    let failed: string | undefined;

    const handleEvent = (payload: string): void => {
      if (!payload) return;
      let event: AnthropicEvent;
      try {
        event = JSON.parse(payload) as AnthropicEvent;
      } catch {
        throw new ProviderResponseError(`${this.name} sent a malformed SSE chunk: ${payload.slice(0, 200)}`);
      }
      if (event.error) {
        failed = event.error.message ?? JSON.stringify(event.error);
        return;
      }
      switch (event.type) {
        case "message_start":
          promptTokens = event.message?.usage?.input_tokens ?? promptTokens;
          break;
        case "content_block_start":
          if (event.content_block?.type === "tool_use") {
            blocks.set(event.index ?? blocks.size, {
              id: event.content_block.id,
              name: event.content_block.name ?? "",
              args: "",
            });
          }
          break;
        case "content_block_delta": {
          if (event.delta?.type === "text_delta" && event.delta.text) {
            contentParts.push(event.delta.text);
            opts.onDelta?.(event.delta.text);
          } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
            const block = blocks.get(event.index ?? -1);
            if (block) block.args += event.delta.partial_json;
          }
          break;
        }
        case "message_delta":
          responseTokens = event.usage?.output_tokens ?? responseTokens;
          break;
        case "message_stop":
          break;
        default:
          break; // ping / content_block_stop / unknown future events
      }
    };

    await consumeSse(stream, signal, this.name, handleEvent);
    if (failed) throw new ProviderResponseError(`${this.name} error: ${failed}`);

    const toolCalls: RunnerToolCall[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, block], seq) => {
        const name = block.name.trim();
        if (!name) throw new ProviderResponseError(`${this.name} streamed a tool_use block with no name`);
        let args: unknown = {};
        if (block.args.trim()) {
          try {
            args = JSON.parse(block.args);
          } catch (err) {
            throw new ProviderResponseError(
              `${this.name} tool_use "${name}" arguments are not valid JSON: ${block.args.slice(0, 300)}`,
            );
          }
        }
        return { id: block.id ?? `call_${seq}_${index}`, name, arguments: args };
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

// ---------------------------------------------------------------------------------------------
// message pairing shared by the Anthropic and Responses adapters
// ---------------------------------------------------------------------------------------------

/** Assistant tool call with a minted wire id (RunnerMessage carries no ids). */
export interface PairedToolUse {
  id: string;
  name: string;
  arguments: unknown;
}

export interface PairedMessage {
  role: "user" | "assistant";
  text: string;
  /** assistant only: tool calls issued in this turn. */
  toolUses?: PairedToolUse[];
  /** user only: tool results, paired by name with the preceding assistant toolUses. */
  toolResults?: { id: string; content: string }[];
}

/**
 * RunnerMessage -> ordered user/assistant turns with minted tool-call ids. Mirrors
 * toOpenAIMessages' pairing: ids are minted in call order and handed to the following
 * tool results (matched by tool name, in submission order). Consecutive tool results
 * merge into a single user turn (Anthropic requires tool_result inside user messages).
 */
export function pairMessages(messages: RunnerMessage[]): { system: string; messages: PairedMessage[] } {
  const systemParts: string[] = [];
  const out: PairedMessage[] = [];
  const pendingIds = new Map<string, string[]>();
  let seq = 0;

  const attach = (message: PairedMessage): void => {
    const last = out[out.length - 1];
    // Consecutive user messages merge — keeps tool_result blocks grouped with any
    // preceding user text instead of emitting standalone user turns.
    if (last && last.role === "user" && message.role === "user") {
      last.text = [last.text, message.text].filter(Boolean).join("\n\n");
      last.toolResults = [...(last.toolResults ?? []), ...(message.toolResults ?? [])];
      return;
    }
    out.push(message);
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolUses = message.tool_calls.map((call) => {
        const id = `call_${seq++}`;
        const queue = pendingIds.get(call.function.name) ?? [];
        queue.push(id);
        pendingIds.set(call.function.name, queue);
        return { id, name: call.function.name, arguments: call.function.arguments ?? {} };
      });
      attach({ role: "assistant", text: message.content ?? "", toolUses });
      continue;
    }
    if (message.role === "tool") {
      const queue = message.tool_name ? pendingIds.get(message.tool_name) : undefined;
      const id = queue?.shift() ?? message.tool_name ?? "";
      attach({ role: "user", text: "", toolResults: [{ id, content: message.content ?? "" }] });
      continue;
    }
    attach({ role: message.role === "assistant" ? "assistant" : "user", text: message.content ?? "" });
  }

  return { system: systemParts.join("\n\n"), messages: out };
}

function toAnthropicMessage(turn: PairedMessage): { role: string; content: string | AnthropicBlock[] } {
  if (turn.role === "assistant") {
    const blocks: AnthropicBlock[] = [];
    if (turn.text) blocks.push({ type: "text", text: turn.text });
    for (const use of turn.toolUses ?? []) {
      blocks.push({ type: "tool_use", id: use.id, name: use.name, input: use.arguments });
    }
    return { role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] };
  }
  const results = turn.toolResults ?? [];
  if (results.length) {
    const blocks: AnthropicBlock[] = results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.id,
      content: result.content,
    }));
    if (turn.text) blocks.push({ type: "text", text: turn.text });
    return { role: "user", content: blocks };
  }
  return { role: "user", content: turn.text };
}
