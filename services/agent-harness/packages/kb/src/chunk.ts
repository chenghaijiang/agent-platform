/**
 * Structure-aware chunking (design doc §5.2: ~512 token, 10% overlap, heading hierarchy kept).
 *
 * Strategy:
 *   markdown → split on ATX headings (fence-aware), rebuild the heading stack per section,
 *              then pack paragraphs into windows of ~2048 chars (≈512 tokens) with 10% overlap.
 *   others   → blank-line paragraphs packed the same way.
 *
 * Every chunk carries {source, path, heading, index} so retrieval can cite "file §section".
 */
import type { DocType, ParsedDoc } from "./parse.js";

/** ~2048 UTF-16 chars ≈ 512 tokens for mixed CJK/latin text. */
export const CHUNK_MAX_CHARS = 2048;
/** 10% overlap so a sentence split across the boundary stays recoverable. */
export const CHUNK_OVERLAP_CHARS = Math.round(CHUNK_MAX_CHARS * 0.1);

/** Chunking knobs for the admin UI; both optional, both clamped before use. */
export interface ChunkOptions {
  /** Window size in UTF-16 chars (clamped 200..16000). Default CHUNK_MAX_CHARS. */
  maxChars?: number;
  /** Overlap tail in chars (clamped 0..max/2). Default 10% of the effective max. */
  overlapChars?: number;
}

const CHUNK_MIN_CHARS = 200;
const CHUNK_HARD_MAX_CHARS = 16000;

/** Resolve user knobs to concrete packing numbers — raw input is never trusted. */
export function resolveChunkOptions(opts?: ChunkOptions): { max: number; overlap: number } {
  const max = Math.min(Math.max(Math.round(opts?.maxChars ?? CHUNK_MAX_CHARS), CHUNK_MIN_CHARS), CHUNK_HARD_MAX_CHARS);
  const requested = opts?.overlapChars;
  const overlap = Math.min(
    Math.max(Math.round(requested ?? max * 0.1), 0),
    Math.floor(max / 2),
  );
  return { max, overlap };
}

export interface Chunk {
  /** Source file (absolute path). */
  source: string;
  /** Heading breadcrumb, e.g. "安装 > 配置" ("" when the text has no headings). */
  path: string;
  /** Nearest heading text ("" when outside any section). */
  heading: string;
  /** 0-based position within the source document. */
  index: number;
  /** Text that actually gets embedded and cited (heading line included as context). */
  text: string;
}

interface Section {
  heading: string;
  path: string;
  level: number;
  body: string;
}

/** Chunk a parsed document; `opts` overrides the default window size / overlap. */
export function chunkDocument(doc: ParsedDoc, opts?: ChunkOptions): Chunk[] {
  const { max, overlap } = resolveChunkOptions(opts);
  const sections = doc.type === "markdown" ? splitMarkdown(doc.text) : [{ heading: "", path: "", level: 0, body: doc.text }];
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const blocks = toBlocks(section.body);
    if (!blocks.length) continue;
    const prefix = section.heading ? `${"#".repeat(section.level)} ${section.heading}` : "";
    for (const piece of packBlocks(blocks, max, overlap)) {
      chunks.push({
        source: doc.source,
        path: section.path,
        heading: section.heading,
        index: chunks.length,
        text: prefix ? `${prefix}\n\n${piece}` : piece,
      });
    }
  }
  return chunks;
}

/** Convenience wrapper for inline text (tests / pasted snippets). */
export function chunkText(text: string, source = "<inline>", type: DocType = "text"): Chunk[] {
  return chunkDocument({ source, name: source, type, text });
}

/** Split markdown into heading-delimited sections, ignoring `#` inside fenced code. */
export function splitMarkdown(text: string): Section[] {
  const lines = text.split("\n");
  const stack: { level: number; title: string }[] = [];
  const sections: Section[] = [];
  let buf: string[] = [];
  let heading = "";
  let path = "";
  let level = 0;
  let inFence = false;

  const flush = (): void => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ heading, path, level, body });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const match = inFence ? null : /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!match) {
      buf.push(line);
      continue;
    }
    flush();
    level = (match[1] ?? "#").length;
    heading = (match[2] ?? "").trim();
    while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title: heading });
    path = stack.map((s) => s.title).join(" > ");
  }
  flush();
  return sections;
}

function toBlocks(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Greedy paragraph packing with an overlap tail carried from the previous window. */
function packBlocks(blocks: string[], max: number, overlap: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const block of blocks) {
    const pieces = block.length <= max ? [block] : sliceBlock(block, max, overlap);
    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }
      if (current.length + 2 + piece.length <= max) {
        current = `${current}\n\n${piece}`;
        continue;
      }
      out.push(current);
      const tail = overlapTail(current, overlap);
      current = tail && tail.length + 2 + piece.length <= max ? `${tail}\n\n${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Hard-slice an oversized paragraph, preferring line boundaries and keeping the overlap. */
function sliceBlock(block: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < block.length) {
    let end = Math.min(start + max, block.length);
    if (end < block.length) {
      const newline = block.lastIndexOf("\n", end);
      if (newline > start + max / 2) end = newline + 1;
    }
    const piece = block.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= block.length) break;
    const next = end - overlap;
    start = next > start ? next : end; // overlap must never stall the cursor
  }
  return out;
}

/** Last `overlap` chars of a window, trimmed to a clean line start. */
function overlapTail(text: string, overlap: number): string {
  if (text.length <= overlap) return text;
  const tail = text.slice(text.length - overlap);
  const newline = tail.indexOf("\n");
  return (newline >= 0 ? tail.slice(newline + 1) : tail).trim();
}
