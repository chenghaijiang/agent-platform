/**
 * Parsing layer for knowledge-base ingestion (design doc §5.2).
 *
 * Text-shaped formats (markdown / text / csv / code) are read directly. The M6-二期
 * binary formats are now wired in: PDF via poppler's `pdftotext`, .docx natively
 * (zip + word/document.xml, zero deps), legacy .doc via macOS `textutil`. Formats
 * with no parser yet stay "deferred" and fail loudly — silent mis-parsing poisons
 * the index and is worse than failing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Coarse document kind; drives chunking strategy and is persisted in `sources.type`. */
export type DocType = "markdown" | "text" | "csv" | "code" | "pdf" | "office";

export interface ParsedDoc {
  /** Absolute path (ingest keys sources by absolute path). */
  source: string;
  /** File name, used as the human-facing title. */
  name: string;
  type: DocType;
  /** Normalized UTF-8 text; markdown keeps its heading lines verbatim. */
  text: string;
}

export type ParseErrorCode = "UNSUPPORTED_FORMAT" | "EMPTY_DOCUMENT" | "READ_FAILED" | "NOT_A_FILE";

/** Exact wording required for formats that need an external parser (M6 二期). */
export const DEFERRED_FORMAT_MESSAGE = "该格式需要外部解析器，M6 二期接入";

export class ParseError extends Error {
  readonly code: ParseErrorCode;
  readonly source: string;

  constructor(code: ParseErrorCode, source: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ParseError";
    this.code = code;
    this.source = source;
  }
}

const MARKDOWN_EXTS = [".md", ".markdown", ".mdx"] as const;
const TEXT_EXTS = [".txt", ".text", ".log", ".rst"] as const;
const CSV_EXTS = [".csv", ".tsv"] as const;
const CODE_EXTS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".scala",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".m", ".mm",
  ".php", ".sh", ".bash", ".zsh", ".fish", ".sql", ".css", ".scss", ".less",
  ".vue", ".svelte", ".lua", ".r", ".pl", ".ex", ".exs", ".dart", ".gradle",
] as const;

/** Recognized, but no parser wired up yet — fail loudly, never index raw bytes. */
const DEFERRED_EXTS = [".xlsx", ".xls", ".pptx", ".ppt", ".html", ".htm", ".odt", ".epub"] as const;

const EXT_TO_TYPE: Record<string, DocType> = {
  ...Object.fromEntries(MARKDOWN_EXTS.map((e) => [e, "markdown" as DocType])),
  ...Object.fromEntries(TEXT_EXTS.map((e) => [e, "text" as DocType])),
  ...Object.fromEntries(CSV_EXTS.map((e) => [e, "csv" as DocType])),
  ...Object.fromEntries(CODE_EXTS.map((e) => [e, "code" as DocType])),
  ".pdf": "pdf",
  ".docx": "office",
  ".doc": "office",
};

const DEFERRED_SET = new Set<string>(DEFERRED_EXTS);

export type FileKind = DocType | "deferred" | "unknown";

/** Extension dispatch shared by ingest (to pre-filter) and parse (to route). */
export function classifyFile(filePath: string): FileKind {
  const ext = extname(filePath).toLowerCase();
  if (!ext) return "unknown";
  const type = EXT_TO_TYPE[ext];
  if (type) return type;
  if (DEFERRED_SET.has(ext)) return "deferred";
  return "unknown";
}

/** Extensions that ingest will pick up when walking a directory. */
export function supportedExtensions(): string[] {
  return Object.keys(EXT_TO_TYPE).sort();
}

/**
 * Read + normalize one file.
 * Markdown keeps `#` heading lines (chunker rebuilds the hierarchy from them);
 * everything else is treated as plain text with collapsed blank lines.
 */
export function parseFile(filePath: string): ParsedDoc {
  const source = resolve(filePath);
  let stat;
  try {
    stat = statSync(source);
  } catch (err) {
    throw new ParseError("READ_FAILED", source, `无法读取文件 ${source}: ${errorMessage(err)}`, err);
  }
  if (!stat.isFile()) throw new ParseError("NOT_A_FILE", source, `${source} 不是普通文件`);

  const kind = classifyFile(source);
  const ext = extname(source).toLowerCase();
  if (kind === "deferred") {
    throw new ParseError("UNSUPPORTED_FORMAT", source, `${DEFERRED_FORMAT_MESSAGE}（${ext}）`);
  }
  if (kind === "unknown") {
    throw new ParseError(
      "UNSUPPORTED_FORMAT",
      source,
      `不支持的扩展名 "${ext || "(无)"}"：${source}。支持 .md/.txt/.csv/.pdf/.docx/.doc、常见源代码类型及音视频/图片`,
    );
  }

  let raw: string;
  if (kind === "pdf") {
    raw = extractPdfText(source);
  } else if (kind === "office") {
    raw = extractWordText(source, ext);
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (err) {
      throw new ParseError("READ_FAILED", source, `无法读取文件 ${source}: ${errorMessage(err)}`, err);
    }
  }

  const text = normalizeText(raw, kind);
  if (!text.trim()) throw new ParseError("EMPTY_DOCUMENT", source, `${source} 解析后为空（无可索引内容）`);

  return { source, name: basename(source), type: kind, text };
}

/** Line-ending normalization + BOM strip. md/text/pdf/office also get blank-line collapsing. */
export function normalizeText(raw: string, type: DocType): string {
  let text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (type === "pdf") text = text.replace(/\f/g, "\n\n"); // pdftotext marks page breaks with \f
  if (type === "markdown" || type === "text" || type === "pdf" || type === "office") {
    text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  }
  return `${text.trim()}\n`;
}

// ---------------------------------------------------------------------------------------------
// binary format extractors (M6 二期: pdf / docx / doc)
// ---------------------------------------------------------------------------------------------

/**
 * PDF → text via poppler's `pdftotext`. The one format with an external binary
 * dependency; a missing tool surfaces as an actionable install hint.
 */
function extractPdfText(source: string): string {
  let out: Buffer;
  try {
    out = execFileSync("pdftotext", ["-q", source, "-"], { maxBuffer: 128 * 1024 * 1024, timeout: 120_000 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ParseError("UNSUPPORTED_FORMAT", source, "PDF 解析需要 poppler 的 pdftotext 工具（macOS: brew install poppler）");
    }
    throw new ParseError("READ_FAILED", source, `pdftotext 解析失败: ${errorMessage(err)}`, err);
  }
  return out.toString("utf8");
}

/** Legacy .doc rides on macOS textutil; .docx is parsed natively (zip + XML). */
function extractWordText(source: string, ext: string): string {
  if (ext !== ".docx") {
    let out: Buffer;
    try {
      out = execFileSync("textutil", ["-convert", "txt", "-stdout", source], {
        maxBuffer: 128 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ParseError("UNSUPPORTED_FORMAT", source, ".doc 解析依赖 macOS 的 textutil 工具");
      }
      throw new ParseError("READ_FAILED", source, `textutil 解析失败: ${errorMessage(err)}`, err);
    }
    return out.toString("utf8");
  }
  return extractDocxText(source);
}

/**
 * Minimal .docx reader: pull word/document.xml out of the zip container (central
 * directory scan, stored + deflate entries — all Word ever writes) and turn
 * paragraph/tab/line-break markup into plain text. Zero dependencies.
 */
function extractDocxText(source: string): string {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(readFileSync(source));
  } catch (err) {
    throw new ParseError("UNSUPPORTED_FORMAT", source, `不是有效的 .docx（zip 解析失败）: ${errorMessage(err)}`, err);
  }
  const xmlBuf = entries.get("word/document.xml");
  if (!xmlBuf) {
    throw new ParseError("UNSUPPORTED_FORMAT", source, "不是有效的 .docx（缺少 word/document.xml）");
  }
  return (
    xmlBuf
      .toString("utf8")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // &amp; must be last — decoding it earlier would corrupt the other entities
      .replace(/&amp;/g, "&")
  );
}

/** Minimal zip central-directory reader — enough for .docx (stored + deflate). No zip64. */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  // Scan backwards for the End Of Central Directory record (its comment can be 64 KiB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("未找到 zip 中央目录记录（EOCD）");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) throw new Error(`中央目录第 ${n} 项签名错误`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`本地头签名错误: ${name}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, inflateRawSync(data));
    // other compression methods: skipped — Word only writes 0/8

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
