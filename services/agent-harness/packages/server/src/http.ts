/**
 * Protocol server (design doc §3): the only channel between clients and the AgentRuntime.
 *
 * Zero dependencies — node:http + SSE. Routes:
 *   GET  /                    static client (packages/web/public)
 *   GET  /api/health          {ok, model, provider, qdrant, …}
 *   GET  /api/events          SSE: session events + state snapshots + `: ping` every 15s
 *   GET  /api/state           derived snapshot (phase / context / stats / approvals)
 *   POST /api/turn            {text} -> 202 {traceId}
 *   POST /api/approve         {requestId, decision:"allowed"|"denied"|"always"}
 *   POST /api/cancel          interrupt the running turn (501 when core cannot cancel)
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CleanOptions, ChunkOptions } from "@harness/kb";
import type { ApiFormat } from "@harness/core";
import type { ApprovalDecision, HostSnapshot, RuntimeHost } from "./runtime-host.js";

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface ProtocolServerOptions {
  /** Bind address — local-only by default (never expose the agent loop on 0.0.0.0). */
  host?: string;
  port?: number;
  /** Static root; defaults to packages/web/public (resolved from this module's location). */
  publicDir?: string;
}

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function defaultPublicDir(): string {
  // dist/http.js -> packages/server/dist -> packages/ -> packages/web/public
  return fileURLToPath(new URL("../../web/public/", import.meta.url));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...(status === 413 || status === 415 ? { Connection: "close" } : {}),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: { code, message }, ...extra });
}

/** Read a JSON object body, enforcing Content-Type and the 64KB ceiling. */
/** Loose shape check for the optional clean/chunk option objects coming from the admin UI. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only known clean knobs with boolean values; the rest are ignored. */
function pickCleanOptions(raw: Record<string, unknown>): CleanOptions {
  const boolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const out: CleanOptions = {};
  const collapse = boolean(raw["collapseWhitespace"]);
  const html = boolean(raw["stripHtml"]);
  const fences = boolean(raw["stripCodeFences"]);
  const urls = boolean(raw["stripUrls"]);
  const dup = boolean(raw["dropDuplicateLines"]);
  if (collapse !== undefined) out["collapseWhitespace"] = collapse;
  if (html !== undefined) out["stripHtml"] = html;
  if (fences !== undefined) out["stripCodeFences"] = fences;
  if (urls !== undefined) out["stripUrls"] = urls;
  if (dup !== undefined) out["dropDuplicateLines"] = dup;
  return out;
}

/** Keep only known chunk knobs, with finite numbers; invalid values are dropped. */
function pickChunkOptions(raw: Record<string, unknown>): ChunkOptions {
  const out: ChunkOptions = {};
  const maxChars = raw["maxChars"];
  const overlapChars = raw["overlapChars"];
  if (typeof maxChars === "number" && Number.isFinite(maxChars)) out["maxChars"] = maxChars;
  if (typeof overlapChars === "number" && Number.isFinite(overlapChars)) out["overlapChars"] = overlapChars;
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type 必须是 application/json");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "BODY_TOO_LARGE", "请求体超过 64KB");
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体不是合法的 JSON 对象");
  }
}

/** Resolve a URL path inside the static root, or null when it escapes it. */
function resolveStaticPath(publicDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const relative = decoded === "/" || decoded === "" ? "/index.html" : decoded;
  const full = resolve(join(publicDir, normalize(relative)));
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null;
  return full;
}

async function serveStatic(publicDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const filePath = resolveStaticPath(publicDir, pathname);
  if (!filePath) {
    sendError(res, 403, "FORBIDDEN", "非法路径");
    return;
  }

  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    sendError(res, 404, "NOT_FOUND", `静态资源不存在: ${pathname}`);
    return;
  }

  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

/** SSE: forward every host event, plus a heartbeat comment so proxies keep the socket open. */
function streamEvents(host: RuntimeHost, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const write = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  write("state", host.snapshot());
  // Replay the recorded transcript first so a browser refresh (or reconnect) rebuilds the
  // chat history before live events arrive. The UI replaces its empty stream with this.
  write("replay", host.replay());

  const onState = (snapshot: HostSnapshot): void => write("state", snapshot);
  const onSession = (event: unknown): void => write("session", event);
  const onDelta = (payload: { text: string }): void => write("delta", payload);
  const onToolInput = (payload: unknown): void => write("tool_input", payload);
  const onToolResult = (payload: unknown): void => write("tool_result", payload);
  const onApproval = (payload: unknown): void => write("approval", payload);
  const onApprovalResolved = (payload: unknown): void => write("approval_resolved", payload);
  const onTurn = (payload: unknown): void => write("turn", payload);
  const onCompaction = (payload: unknown): void => write("compaction", payload);

  host.on("state", onState);
  host.on("session", onSession);
  host.on("delta", onDelta);
  host.on("tool_input", onToolInput);
  host.on("tool_result", onToolResult);
  host.on("approval", onApproval);
  host.on("approval_resolved", onApprovalResolved);
  host.on("turn", onTurn);
  host.on("compaction", onCompaction);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    host.off("state", onState);
    host.off("session", onSession);
    host.off("delta", onDelta);
    host.off("tool_input", onToolInput);
    host.off("tool_result", onToolResult);
    host.off("approval", onApproval);
    host.off("approval_resolved", onApprovalResolved);
    host.off("turn", onTurn);
    host.off("compaction", onCompaction);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function handleApi(
  host: RuntimeHost,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (pathname === "/api/events") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/events 只支持 GET");
      return true;
    }
    streamEvents(host, req, res);
    return true;
  }

  if (pathname === "/api/models") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/models 只支持 GET");
      return true;
    }
    sendJson(res, 200, await host.listModels());
    return true;
  }

  if (pathname === "/api/models/custom") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/models/custom 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    const baseUrl = str("url");
    const model = str("model");
    if (!baseUrl || !model) {
      throw new HttpError(400, "INVALID_INPUT", "url 和 model 为必填项");
    }
    if (baseUrl.length > 500 || model.length > 200) {
      throw new HttpError(400, "INVALID_INPUT", "url/model 长度超限");
    }
    const apiKey = str("apiKey");
    const context = Number(body.context);
    const apiFormat = str("apiFormat");
    const VALID_FORMATS = ["chat-completions", "anthropic-messages", "responses"] as const;
    if (apiFormat && !VALID_FORMATS.includes(apiFormat as (typeof VALID_FORMATS)[number])) {
      throw new HttpError(400, "INVALID_INPUT", `apiFormat 必须是 ${VALID_FORMATS.join(" / ")}`);
    }
    try {
      const added = await host.addCustomModel({
        name: str("name") || undefined,
        baseUrl,
        apiKey: apiKey || undefined,
        model,
        contextWindow: Number.isFinite(context) && context > 0 ? context : undefined,
        apiFormat: (apiFormat || undefined) as ApiFormat | undefined,
      });
      sendJson(res, 200, { ok: true, ...added, ...(await host.listModels()) });
    } catch (err) {
      sendJson(res, 400, {
        error: { code: "CUSTOM_MODEL_INVALID", message: err instanceof Error ? err.message : String(err) },
      });
    }
    return true;
  }

  if (pathname === "/api/models/custom/remove") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/models/custom/remove 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!provider) throw new HttpError(400, "INVALID_INPUT", "缺少 provider 字段");
    try {
      sendJson(res, 200, { ok: true, ...host.removeCustomModel(provider), ...(await host.listModels()) });
    } catch (err) {
      sendJson(res, 400, {
        error: { code: "CUSTOM_MODEL_REMOVE_FAILED", message: err instanceof Error ? err.message : String(err) },
      });
    }
    return true;
  }

  if (pathname === "/api/models/custom/update") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/models/custom/update 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    const provider = str("provider");
    const baseUrl = str("url");
    const model = str("model");
    if (!provider) throw new HttpError(400, "INVALID_INPUT", "缺少 provider 字段");
    if (!baseUrl || !model) throw new HttpError(400, "INVALID_INPUT", "url 和 model 为必填项");
    if (baseUrl.length > 500 || model.length > 200) throw new HttpError(400, "INVALID_INPUT", "url/model 长度超限");
    const apiKey = str("apiKey");
    const context = Number(body.context);
    const apiFormat = str("apiFormat");
    const VALID_FORMATS = ["chat-completions", "anthropic-messages", "responses"] as const;
    if (apiFormat && !VALID_FORMATS.includes(apiFormat as (typeof VALID_FORMATS)[number])) {
      throw new HttpError(400, "INVALID_INPUT", `apiFormat 必须是 ${VALID_FORMATS.join(" / ")}`);
    }
    try {
      sendJson(res, 200, {
        ok: true,
        ...(await host.updateCustomModel(provider, {
          name: str("name") || undefined,
          baseUrl,
          // Empty string means "unchanged" — the UI never echoes secrets back.
          apiKey: apiKey || undefined,
          model,
          contextWindow: Number.isFinite(context) && context > 0 ? context : undefined,
          apiFormat: (apiFormat || undefined) as ApiFormat | undefined,
        })),
        ...(await host.listModels()),
      });
    } catch (err) {
      sendJson(res, 400, {
        error: { code: "CUSTOM_MODEL_UPDATE_FAILED", message: err instanceof Error ? err.message : String(err) },
      });
    }
    return true;
  }

  if (pathname === "/api/agent-mode") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/agent-mode 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    try {
      sendJson(res, 200, { ok: true, ...host.setAgentMode(body.enabled === true), ...(await Promise.resolve(host.snapshot())) });
    } catch (err) {
      const code = (err as { code?: string }).code ?? "AGENT_MODE_FAILED";
      const status = (err as { status?: number }).status ?? 400;
      sendJson(res, status, { error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
    return true;
  }

  if (pathname === "/api/model") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/model 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model || model.length > 120) {
      throw new HttpError(400, "INVALID_INPUT", "缺少非空的 model 字段");
    }
    try {
      sendJson(res, 200, { ok: true, ...(await host.switchModel(model)) });
    } catch (err) {
      const structured = err as { code?: string; status?: number; message?: string };
      sendJson(res, structured.status ?? 500, {
        error: { code: structured.code ?? "MODEL_SWITCH_FAILED", message: structured.message ?? String(err) },
      });
    }
    return true;
  }

  if (pathname === "/api/kb/status") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/status 只支持 GET");
      return true;
    }
    try {
      sendJson(res, 200, await host.kbStatus());
    } catch (err) {
      sendJson(res, 503, { error: { code: "KB_UNAVAILABLE", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/kb/sources") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/sources 只支持 GET");
      return true;
    }
    try {
      sendJson(res, 200, {
        sources: host.kbSources({
          page: Number(url.searchParams.get("page") ?? 1),
          pageSize: Number(url.searchParams.get("pageSize") ?? 20),
          q: url.searchParams.get("q") ?? "",
          type: url.searchParams.get("type") ?? "all",
          all: url.searchParams.get("all") === "1",
        }),
      });
    } catch (err) {
      sendJson(res, 503, { error: { code: "KB_UNAVAILABLE", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/kb/jobs") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/jobs 只支持 GET");
      return true;
    }
    sendJson(res, 200, { jobs: host.kbJobsList() });
    return true;
  }

  if (pathname.startsWith("/api/kb/jobs/")) {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/jobs/:id 只支持 GET");
      return true;
    }
    const jobId = pathname.slice("/api/kb/jobs/".length);
    const job = host.kbJob(jobId);
    if (!job) {
      sendError(res, 404, "JOB_NOT_FOUND", `导入任务不存在或已被清理: ${jobId}`);
      return true;
    }
    sendJson(res, 200, job);
    return true;
  }

  if (pathname === "/api/kb/ingest") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/ingest 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const raw = body.paths;
    const paths = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!paths.length) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 paths 字段（文件或目录路径数组）");
    }
    if (paths.length > 50) {
      throw new HttpError(400, "INVALID_INPUT", "单次最多导入 50 个路径");
    }
    try {
      // force=true bypasses the unchanged-skip so an admin "rebuild" re-indexes in place.
      // clean/chunk echo the admin panel's pre-import settings; unknown shapes are dropped.
      // Returns immediately; poll /api/kb/jobs/:id for progress and the final report.
      const { jobId } = host.kbIngest(paths, {
        force: body.force === true,
        ...(isPlainObject(body.clean) ? { clean: pickCleanOptions(body.clean) } : {}),
        ...(isPlainObject(body.chunk) ? { chunk: pickChunkOptions(body.chunk) } : {}),
      });
      sendJson(res, 202, { ok: true, jobId });
    } catch (err) {
      sendJson(res, 502, { error: { code: "KB_INGEST_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/kb/preview") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/preview 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const file = typeof body.path === "string" ? body.path.trim() : "";
    if (!file) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 path 字段（要预览的单个文件路径）");
    }
    try {
      sendJson(res, 200, host.kbPreview(file, {
        ...(isPlainObject(body.clean) ? { clean: pickCleanOptions(body.clean) } : {}),
        ...(isPlainObject(body.chunk) ? { chunk: pickChunkOptions(body.chunk) } : {}),
      }));
    } catch (err) {
      sendJson(res, 400, { error: { code: "KB_PREVIEW_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/kb/remove") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/remove 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 path 字段（要移除的来源路径）");
    }
    try {
      sendJson(res, 200, await host.kbRemoveSource(path));
    } catch (err) {
      sendJson(res, 502, { error: { code: "KB_REMOVE_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/kb/search") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/kb/search 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      throw new HttpError(400, "INVALID_INPUT", "缺少非空的 query 字段");
    }
    try {
      sendJson(res, 200, await host.kbSearch(query));
    } catch (err) {
      sendJson(res, 502, { error: { code: "KB_SEARCH_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/fs/list") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/fs/list 只支持 GET");
      return true;
    }
    try {
      sendJson(res, 200, host.fsList(url.searchParams.get("path") ?? undefined));
    } catch (err) {
      sendJson(res, 400, { error: { code: "FS_LIST_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/fs/read") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/fs/read 只支持 GET");
      return true;
    }
    const file = url.searchParams.get("path") ?? "";
    if (!file.trim()) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 path 参数");
    }
    try {
      sendJson(res, 200, host.fsRead(file));
    } catch (err) {
      sendJson(res, 400, { error: { code: "FS_READ_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/fs/download") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/fs/download 只支持 GET");
      return true;
    }
    const file = url.searchParams.get("path") ?? "";
    if (!file.trim()) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 path 参数");
    }
    try {
      const info = host.fsFileInfo(file);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
        // RFC 5987: non-ASCII filenames (中文) ride in filename*; ASCII fallback keeps old clients happy.
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      });
      const stream = createReadStream(info.path);
      stream.pipe(res);
      stream.on("error", () => res.destroy());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
      sendJson(res, code, { error: { code: "FS_DOWNLOAD_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/skills") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/skills 只支持 GET");
      return true;
    }
    sendJson(res, 200, { skills: host.listSkills() });
    return true;
  }

  if (pathname === "/api/workspace") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/workspace 只支持 GET");
      return true;
    }
    sendJson(res, 200, { cwd: host.workspaceDir() });
    return true;
  }

  if (pathname === "/api/db/tables") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/db/tables 只支持 GET");
      return true;
    }
    try {
      sendJson(res, 200, host.dbInspect());
    } catch (err) {
      sendJson(res, 400, { error: { code: "DB_INSPECT_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/db/query") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/db/query 只支持 POST");
      return true;
    }
    try {
      const body = await readJson(req);
      const sql = typeof body.sql === "string" ? body.sql : "";
      const limit = typeof body.limit === "number" ? body.limit : 100;
      sendJson(res, 200, host.dbQuery(sql, limit));
    } catch (err) {
      sendJson(res, 400, { error: { code: "DB_QUERY_FAILED", message: String((err as Error).message ?? err) } });
    }
    return true;
  }

  if (pathname === "/api/qdrant/collections") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/qdrant/collections 只支持 GET");
      return true;
    }
    sendJson(res, 200, await host.qdrantCollections());
    return true;
  }

  if (pathname.startsWith("/api/qdrant/collections/") && pathname.endsWith("/points")) {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/qdrant/collections/:name/points 只支持 GET");
      return true;
    }
    const parts = pathname.split("/");
    const collection = decodeURIComponent(parts[4] ?? "");
    if (!collection) {
      throw new HttpError(400, "INVALID_INPUT", "缺少 collection 名称");
    }
    const limit = Number(url.searchParams.get("limit") ?? 20) || 20;
    const offset = url.searchParams.get("offset") ?? undefined;
    sendJson(res, 200, await host.qdrantPoints(collection, limit, offset ?? undefined));
    return true;
  }

  if (pathname === "/api/health") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/health 只支持 GET");
      return true;
    }
    sendJson(res, 200, await host.health());
    return true;
  }

  if (pathname === "/api/state") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/state 只支持 GET");
      return true;
    }
    sendJson(res, 200, host.snapshot());
    return true;
  }

  if (pathname === "/api/turn") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/turn 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      throw new HttpError(400, "INVALID_INPUT", "缺少非空的 text 字段");
    }
    if (text.length > 20_000) {
      throw new HttpError(400, "INVALID_INPUT", "text 过长（上限 20000 字符）");
    }
    try {
      const { traceId } = host.submitTurn(text);
      sendJson(res, 202, { ok: true, status: "accepted", traceId });
    } catch (err) {
      const structured = err as { code?: string; status?: number; message?: string };
      sendJson(res, structured.status ?? 500, {
        error: { code: structured.code ?? "TURN_FAILED", message: structured.message ?? String(err) },
        busy: structured.code === "TURN_BUSY",
      });
    }
    return true;
  }

  if (pathname === "/api/approve") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/approve 只支持 POST");
      return true;
    }
    const body = await readJson(req);
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decision = body.decision;
    if (!requestId) throw new HttpError(400, "INVALID_INPUT", "缺少 requestId");
    if (decision !== "allowed" && decision !== "denied" && decision !== "always") {
      throw new HttpError(400, "INVALID_INPUT", 'decision 必须是 "allowed" | "denied" | "always"');
    }
    const resolved = host.resolveApproval(requestId, decision as ApprovalDecision);
    if (!resolved) {
      sendError(res, 404, "APPROVAL_NOT_FOUND", "该审批已失效（已决策或已超时）", { requestId });
      return true;
    }
    sendJson(res, 200, { ok: true, requestId, decision });
    return true;
  }

  if (pathname === "/api/cancel") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "/api/cancel 只支持 POST");
      return true;
    }
    await readJson(req);
    const outcome = host.cancel();
    if (outcome === "unsupported") {
      sendError(res, 501, "CANCEL_UNSUPPORTED", "当前运行时尚未提供 cancel 能力（core 侧实现中）");
      return true;
    }
    sendJson(res, 200, { ok: true, cancelled: outcome === "cancelled", state: outcome });
    return true;
  }

  sendError(res, 404, "NOT_FOUND", `未知的接口: ${pathname}`);
  return true;
}

export function createProtocolServer(host: RuntimeHost, options: ProtocolServerOptions = {}): Server {
  const publicDir = resolve(options.publicDir ?? defaultPublicDir());

  return createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

      if (await handleApi(host, req, res, pathname)) return;

      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        sendError(res, 405, "METHOD_NOT_ALLOWED", `不支持的方法: ${method}`);
        return;
      }
      await serveStatic(publicDir, pathname, res);
    })().catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      sendError(res, 500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    });
  });
}

export async function startProtocolServer(
  host: RuntimeHost,
  options: ProtocolServerOptions = {},
): Promise<RunningServer> {
  const bindHost = options.host ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createProtocolServer(host, options);

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, bindHost, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${bindHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}
