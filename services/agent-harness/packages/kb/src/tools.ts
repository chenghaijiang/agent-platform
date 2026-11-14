/**
 * KB tools for the Tool Registry (design doc §5.2 + §7).
 *
 * registerKbTools takes a structural subset of ToolRegistry so this package stays free of a
 * runtime dependency on @harness/core — the registry validates manifests, we only declare them.
 * The KB handle is injected as KbQueryApi, so callers can pass a lazy facade that opens SQLite
 * only once a tool actually runs.
 */
import { basename } from "node:path";
import type { ToolManifest } from "@harness/contracts";
import { KbError, type KbQueryApi, type SearchHit } from "./kb.js";
import { formatTimestamp } from "./media.js";

export const KB_SEARCH_TOOL = "kb:search";
export const KB_READ_TOOL = "kb:read";
export const KB_SOURCES_TOOL = "kb:sources";

export interface ToolRegistrar {
  register(manifest: ToolManifest, execute: (input: unknown) => Promise<string>): void;
}

export interface KbSearchInput {
  query: string;
}

export interface KbReadInput {
  path: string;
  heading?: string;
  /** Media only: "12:00-14:30" (mm:ss-mm:ss) or "720-870" (seconds). */
  timeRange?: string;
}

/**
 * `[来源: /abs/path.md §安装 > 配置]` for documents,
 * `[来源: lecture.mp4 @ 12:34]` for media chunks (timestamp is the chunk start).
 */
export function formatCitation(source: string, heading: string, startMs?: number): string {
  if (startMs !== undefined) return `[来源: ${basename(source)} @ ${formatTimestamp(startMs)}]`;
  return heading ? `[来源: ${source} §${heading}]` : `[来源: ${source}]`;
}

export function registerKbTools(registry: ToolRegistrar, kb: KbQueryApi): void {
  registry.register(
    {
      name: KB_SEARCH_TOOL,
      description:
        "Search the local knowledge base (hybrid: vector + full-text) and return cited snippets. " +
        "Query with concrete content keywords — names, companies, technologies, file-name words — " +
        "not pronoun phrases like \"我的简历\". Every result is prefixed with [来源: path §section] " +
        "for documents or [来源: file @ mm:ss] for video/audio — quote that reference when you use " +
        "the content. If results look irrelevant, reword the query or list sources with kb:sources.",
      permission: "read",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      timeoutMs: 30_000,
      outputBudget: 4_000,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "自然语言问题或关键词" },
        },
        required: ["query"],
      },
    },
    async (input) => {
      const { query } = input as KbSearchInput;
      try {
        const result = await kb.search(query, 5);
        const banner =
          result.mode === "hybrid"
            ? "检索模式: hybrid（向量 0.6 + 关键词 0.4 融合）"
            : `检索模式: fts_only（仅关键词；${result.degraded?.message ?? "向量检索不可用"}）`;
        if (!result.hits.length) {
          return `${banner}\n未找到与 "${query}" 相关的内容。若知识库尚未导入资料，请先运行 \`harness kb ingest <path>\`。`;
        }
        return `${banner}\n\n${result.hits.map(formatHit).join("\n\n")}`;
      } catch (err) {
        return formatError(err);
      }
    },
  );

  registry.register(
    {
      name: KB_READ_TOOL,
      description:
        "Read a knowledge-base source in full, one section by heading, or one time window of a " +
        "video/audio source (timeRange \"12:00-14:30\"). Use after kb:search when a snippet needs " +
        "more context. Output starts with [来源: path §section] or [来源: file @ mm:ss].",
      permission: "read",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      timeoutMs: 15_000,
      outputBudget: 8_000,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "来源文件路径（可用 basename 或路径后缀）" },
          heading: { type: "string", description: "章节标题或层级路径，如 '安装 > 配置'；省略则返回全文" },
          timeRange: {
            type: "string",
            description: "仅音视频来源：时间区间，如 '12:00-14:30'（mm:ss-mm:ss）或 '720-870'（秒）",
          },
        },
        required: ["path"],
      },
    },
    async (input) => {
      const { path, heading, timeRange } = input as KbReadInput;
      try {
        const result = await kb.read(path, heading, timeRange);
        const citation = formatCitation(result.source, result.heading ?? "", result.timeRange?.fromMs);
        const scope = result.timeRange
          ? `，区间 ${formatTimestamp(result.timeRange.fromMs)}–${formatTimestamp(result.timeRange.toMs)}`
          : "";
        return `${citation}\n（${result.chunkCount} 块${scope}）\n\n${result.text}`;
      } catch (err) {
        return formatError(err);
      }
    },
  );

  registry.register(
    {
      name: KB_SOURCES_TOOL,
      description:
        "List what is actually indexed in the knowledge base (paths, types, chunk counts). " +
        "Use this to discover available sources when a kb:search misses, or to answer " +
        "\"知识库里有什么/我的XX文件在不在库里\" questions before falling back to filesystem scans.",
      permission: "read",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      timeoutMs: 10_000,
      outputBudget: 6_000,
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "可选：按路径子串过滤（如 '简历'、'程海江'）" },
          limit: { type: "number", description: "最多返回条数，默认 50，上限 200" },
        },
      },
    },
    async (input) => {
      const { q, limit } = (input ?? {}) as { q?: string; limit?: number };
      try {
        const needle = (q ?? "").trim().toLowerCase();
        const all = kb.listSources();
        const filtered = needle ? all.filter((s) => s.path.toLowerCase().includes(needle)) : all;
        const max = Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200);
        const shown = filtered
          .slice()
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, max);
        const head = `共 ${all.length} 个来源${needle ? `，路径含 "${needle}" 的 ${filtered.length} 个` : ""}（按修改时间倒序，显示前 ${shown.length} 个）`;
        if (!shown.length) return `${head}\n没有匹配的来源。`;
        return `${head}\n${shown.map((s) => `- [${s.type}] ${s.path}（${s.chunkCount} 块）`).join("\n")}`;
      } catch (err) {
        return formatError(err);
      }
    },
  );
}

function formatHit(hit: SearchHit, index: number): string {
  const citation = formatCitation(hit.source, hit.heading, hit.startMs);
  // Documents carry the section inside the citation; media adds the exact chunk span.
  const span =
    hit.startMs !== undefined && hit.endMs !== undefined
      ? ` ${formatTimestamp(hit.startMs)}–${formatTimestamp(hit.endMs)}`
      : "";
  const arms = [
    hit.vectorScore !== undefined ? `vec ${hit.vectorScore.toFixed(3)}` : "",
    hit.keywordScore !== undefined ? `kw ${hit.keywordScore.toFixed(3)}` : "",
  ].filter((part) => part.length > 0);
  const detail = arms.length ? `, ${arms.join(" + ")}` : "";
  const flag = hit.matchedBy === "filename" ? " 〔文件名匹配〕" : "";
  return `${index + 1}. ${citation}${span} (score ${hit.score.toFixed(3)}${detail})${flag}\n${hit.text}`;
}

/** §7: failures are structured, never an empty string or a thrown-in-the-dark stack. */
function formatError(err: unknown): string {
  if (err instanceof KbError) return `ERROR ${err.code}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  return `ERROR KB_UNEXPECTED: ${message}`;
}
