/**
 * Provider adapter contract (design doc §15.1) — every backend (Ollama native,
 * OpenAI-compatible cloud, vLLM, LM Studio …) speaks RunnerMessage in and
 * ChatResult out, so the runtime never learns which vendor is behind it.
 *
 * Capabilities are declared in config.yaml (`providers[].capabilities`) and are
 * authoritative: the scheduler degrades based on them instead of guessing.
 */
import type { ChatResult, RunnerMessage } from "./runner.js";

/** config `capabilities` (snake_case) mapped to camelCase. */
export interface ProviderCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ChatOptions {
  /** Assistant text deltas as they arrive (streaming display). */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  /** Provider entry name from config (`ollama-local`, `openai-cloud` …). */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  chat(messages: RunnerMessage[], tools: unknown[], opts?: ChatOptions): Promise<ChatResult>;
}

/**
 * ChatResult plus degradation markers. The registry sets `degradedMode` when it
 * had to strip tools because the model cannot do function calling (§15.1).
 */
export interface AdapterChatResult extends ChatResult {
  degradedMode?: boolean;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  streaming: true,
  structuredOutput: false,
  vision: false,
  contextWindow: 32768,
  maxOutputTokens: 8192,
};
