/**
 * Embedding provider — Ollama native /api/embeddings (design doc §5.1: local, zero API cost).
 *
 * Contract: batches run with limited concurrency (2 by default) and retry twice on
 * transport/5xx failures. "Ollama is offline" is a normal state, so every failure is a
 * structured EmbeddingError the caller can degrade on instead of an opaque crash.
 */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_EMBED_MODEL = "qwen3-embedding:0.6b";
/** qwen3-embedding:0.6b → 1024 dims; must match the Qdrant collection size. */
export const DEFAULT_EMBED_DIM = 1024;

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], opts?: { signal?: AbortSignal; concurrency?: number }): Promise<number[][]>;
}

export type EmbeddingErrorCode = "EMBED_UNAVAILABLE" | "EMBED_HTTP_ERROR" | "EMBED_BAD_RESPONSE";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly status?: number;

  constructor(code: EmbeddingErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "EmbeddingError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export interface OllamaEmbedderOptions {
  model?: string;
  dim?: number;
  /** Per-request timeout; local models can be slow on cold start. */
  timeoutMs?: number;
  concurrency?: number;
  /** Number of retries after the first attempt (spec: 2). */
  retries?: number;
  /** Base backoff; exponential per attempt, capped at 2s. */
  retryDelayMs?: number;
}

interface OllamaEmbeddingsResponse {
  embedding?: unknown;
  embeddings?: unknown;
}

export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL, options: OllamaEmbedderOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_EMBED_MODEL;
    this.dim = options.dim ?? DEFAULT_EMBED_DIM;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  /** Single-text embedding with retry-on-transient-failure. */
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    let lastError: EmbeddingError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await delay(Math.min(this.retryDelayMs * 2 ** (attempt - 1), 2000), signal);
      try {
        return await this.embedOnce(text, signal);
      } catch (err) {
        const failure = toEmbeddingError(err, this.baseUrl, this.model);
        lastError = failure;
        if (!isRetryable(failure)) throw failure;
      }
    }
    throw lastError ?? new EmbeddingError("EMBED_UNAVAILABLE", `Ollama embedding 失败: ${this.baseUrl}`);
  }

  /** Bounded-concurrency batch (default 2 in-flight) — one failure fails the batch. */
  async embedBatch(texts: string[], opts: { signal?: AbortSignal; concurrency?: number } = {}): Promise<number[][]> {
    const limit = Math.max(1, Math.min(opts.concurrency ?? this.concurrency, texts.length || 1));
    const vectors = new Array<number[]>(texts.length);
    let cursor = 0;
    let aborted: { err: unknown } | undefined;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted) return;
        const index = cursor++;
        const text = texts[index];
        if (text === undefined) return;
        try {
          vectors[index] = await this.embed(text, opts.signal);
        } catch (err) {
          aborted ??= { err };
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    if (aborted) throw aborted.err;
    return vectors;
  }

  private async embedOnce(text: string, signal?: AbortSignal): Promise<number[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: composeSignal(this.timeoutMs, signal),
      });
    } catch (err) {
      throw new EmbeddingError(
        "EMBED_UNAVAILABLE",
        `无法连接 Ollama embedding 服务 ${this.baseUrl}。启动: brew services start ollama（模型: ollama pull ${this.model}）`,
        { cause: err },
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = res.status === 404 ? `；模型可能未安装: ollama pull ${this.model}` : "";
      throw new EmbeddingError("EMBED_HTTP_ERROR", `Ollama /api/embeddings 返回 ${res.status}${hint}: ${body.slice(0, 300)}`, {
        status: res.status,
      });
    }

    let payload: OllamaEmbeddingsResponse;
    try {
      payload = (await res.json()) as OllamaEmbeddingsResponse;
    } catch (err) {
      throw new EmbeddingError("EMBED_BAD_RESPONSE", "Ollama /api/embeddings 返回了非 JSON 响应", { cause: err });
    }

    const vector = extractVector(payload);
    if (!vector) {
      throw new EmbeddingError("EMBED_BAD_RESPONSE", `Ollama /api/embeddings 响应缺少 embedding 数组（model=${this.model}）`);
    }
    if (vector.length !== this.dim) {
      throw new EmbeddingError(
        "EMBED_BAD_RESPONSE",
        `embedding 维度不匹配: 期望 ${this.dim}，实际 ${vector.length}（模型 ${this.model}）。Qdrant collection 必须使用相同维度`,
      );
    }
    return vector;
  }
}

/** Accept both /api/embeddings ({embedding}) and newer /api/embed ({embeddings: [[...]]}) shapes. */
function extractVector(payload: OllamaEmbeddingsResponse): number[] | undefined {
  if (Array.isArray(payload.embedding) && payload.embedding.every((v) => typeof v === "number")) {
    return payload.embedding as number[];
  }
  if (Array.isArray(payload.embeddings)) {
    const first = payload.embeddings[0];
    if (Array.isArray(first) && first.every((v) => typeof v === "number")) return first as number[];
  }
  return undefined;
}

function toEmbeddingError(err: unknown, baseUrl: string, model: string): EmbeddingError {
  if (err instanceof EmbeddingError) return err;
  return new EmbeddingError("EMBED_UNAVAILABLE", `Ollama embedding 请求失败 (${baseUrl}, model=${model}): ${messageOf(err)}`, {
    cause: err,
  });
}

/** Transport failures and 5xx/429 are worth retrying; a missing model (404) is not. */
function isRetryable(err: EmbeddingError): boolean {
  if (err.code === "EMBED_UNAVAILABLE") return true;
  return err.code === "EMBED_HTTP_ERROR" && (err.status === undefined || err.status >= 500 || err.status === 429);
}

function composeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
