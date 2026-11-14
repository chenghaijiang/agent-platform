/**
 * Token accounting for the context window (design doc §4.2).
 *
 * No tokenizer is bundled: the harness needs a stable, provider-agnostic estimate to decide
 * "are we close to the limit?", and chars/4 is accurate enough for that decision on both
 * BPE-based local models and cloud providers. Everything downstream (micro/auto compact,
 * rapid-refill guard) is expressed in these units.
 */
import type { RunnerMessage } from "../model/runner.js";

/** Roughly 4 characters per token — deliberately conservative (rounds up). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Per-message structural overhead (role marker, separators) charged on top of the content. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Tokens for a single message: content + serialized tool calls + structural overhead. */
export function messageTokens(message: RunnerMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  if (message.content) tokens += estimateTokens(message.content);
  if (message.tool_calls && message.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(message.tool_calls));
  }
  return tokens;
}

/** Tokens for a whole conversation slice. */
export function messagesTokens(messages: readonly RunnerMessage[]): number {
  let total = 0;
  for (const message of messages) total += messageTokens(message);
  return total;
}
