/**
 * Qdrant REST client — plain fetch, zero SDK dependency (design doc §5.1: "Qdrant 管向量").
 *
 * Only the four operations the KB needs: ensureCollection / upsert / search / health,
 * plus deleteBySource so re-ingesting a changed file cannot leave stale vectors behind.
 * Every failure is a structured QdrantError — a stopped Qdrant is a normal, degradable state.
 */
/** Qdrant 向量库地址；HARNESS_QDRANT_URL 覆盖（compose 内网服务，对齐 HARNESS_KB_DB 惯例） */
export const DEFAULT_QDRANT_URL =
  process.env["HARNESS_QDRANT_URL"] ?? "http://localhost:6333";
/** Collection name for the personal knowledge base. */
export const DEFAULT_COLLECTION = "harness_kb";
export const DEFAULT_VECTOR_SIZE = 1024;
export const QDRANT_START_HINT = "brew services start qdrant（或 qdrant 前台运行）";

export type QdrantErrorCode = "QDRANT_UNAVAILABLE" | "QDRANT_HTTP_ERROR" | "QDRANT_BAD_RESPONSE";
export type DistanceMetric = "Cosine" | "Euclid" | "Dot";

export class QdrantError extends Error {
  readonly code: QdrantErrorCode;
  readonly status?: number;
  readonly body?: string;

  constructor(code: QdrantErrorCode, message: string, opts: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "QdrantError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

export interface QdrantPoint {
  /** Must be a uint64 or UUID; the KB uses the SQLite chunk id. */
  id: number;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantHit {
  id: number;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantHealth {
  ok: boolean;
  url: string;
  collections: string[];
  latencyMs: number;
  error?: string;
}

export interface QdrantClientOptions {
  /** Request timeout for data operations. */
  timeoutMs?: number;
  /** Health probes must be fast — they run before every search. */
  healthTimeoutMs?: number;
  apiKey?: string;
}

interface QdrantEnvelope<T> {
  result?: T;
  status?: { error?: string | null };
}

export class QdrantClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(baseUrl: string = DEFAULT_QDRANT_URL, options: QdrantClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2_000;
    this.apiKey = options.apiKey;
  }

  /**
   * Create the collection when missing; validate the vector size when it exists.
   * Idempotent — safe to call on every ingest.
   */
  async ensureCollection(
    name: string = DEFAULT_COLLECTION,
    size: number = DEFAULT_VECTOR_SIZE,
    distance: DistanceMetric = "Cosine",
  ): Promise<boolean> {
    try {
      const info = await this.request<{ config?: { params?: { vectors?: unknown } } }>(
        "GET",
        `/collections/${encodeURIComponent(name)}`,
      );
      const existing = readVectorSize(info?.config?.params?.vectors);
      if (existing !== undefined && existing !== size) {
        throw new QdrantError(
          "QDRANT_HTTP_ERROR",
          `Qdrant collection "${name}" 向量维度为 ${existing}，期望 ${size}。删除后重建：curl -X DELETE ${this.baseUrl}/collections/${name}`,
        );
      }
      return false;
    } catch (err) {
      if (!(err instanceof QdrantError) || err.status !== 404) throw err;
    }

    await this.request("PUT", `/collections/${encodeURIComponent(name)}`, {
      vectors: { size, distance },
    });
    return true;
  }

  /** Upsert points; `wait=true` so the caller never races a subsequent search. */
  async upsert(name: string, points: QdrantPoint[], wait = true): Promise<void> {
    if (!points.length) return;
    await this.request("PUT", `/collections/${encodeURIComponent(name)}/points?wait=${wait ? "true" : "false"}`, { points });
  }

  /** Vector search; payload comes back so citations can be built without a second hop. */
  async search(name: string, vector: number[], limit = 20, withPayload = true): Promise<QdrantHit[]> {
    const hits = await this.request<QdrantHit[]>("POST", `/collections/${encodeURIComponent(name)}/points/search`, {
      vector,
      limit,
      with_payload: withPayload,
      with_vector: false,
    });
    if (!Array.isArray(hits)) {
      throw new QdrantError("QDRANT_BAD_RESPONSE", `Qdrant search 响应缺少 result 数组（collection=${name}）`);
    }
    return hits.map((hit) => ({
      id: Number(hit.id),
      score: typeof hit.score === "number" ? hit.score : 0,
      payload: (hit.payload ?? {}) as Record<string, unknown>,
    }));
  }

  /** Remove every point belonging to one source — called before re-upserting a changed file. */
  async deleteBySource(name: string, source: string): Promise<void> {
    await this.request("POST", `/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
      filter: { must: [{ key: "source", match: { value: source } }] },
    });
  }

  /** `/collections` probe with a 2s timeout; never throws — callers degrade to FTS-only. */
  async health(): Promise<QdrantHealth> {
    const started = Date.now();
    try {
      const result = await this.request<{ collections?: { name?: string }[] }>("GET", "/collections", undefined, this.healthTimeoutMs);
      const collections = (result?.collections ?? []).map((c) => c?.name ?? "").filter((n) => n.length > 0);
      return { ok: true, url: this.baseUrl, collections, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        url: this.baseUrl,
        collections: [],
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.apiKey ? { "api-key": this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new QdrantError(
        "QDRANT_UNAVAILABLE",
        `无法连接 Qdrant ${this.baseUrl}（${method} ${path}）。启动: ${QDRANT_START_HINT}`,
        { cause: err },
      );
    }

    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      throw new QdrantError("QDRANT_HTTP_ERROR", `Qdrant ${method} ${path} 返回 ${res.status}: ${raw.slice(0, 300)}`, {
        status: res.status,
        body: raw.slice(0, 1000),
      });
    }
    if (!raw.trim()) return undefined as T;

    let parsed: QdrantEnvelope<T>;
    try {
      parsed = JSON.parse(raw) as QdrantEnvelope<T>;
    } catch (err) {
      throw new QdrantError("QDRANT_BAD_RESPONSE", `Qdrant ${method} ${path} 返回了非 JSON 响应`, { cause: err });
    }
    return parsed.result as T;
  }
}

/** Named-vector collections nest size one level deeper; handle both shapes. */
function readVectorSize(vectors: unknown): number | undefined {
  if (!vectors || typeof vectors !== "object") return undefined;
  const size = (vectors as { size?: unknown }).size;
  if (typeof size === "number") return size;
  const named = (vectors as Record<string, unknown>)[""] ?? Object.values(vectors as Record<string, unknown>)[0];
  if (named && typeof named === "object") {
    const nested = (named as { size?: unknown }).size;
    if (typeof nested === "number") return nested;
  }
  return undefined;
}
