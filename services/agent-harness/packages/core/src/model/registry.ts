/**
 * ProviderRegistry (design doc §15) — one place that turns config.yaml
 * `model.providers[]` into ProviderAdapters, resolves a model name to the right
 * adapter, health-checks backends, and degrades gracefully:
 *
 *  - model unknown                -> `model.fallback` adapter, `degraded: true`
 *  - backend unreachable          -> `model.fallback` adapter, `degraded: true`
 *  - `capabilities.tool_calling=false` -> tools stripped before chat(),
 *    result flagged `degradedMode: true` (caller shows「降级模式」, §15.1)
 */
import type { HarnessConfig } from "../config/schema.js";
import { AnthropicMessagesAdapter } from "./anthropic.js";
import { OpenAICompatibleAdapter, normalizeBaseUrl } from "./openai.js";
import { OpenAIResponsesAdapter } from "./responses.js";
import { ModelConnectionError, OllamaRunner, type ChatResult, type RunnerMessage } from "./runner.js";
import { DEFAULT_CAPABILITIES, type AdapterChatResult, type ChatOptions, type ProviderAdapter, type ProviderCapabilities } from "./types.js";

type ProviderConfig = HarnessConfig["model"]["providers"][number];

/** Health probe budget (per provider, both probes share the deadline). Cross-border
 *  round trips routinely exceed 2s, so this is generous; local Ollama answers in ms. */
const HEALTH_TIMEOUT_MS = 5000;

/** Probe outcome with a human-readable failure reason — powers actionable switch errors. */
export interface ProbeResult {
  ok: boolean;
  /** HTTP status of the last probe when the host answered. */
  status?: number;
  /** Failure detail when ok=false (auth / timeout / unreachable). */
  detail?: string;
}

/** A user-added online model (web UI form): OpenAI-compatible endpoint + key. */
export type ApiFormat = "chat-completions" | "anthropic-messages" | "responses";

export const API_FORMATS: readonly ApiFormat[] = ["chat-completions", "anthropic-messages", "responses"];

export interface CustomModelInput {
  /** Provider label; defaults to the model id. Identifies the entry for removal. */
  name?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Context window in tokens; defaults to 32768. */
  contextWindow?: number;
  /** Wire protocol; defaults to chat-completions. */
  apiFormat?: ApiFormat;
}

export interface ResolvedModel {
  adapter: ProviderAdapter;
  capabilities: ProviderCapabilities;
  model: string;
  provider: string;
  baseUrl: string;
  /** True when the registry fell back to `model.fallback`. */
  degraded: boolean;
}

interface ProviderEntry {
  name: string;
  type: ProviderConfig["type"];
  root: string;
  apiKey?: string;
  models: string[];
  capabilities: ProviderCapabilities;
  /** Wire protocol for openai-compatible entries; chat-completions unless declared. */
  apiFormat: ApiFormat;
  /** True for models added at runtime (web UI) rather than config.yaml. */
  custom?: boolean;
}

export class ProviderRegistry {
  private readonly entries: ProviderEntry[] = [];
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(private readonly config: HarnessConfig) {
    for (const provider of config.model.providers) {
      this.entries.push({
        name: provider.name,
        type: provider.type,
        root: normalizeBaseUrl(provider.base_url),
        apiKey: provider.api_key,
        models: provider.models,
        apiFormat: "chat-completions",
        capabilities: toCapabilities(provider.capabilities),
      });
    }
  }

  /** Model name -> adapter, falling back to `model.fallback` when unmatched. */
  resolve(modelName: string): ResolvedModel {
    const hit = this.match(modelName);
    if (hit) return { ...hit, degraded: false };

    const fallback = this.config.model.fallback ? this.match(this.config.model.fallback) : undefined;
    if (fallback) return { ...fallback, degraded: true };

    const known = this.entries.flatMap((e) => e.models).join(", ") || "(none configured)";
    throw new Error(`No provider declares model "${modelName}". Configured models: ${known}`);
  }

  /**
   * resolve() + reachability probe: an unreachable primary backend falls back to
   * `model.fallback` (degraded). Throws ModelConnectionError when nothing usable.
   * `noFallback` opts out of the silent degrade — a custom online model that fails its
   * probe should surface the error, not pretend to be the local fallback.
   */
  async resolveHealthy(modelName: string, opts: { noFallback?: boolean } = {}): Promise<ResolvedModel> {
    const target = this.resolve(modelName);
    const probe = await this.probe(target.baseUrl, this.apiKeyOf(target.provider));
    if (probe.ok) return target;
    if (target.degraded || opts.noFallback) throw new ModelConnectionError(target.baseUrl, undefined, probe.detail);

    const fallback = this.config.model.fallback ? this.match(this.config.model.fallback) : undefined;
    if (fallback && fallback.model !== target.model) return { ...fallback, degraded: true };
    throw new ModelConnectionError(target.baseUrl, undefined, probe.detail);
  }

  /** Whether a model id belongs to a runtime-added custom provider. */
  isCustomModel(modelName: string): boolean {
    return this.entries.some((entry) => entry.custom === true && entry.models.includes(modelName));
  }

  /**
   * GET {root}/api/tags (Ollama) or {root}/v1/models (OpenAI-compatible, with auth) and
   * classify WHY it failed — a bare boolean makes every switch failure look identical,
   * so users can't tell a bad API key from an unreachable host.
   * A host that answers 404/405 is alive (probe endpoint merely missing) — treated ok.
   */
  async probe(baseUrl: string, apiKey?: string): Promise<ProbeResult> {
    const root = normalizeBaseUrl(baseUrl);
    const signal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
    // Online gateways 401 unauthenticated probes. Anthropic reads x-api-key,
    // OpenAI-style reads Authorization — sending both is harmless everywhere else.
    const headers = apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : undefined;
    let last: ProbeResult = { ok: false, detail: "探测失败" };
    for (const path of ["/api/tags", "/v1/models"]) {
      let res: Response;
      try {
        res = await fetch(`${root}${path}`, { signal, headers });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        last = {
          ok: false,
          detail: timedOut
            ? `网络超时（${HEALTH_TIMEOUT_MS}ms）——检查 Base URL、代理与防火墙`
            : `网络不可达：${err instanceof Error ? err.message : String(err)}`,
        };
        continue;
      }
      if (res.ok) return { ok: true, status: res.status };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, detail: `HTTP ${res.status} — 鉴权失败，请检查 API Key` };
      }
      if (res.status === 404 || res.status === 405) {
        // Host answered — probe endpoint just doesn't exist there. Chat may still work.
        return { ok: true, status: res.status };
      }
      last = { ok: false, status: res.status, detail: `HTTP ${res.status}（服务异常）` };
    }
    return last;
  }

  /**
   * Model discovery for the UI picker (design doc §15.4): probe each ollama provider's
   * `/api/tags` for the models actually installed locally, plus everything declared in
   * config (OpenAI-compatible providers only report their declared list). Models present
   * on the backend but absent from config are registered dynamically so `resolve()` works.
   */
  async listAvailable(): Promise<Array<{ provider: string; model: string; declared: boolean; custom: boolean; apiFormat: ApiFormat; baseUrl?: string; contextWindow?: number }>> {
    const out = new Map<string, { provider: string; model: string; declared: boolean; custom: boolean; apiFormat: ApiFormat; baseUrl?: string; contextWindow?: number }>();
    for (const entry of this.entries) {
      // baseUrl/contextWindow ride along for custom entries so the edit form can
      // prefill; apiKey never leaves the server.
      const extra = entry.custom === true ? { baseUrl: entry.root, contextWindow: entry.capabilities.contextWindow } : {};
      for (const model of entry.models) {
        out.set(model, { provider: entry.name, model, declared: true, custom: entry.custom === true, apiFormat: entry.apiFormat, ...extra });
      }
      if (entry.type !== "ollama") continue;

      try {
        const res = await fetch(`${entry.root}/api/tags`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (!res.ok) continue;
        const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
        for (const item of body.models ?? []) {
          const name = item.name ?? item.model;
          if (!name || out.has(name)) continue;
          out.set(name, { provider: entry.name, model: name, declared: false, custom: entry.custom === true, apiFormat: entry.apiFormat });
          // Register dynamically so resolve()/resolveHealthy() accept it.
          entry.models.push(name);
        }
      } catch {
        // Backend offline — config-declared models still appear (resolveHealthy will degrade).
      }
    }
    return [...out.values()];
  }

  /**
   * Register a runtime-added OpenAI-compatible model (web UI「添加线上模型」). The entry
   * behaves exactly like a config-declared provider: resolve()/resolveHealthy()/switchModel
   * all accept it. Returns the effective provider label (name ?? model id).
   */
  registerCustom(input: CustomModelInput): string {
    const model = input.model.trim();
    if (!model) throw new Error("自定义模型需要非空的模型 ID");
    const name = (input.name ?? "").trim() || model;
    if (this.entries.some((entry) => entry.name === name)) {
      throw new Error(`供应商名称 "${name}" 已存在，请换一个名称`);
    }
    // match() returns the first declaring entry, so a duplicate model id would shadow it.
    if (this.match(model)) {
      throw new Error(`模型 "${model}" 已存在于供应商列表中`);
    }
    const contextWindow = Math.min(Math.max(Math.trunc(input.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow), 2048), 1_000_000);
    const apiFormat = input.apiFormat ?? "chat-completions";
    if (!API_FORMATS.includes(apiFormat)) {
      throw new Error(`未知的 API 格式 "${input.apiFormat}"，支持: ${API_FORMATS.join(", ")}`);
    }
    this.entries.push({
      name,
      type: "openai-compatible",
      root: normalizeBaseUrl(input.baseUrl),
      apiKey: input.apiKey?.trim() || undefined,
      models: [model],
      apiFormat,
      custom: true,
      capabilities: { ...DEFAULT_CAPABILITIES, contextWindow, maxOutputTokens: Math.min(8192, Math.ceil(contextWindow / 2)) },
    });
    return name;
  }

  /** Remove a custom provider by label; no-op for config-declared entries. */
  removeCustom(name: string): boolean {
    const index = this.entries.findIndex((entry) => entry.name === name && entry.custom === true);
    const entry = this.entries[index];
    if (index < 0 || !entry) return false;
    for (const model of entry.models) this.adapters.delete(`${name}::${model}`);
    this.entries.splice(index, 1);
    return true;
  }

  /**
   * Edit a runtime-added custom provider in place (web UI ✎). Empty apiKey keeps the
   * stored one (the UI never echoes secrets back, so blank means "unchanged"). Returns
   * the effective provider label, which changes if the display name was edited.
   */
  updateCustom(provider: string, input: CustomModelInput): string {
    const index = this.entries.findIndex((entry) => entry.name === provider && entry.custom === true);
    const entry = this.entries[index];
    if (index < 0 || !entry) throw new Error(`线上模型 "${provider}" 不存在或不是可编辑的自定义模型`);

    const model = input.model.trim();
    if (!model) throw new Error("自定义模型需要非空的模型 ID");
    const newName = (input.name ?? "").trim() || model;
    // Conflict checks exclude the edited entry itself (its old name/model are released).
    if (this.entries.some((e, i) => i !== index && e.name === newName)) {
      throw new Error(`供应商名称 "${newName}" 已存在，请换一个名称`);
    }
    if (this.entries.some((e, i) => i !== index && e.models.includes(model))) {
      throw new Error(`模型 "${model}" 已存在于供应商列表中`);
    }
    const apiFormat = input.apiFormat ?? entry.apiFormat;
    if (!API_FORMATS.includes(apiFormat)) {
      throw new Error(`未知的 API 格式 "${input.apiFormat}"，支持: ${API_FORMATS.join(", ")}`);
    }
    const contextWindow = Math.min(Math.max(Math.trunc(input.contextWindow ?? entry.capabilities.contextWindow), 2048), 1_000_000);

    // Cached adapters hold the old root/key/model — drop them so the next chat rebuilds.
    for (const m of entry.models) this.adapters.delete(`${entry.name}::${m}`);
    entry.name = newName;
    entry.root = normalizeBaseUrl(input.baseUrl);
    const key = input.apiKey?.trim();
    if (key) entry.apiKey = key;
    entry.models = [model];
    entry.apiFormat = apiFormat;
    entry.capabilities = { ...DEFAULT_CAPABILITIES, contextWindow, maxOutputTokens: Math.min(8192, Math.ceil(contextWindow / 2)) };
    return newName;
  }

  private apiKeyOf(providerName: string): string | undefined {
    return this.entries.find((entry) => entry.name === providerName)?.apiKey;
  }

  private match(modelName: string): ResolvedModel | undefined {
    for (const entry of this.entries) {
      if (!entry.models.includes(modelName)) continue;
      return {
        adapter: this.adapterFor(entry, modelName),
        capabilities: entry.capabilities,
        model: modelName,
        provider: entry.name,
        baseUrl: entry.root,
        degraded: false,
      };
    }
    return undefined;
  }

  private adapterFor(entry: ProviderEntry, model: string): ProviderAdapter {
    const key = `${entry.name}::${model}`;
    const cached = this.adapters.get(key);
    if (cached) return cached;

    const shared = { name: entry.name, baseUrl: entry.root, apiKey: entry.apiKey, model, capabilities: entry.capabilities };
    const adapter: ProviderAdapter =
      entry.type === "ollama"
        ? new OllamaRunner(entry.root, model, entry.capabilities.contextWindow, {
            name: entry.name,
            capabilities: entry.capabilities,
          })
        : entry.apiFormat === "anthropic-messages"
          ? new AnthropicMessagesAdapter(shared)
          : entry.apiFormat === "responses"
            ? new OpenAIResponsesAdapter(shared)
            : new OpenAICompatibleAdapter(shared);

    const wrapped = withCapabilityFallback(adapter);
    this.adapters.set(key, wrapped);
    return wrapped;
  }
}

/** snake_case config -> camelCase capabilities. */
function toCapabilities(caps: ProviderConfig["capabilities"]): ProviderCapabilities {
  return {
    toolCalling: caps.tool_calling,
    streaming: caps.streaming,
    structuredOutput: caps.structured_output,
    vision: caps.vision,
    contextWindow: caps.context_window,
    maxOutputTokens: caps.max_output_tokens,
  };
}

/**
 * Models without function calling get a pure-chat adapter: tools are dropped
 * (embedding the tool protocol in the system prompt is the caller's job) and the
 * result is marked `degradedMode` so the UI can say「降级模式」.
 */
function withCapabilityFallback(adapter: ProviderAdapter): ProviderAdapter {
  if (adapter.capabilities.toolCalling) return adapter;

  return {
    name: adapter.name,
    capabilities: adapter.capabilities,
    async chat(messages: RunnerMessage[], tools: unknown[], opts?: ChatOptions): Promise<ChatResult> {
      const result = await adapter.chat(messages, [], opts);
      const degraded: AdapterChatResult = { ...result, degradedMode: true };
      return degraded;
    },
  };
}
