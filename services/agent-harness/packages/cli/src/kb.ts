/**
 * `harness kb …` — knowledge-base surface (M6, design doc §5.2 + §5.3).
 *
 *   harness kb ingest <path...> [--force]
 *   harness kb search "<query>" [--top 5]
 *   harness kb stats
 *
 * This module never touches the model backend: ingest/search/stats work with Ollama or Qdrant
 * down (prefix/vector recall degrades to keyword-only), which is exactly when you need them.
 */
import { pathToFileURL } from "node:url";
import {
  DEFAULT_KB_DB_PATH,
  KbError,
  KnowledgeBase,
  formatTimestamp,
  type IngestReport,
  type SearchHit,
} from "@harness/kb";

const USAGE = [
  "用法:",
  "  harness kb ingest <path...> [--force]      # 递归导入文件/目录，--force 强制重建索引",
  '  harness kb search "<query>" [--top 5]     # 混合检索（向量 + 全文），带引用',
  "  harness kb stats                          # 来源数、块数、Qdrant 状态、kb.db 路径",
  "",
  "环境变量: HARNESS_KB_DB 覆盖 kb.db 路径（默认 ~/.harness/knowledge/kb.db）",
].join("\n");

/** HARNESS_KB_DB lets tests / alternate workspaces point at a throwaway index. */
function openKb(options: { log?: (message: string) => void } = {}): KnowledgeBase {
  const dbPath = process.env["HARNESS_KB_DB"];
  return new KnowledgeBase({ ...(dbPath ? { dbPath } : {}), ...options });
}

export async function runKb(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ingest":
      return ingest(rest);
    case "search":
      return search(rest);
    case "stats":
      return stats();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.error(USAGE);
      return;
    default:
      console.error(`✖ 未知的 kb 子命令: ${sub}`);
      console.error(USAGE);
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------------------------

async function ingest(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const paths = parsed.positionals;
  if (paths.length === 0) {
    console.error("✖ 需要至少一个文件或目录路径（harness kb ingest <path...>）");
    process.exitCode = 1;
    return;
  }

  const force = parsed.flags["force"] === true;
  const kb = openKb();
  const started = Date.now();
  try {
    const report = await kb.ingest(paths, { force });
    printIngestReport(report, Date.now() - started);
    if (report.failed.length) process.exitCode = 1;
  } catch (err) {
    fail(err);
  } finally {
    kb.close();
  }
}

function printIngestReport(report: IngestReport, elapsedMs: number): void {
  for (const path of report.added) console.log(`✓ 新增  ${path}`);
  for (const path of report.updated) console.log(`~ 更新  ${path}`);
  for (const path of report.skipped) console.log(`- 跳过  ${path}（内容未变）`);
  for (const failure of report.failed) console.log(`✖ 失败  ${failure.path} — ${failure.code}: ${failure.message}`);

  if (report.warnings.length) {
    console.log("");
    for (const warning of report.warnings) console.log(`! ${warning}`);
  }

  const mode =
    report.mode === "hybrid" ? "hybrid（向量 + 全文）" : "fts_only（仅全文，向量链路不可用）";
  console.log("");
  console.log(
    `文件 ${report.added.length + report.updated.length + report.skipped.length + report.failed.length}` +
      `（新增 ${report.added.length} / 更新 ${report.updated.length} / 跳过 ${report.skipped.length} / 失败 ${report.failed.length}）` +
      ` · 块 ${report.chunks} · 向量 ${report.vectors} · 模式 ${mode} · 耗时 ${(elapsedMs / 1000).toFixed(1)}s`,
  );
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

async function search(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const query = parsed.positionals.join(" ").trim();
  if (!query) {
    console.error('✖ 需要检索词（harness kb search "向量检索"）');
    process.exitCode = 1;
    return;
  }
  const top = parseTop(parsed.flags["top"]);

  const kb = openKb();
  try {
    const result = await kb.search(query, top);
    const banner =
      result.mode === "hybrid"
        ? "检索模式: hybrid（向量 0.6 + 关键词 0.4 融合）"
        : `检索模式: fts_only（降级：仅关键词）— ${result.degraded?.message ?? "向量检索不可用"}`;
    console.log(banner);
    console.log("");
    if (!result.hits.length) {
      console.log(`未找到与 "${query}" 相关的内容。`);
      return;
    }
    result.hits.forEach((hit, index) => printHit(hit, index));
    console.log("");
    console.log(`命中 ${result.hits.length} 块（top ${top}）`);
  } catch (err) {
    fail(err);
  } finally {
    kb.close();
  }
}

function printHit(hit: SearchHit, index: number): void {
  const reference =
    hit.startMs !== undefined
      ? `[来源: ${basenameOf(hit.source)} @ ${formatTimestamp(hit.startMs)}]`
      : hit.heading
        ? `[来源: ${hit.source} §${hit.heading}]`
        : `[来源: ${hit.source}]`;
  const arms = [
    hit.vectorScore !== undefined ? `vec ${hit.vectorScore.toFixed(3)}` : "",
    hit.keywordScore !== undefined ? `kw ${hit.keywordScore.toFixed(3)}` : "",
  ].filter((part) => part.length > 0);

  console.log(`${index + 1}. ${reference} (score ${hit.score.toFixed(3)}${arms.length ? `, ${arms.join(" + ")}` : ""})`);
  if (hit.startMs !== undefined && hit.endMs !== undefined) {
    console.log(`   时间轴: ${formatTimestamp(hit.startMs)}–${formatTimestamp(hit.endMs)}`);
  }
  console.log(`   ${excerpt(hit.text, 200)}`);
  console.log("");
}

// ---------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------

async function stats(): Promise<void> {
  const kb = openKb();
  try {
    const result = await kb.stats();
    console.log(`来源: ${result.sources}   块: ${result.chunks}`);
    console.log(`全文索引: ${result.ftsMode === "fts5" ? "FTS5（BM25）" : "LIKE 降级扫描"}`);
    console.log(`kb.db: ${result.dbPath === DEFAULT_KB_DB_PATH ? `${result.dbPath}（默认）` : result.dbPath}`);
    console.log(
      result.vector.ok
        ? `Qdrant: 在线 ${result.vector.url} · collection "${result.vector.collection}"`
        : `Qdrant: 离线 ${result.vector.url}（检索降级为 fts_only）— ${result.vector.error ?? "连接失败"}`,
    );
    if (!result.sources) console.log("\n知识库为空，先运行: harness kb ingest <path...>");
  } catch (err) {
    fail(err);
  } finally {
    kb.close();
  }
}

// ---------------------------------------------------------------------------------------------
// helpers (local copies — the CLI surfaces must not import each other)
// ---------------------------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** `--top 5` / `--top=5` / `--force`; everything else is positional. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { positionals, flags };
}

function parseTop(value: string | true | undefined): number {
  if (typeof value !== "string") return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`! --top 需要正整数，已使用默认值 5（收到 "${value}"）`);
    return 5;
  }
  return Math.min(Math.trunc(parsed), 50);
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fail(err: unknown): void {
  if (err instanceof KbError) {
    console.error(`✖ ${err.code}: ${err.message}`);
  } else {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
}

// `node dist/kb.js ingest …` works standalone (handy for scripts / benchmarking);
// `harness kb …` goes through main.ts, which imports runKb instead of executing this file.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await runKb(process.argv.slice(2));
  process.exit(process.exitCode ?? 0);
}
