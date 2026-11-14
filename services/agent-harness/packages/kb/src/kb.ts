/**
 * KnowledgeBase — the M6 facade (design doc §5.2 + §5.3).
 *
 * Ingest:  expand paths → route by extension
 *            documents → parse → chunk
 *            video     → ffprobe → scene frames → vision captions → audio → Whisper → align
 *            audio     → audio → Whisper → group into ~512-token windows
 *            image     → vision caption
 *          → SQLite (metadata + FTS) → Ollama embed → Qdrant upsert.
 * Search:  Qdrant vector top-20 ∪ FTS5 keyword top-20 → normalized fusion → top-K with citations.
 *
 * Degradation is a first-class path, not an afterthought: the knowledge base is useful with
 * Qdrant/Ollama offline (keyword-only), and unusable states raise structured KbError instead of
 * returning silently empty results. A failed frame caption or missing ffmpeg never poisons the
 * text half of the index.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { captionFrame, DEFAULT_VISION_MODEL, type CaptionResult } from "./caption.js";
import { chunkDocument, resolveChunkOptions, type Chunk, type ChunkOptions } from "./chunk.js";
import { cleanText, type CleanOptions } from "./clean.js";
import {
  DEFAULT_EMBED_DIM,
  DEFAULT_EMBED_MODEL,
  DEFAULT_OLLAMA_URL,
  OllamaEmbedder,
  type Embedder,
} from "./embed.js";
import {
  classifyMedia,
  createMediaTempDir,
  extractAudio,
  extractFrames,
  formatTimeRange,
  formatTimestamp,
  isMediaFile,
  MediaError,
  probeMedia,
  removeMediaTempDir,
  type MediaKind,
} from "./media.js";
import { classifyFile, parseFile, ParseError } from "./parse.js";
import {
  DEFAULT_COLLECTION,
  DEFAULT_QDRANT_URL,
  DEFAULT_VECTOR_SIZE,
  QdrantClient,
  type DistanceMetric,
  type QdrantHit,
} from "./qdrant.js";
import { KbStore, type ChunkInput, type KeywordHit, type StoreStats, type TimeWindow } from "./store.js";
import { transcribeAudio, DEFAULT_WHISPER_MODEL, TranscribeError, type Transcript, type TranscriptSegment } from "./transcribe.js";

/**
 * SQLite file for sources/chunks/FTS. `HARNESS_KB_DB` overrides it — needed when the home directory
 * is not writable by the calling process (sandboxed agent shells), and handy for per-project corpora.
 */
export const DEFAULT_KB_DB_PATH =
  process.env["HARNESS_KB_DB"] ?? join(homedir(), ".harness", "knowledge", "kb.db");
/** Recall width per retrieval arm before fusion (design doc §5.2: top 20 ∪ top 20). */
export const RECALL_LIMIT = 20;
const VECTOR_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

export type KbErrorCode =
  | "KB_INVALID_INPUT"
  | "KB_SOURCE_NOT_FOUND"
  | "KB_SECTION_NOT_FOUND"
  | "KB_SEARCH_UNAVAILABLE"
  | "KB_INGEST_FAILED"
  | "KB_UNAVAILABLE";

export class KbError extends Error {
  readonly code: KbErrorCode;

  constructor(code: KbErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "KbError";
    this.code = code;
  }
}

export interface KnowledgeBaseOptions {
  /** SQLite file; ":memory:" for tests. Defaults to ~/.harness/knowledge/kb.db */
  dbPath?: string;
  qdrantUrl?: string;
  ollamaUrl?: string;
  collection?: string;
  vectorSize?: number;
  distance?: DistanceMetric;
  embedModel?: string;
  /** Injected for tests / alternative providers. */
  embedder?: Embedder;
  qdrant?: QdrantClient;
  store?: KbStore;
  log?: (message: string) => void;
  /** Files above this size are skipped with a warning instead of blowing up the index. */
  maxFileBytes?: number;
  /** Media files are far larger than documents — separate cap (default 2 GiB). */
  maxMediaBytes?: number;
  /** Vision model used to caption frames/images. */
  visionModel?: string;
  /** whisper.cpp ggml model path. */
  whisperModel?: string;
  /** Frames per video (default 40) and the minimum gap between them (default 5s). */
  frameLimit?: number;
  frameIntervalMs?: number;
  /** Test seams for the two slow external steps. */
  captioner?: (framePath: string) => Promise<CaptionResult>;
  transcriber?: (wavPath: string) => Promise<Transcript>;
}

export type SearchMode = "hybrid" | "fts_only";

export interface SearchHit {
  /** Absolute path of the source document. */
  source: string;
  /** Heading breadcrumb ("安装 > 配置"); "" when the chunk has no heading. */
  heading: string;
  chunkId: number;
  chunkIndex: number;
  text: string;
  /** Fused score in [0,1]-ish space (weights 0.6 vector / 0.4 keyword). */
  score: number;
  /** Media timeline — present only for video/audio chunks. */
  startMs?: number;
  endMs?: number;
  /** "video" / "audio" / "image" for media chunks. */
  kind?: string;
  /** "filename" when the hit was recalled by matching the source path, not content. */
  matchedBy?: "filename";
  vectorScore?: number;
  keywordScore?: number;
}

export interface SearchResult {
  mode: SearchMode;
  hits: SearchHit[];
  /** Present when the vector arm was skipped — the caller should surface this. */
  degraded?: { code: string; message: string };
}

export interface IngestFailure {
  path: string;
  code: string;
  message: string;
}

export interface IngestReport {
  added: string[];
  updated: string[];
  skipped: string[];
  failed: IngestFailure[];
  /** Non-fatal degradations (vector arm unavailable, oversized file, ...). */
  warnings: string[];
  chunks: number;
  vectors: number;
  mode: SearchMode;
}

export interface ReadResult {
  source: string;
  heading?: string;
  chunkCount: number;
  text: string;
  /** Echo of the requested window when `timeRange` was used. */
  timeRange?: { fromMs: number; toMs: number };
}

export interface KbStats extends StoreStats {
  vector: { ok: boolean; url: string; collection: string; error?: string };
}

/** Per-ingest knobs; `force` re-indexes even when mtime+hash are unchanged. */
export interface IngestOptions {
  signal?: AbortSignal;
  force?: boolean;
  /** Text cleaning applied to documents before hashing/chunking (media untouched). */
  clean?: CleanOptions;
  /** Chunking window/overlap overrides for documents (media pipelines keep their own). */
  chunk?: ChunkOptions;
  /** Per-file progress for background job UIs. Fired when a file starts being processed. */
  onProgress?: (progress: KbIngestProgress) => void;
}

export interface KbIngestProgress {
  file: string;
  index: number;
  total: number;
  /** document = parse+chunk+index; media = ffmpeg/vision/whisper pipeline (slow). */
  kind: "document" | "media";
}

/** Result of KnowledgeBase.removeSource() — admin UI feedback. */
export interface KbRemoveResult {
  removed: boolean;
  vectorsDropped: boolean;
  warning?: string;
}

/** One chunk of a previewIngest() dry run — text truncated for display. */
export interface KbPreviewChunk {
  index: number;
  /** Heading breadcrumb of the section this chunk belongs to. */
  heading: string;
  /** Full chunk size in chars (display only; `text` is a 160-char excerpt). */
  chars: number;
  text: string;
}

/** previewIngest() result — shows what an ingest *would* produce, before it runs. */
export interface KbPreview {
  file: string;
  type: string;
  originalChars: number;
  cleanedChars: number;
  chunkCount: number;
  /** Effective (clamped) window size and overlap the ingest would use. */
  maxChars: number;
  overlapChars: number;
  chunks: KbPreviewChunk[];
}

export class KnowledgeBase {
  private readonly store: KbStore;
  private readonly embedder: Embedder;
  private readonly qdrant: QdrantClient;
  private readonly collection: string;
  private readonly vectorSize: number;
  private readonly distance: DistanceMetric;
  private readonly log: (message: string) => void;
  private readonly maxFileBytes: number;
  private readonly maxMediaBytes: number;
  private readonly ollamaUrl: string;
  private readonly visionModel: string;
  private readonly whisperModel: string;
  private readonly frameLimit: number;
  private readonly frameIntervalMs: number;
  private readonly captionerOverride?: (framePath: string) => Promise<CaptionResult>;
  private readonly transcriberOverride?: (wavPath: string) => Promise<Transcript>;

  constructor(options: KnowledgeBaseOptions = {}) {
    this.store = options.store ?? new KbStore(options.dbPath ?? DEFAULT_KB_DB_PATH);
    this.ollamaUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    this.embedder =
      options.embedder ??
      new OllamaEmbedder(this.ollamaUrl, {
        model: options.embedModel ?? DEFAULT_EMBED_MODEL,
        dim: options.vectorSize ?? DEFAULT_EMBED_DIM,
      });
    this.qdrant = options.qdrant ?? new QdrantClient(options.qdrantUrl ?? DEFAULT_QDRANT_URL);
    this.collection = options.collection ?? DEFAULT_COLLECTION;
    this.vectorSize = options.vectorSize ?? DEFAULT_VECTOR_SIZE;
    this.distance = options.distance ?? "Cosine";
    this.log = options.log ?? ((message) => console.warn(`[kb] ${message}`));
    this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxMediaBytes = options.maxMediaBytes ?? 2 * 1024 * 1024 * 1024;
    this.visionModel = options.visionModel ?? DEFAULT_VISION_MODEL;
    this.whisperModel = options.whisperModel ?? DEFAULT_WHISPER_MODEL;
    this.frameLimit = options.frameLimit ?? 40;
    this.frameIntervalMs = options.frameIntervalMs ?? 5_000;
    if (options.captioner) this.captionerOverride = options.captioner;
    if (options.transcriber) this.transcriberOverride = options.transcriber;
  }

  /**
   * Ingest files or directories, routing by extension: documents → parse+chunk, video →
   * probe+caption+transcribe+align, audio → transcribe, image → caption.
   * Unchanged files (same mtime + content hash) are skipped; changed files replace their
   * old chunks and Qdrant points so the index cannot drift.
   */
  async ingest(paths: string[], opts: IngestOptions = {}): Promise<IngestReport> {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new KbError("KB_INVALID_INPUT", "ingest 需要至少一个文件或目录路径");
    }
    const files = expandPaths(paths);
    const report: IngestReport = {
      added: [],
      updated: [],
      skipped: [],
      failed: [],
      warnings: [],
      chunks: 0,
      vectors: 0,
      mode: "fts_only",
    };
    const vectorArm = await this.prepareVectorArm(report);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      try {
        const mediaKind = classifyMedia(file);
        opts.onProgress?.({ file, index: i + 1, total: files.length, kind: mediaKind ? "media" : "document" });
        if (mediaKind) await this.ingestMedia(file, mediaKind, report, vectorArm, opts);
        else await this.ingestDocument(file, report, vectorArm, opts);
      } catch (err) {
        report.failed.push({
          path: file,
          code: errorCodeOf(err),
          message: messageOf(err),
        });
      }
    }

    return report;
  }

  /** Text-shaped documents: parse → chunk → index. */
  private async ingestDocument(
    file: string,
    report: IngestReport,
    vectorArm: boolean,
    opts: IngestOptions,
  ): Promise<void> {
    const stat = statSync(file);
    if (stat.size > this.maxFileBytes) {
      report.skipped.push(file);
      report.warnings.push(`${file} 超过 ${this.maxFileBytes} 字节上限，已跳过`);
      return;
    }

    // Cleaning runs before hashing: changing options re-indexes the file, and the
    // store keeps only the cleaned form — the raw text never enters the index.
    const doc = parseFile(file);
    const text = opts.clean ? cleanText(doc.text, opts.clean) : doc.text;
    const hash = sha256(text);
    const mtime = Math.round(stat.mtimeMs);
    if (!opts.force && this.store.isUnchanged(file, mtime, hash)) {
      report.skipped.push(file);
      return;
    }

    const chunks = chunkDocument({ ...doc, text }, opts.chunk);
    await this.indexChunks(
      file,
      doc.type,
      doc.name,
      mtime,
      hash,
      toChunkInputs(chunks),
      report,
      vectorArm,
      opts,
    );
  }

  /** Video / audio / image: derive text chunks from the media pipeline, then index them. */
  private async ingestMedia(
    file: string,
    kind: MediaKind,
    report: IngestReport,
    vectorArm: boolean,
    opts: IngestOptions,
  ): Promise<void> {
    const stat = statSync(file);
    if (stat.size > this.maxMediaBytes) {
      report.skipped.push(file);
      report.warnings.push(`${file} 超过媒体上限 ${this.maxMediaBytes} 字节，已跳过（maxMediaBytes 可调）`);
      return;
    }

    const mtime = Math.round(stat.mtimeMs);
    // Captions/transcripts are model-generated and expensive: size+mtime is the cheap identity,
    // and re-running the whole pipeline to prove "same file" would defeat the skip.
    const hash = `media:${kind}:${stat.size}:${mtime}`;
    if (!opts.force && this.store.isUnchanged(file, mtime, hash)) {
      report.skipped.push(file);
      return;
    }

    const chunks =
      kind === "video"
        ? await this.buildVideoChunks(file, report, opts)
        : kind === "audio"
          ? await this.buildAudioChunks(file, report, opts)
          : await this.buildImageChunks(file, report, opts);

    await this.indexChunks(file, kind, basename(file), mtime, hash, chunks, report, vectorArm, opts);
  }

  /**
   * Video: scene frames → vision captions, audio → Whisper, then timeline alignment.
   * A failed transcript degrades to visual-only coverage instead of failing the file.
   */
  private async buildVideoChunks(
    file: string,
    report: IngestReport,
    opts: IngestOptions,
  ): Promise<ChunkInput[]> {
    const probe = await probeMedia(file);
    if (!probe.hasVideo) return this.buildAudioChunks(file, report, opts);

    const workDir = await createMediaTempDir("harness-video-");
    try {
      const { frames } = await extractFrames(file, {
        tempDir: workDir,
        maxFrames: this.frameLimit,
        minIntervalMs: this.frameIntervalMs,
      });

      const captions: FrameCaption[] = [];
      for (const frame of frames) {
        throwIfAborted(opts.signal);
        const result = await this.captionFrame(frame.path, opts);
        if (result.caption) {
          captions.push({ atMs: frame.atMs, caption: result.caption });
        } else {
          report.warnings.push(
            `${basename(file)} @ ${formatTimestamp(frame.atMs)} 画面描述失败，已跳过: ${result.error ?? "未知原因"}`,
          );
        }
      }

      let segments: TranscriptSegment[] = [];
      if (probe.hasAudio) {
        try {
          const wav = await extractAudio(file, { tempDir: workDir });
          const transcript = await this.transcribe(wav, opts);
          segments = transcript.segments;
          if (!segments.length) {
            report.warnings.push(`${basename(file)} 音轨没有可转写的语音（可能是纯音乐/静音）`);
          }
        } catch (err) {
          report.warnings.push(`${basename(file)} 音轨转写失败，仅索引画面描述: ${messageOf(err)}`);
        }
      } else {
        report.warnings.push(`${basename(file)} 没有音轨，仅索引画面描述`);
      }

      return alignTimeline({
        name: basename(file),
        kind: "video",
        durationMs: probe.durationMs,
        captions,
        segments,
      });
    } finally {
      removeMediaTempDir(workDir);
    }
  }

  /** Audio: 16 kHz mono wav → Whisper → ~512-token windows carrying startMs/endMs. */
  private async buildAudioChunks(
    file: string,
    report: IngestReport,
    opts: IngestOptions,
  ): Promise<ChunkInput[]> {
    const workDir = await createMediaTempDir("harness-audio-");
    try {
      const wav = await extractAudio(file, { tempDir: workDir });
      const transcript = await this.transcribe(wav, opts);
      if (!transcript.segments.length) {
        report.warnings.push(`${basename(file)} 未转写出任何语音，文件未入库`);
        return [];
      }
      return alignTimeline({
        name: basename(file),
        kind: "audio",
        durationMs: transcript.durationMs,
        captions: [],
        segments: transcript.segments,
      });
    } finally {
      removeMediaTempDir(workDir);
    }
  }

  /** Image: one vision caption; a failed caption still indexes the file name. */
  private async buildImageChunks(
    file: string,
    report: IngestReport,
    opts: IngestOptions,
  ): Promise<ChunkInput[]> {
    const name = basename(file);
    const result = await this.captionFrame(file, opts);
    if (!result.caption) {
      report.warnings.push(`${name} 图片描述失败，仅按文件名索引: ${result.error ?? "未知原因"}`);
    }
    const header = `[图片] ${name}`;
    return [
      {
        heading: "图片",
        index: 0,
        text: result.caption ? `${header}\n${result.caption}` : header,
        kind: "image",
      },
    ];
  }

  /** Persist chunks (SQLite + FTS) then push vectors; the vector arm may degrade to FTS-only. */
  private async indexChunks(
    source: string,
    type: string,
    name: string,
    mtime: number,
    hash: string,
    chunks: ChunkInput[],
    report: IngestReport,
    vectorArm: boolean,
    opts: IngestOptions,
  ): Promise<void> {
    if (!chunks.length) {
      report.failed.push({ path: source, code: "EMPTY_DOCUMENT", message: `${source} 未产生任何可索引块` });
      return;
    }

    const { chunkIds, replaced } = this.store.replaceSource(source, type, mtime, hash, chunks);
    report.chunks += chunks.length;
    (replaced ? report.updated : report.added).push(source);

    if (!vectorArm) return;
    try {
      const vectors = await this.embedder.embedBatch(
        chunks.map((chunk) => chunk.text),
        { signal: opts.signal },
      );
      await this.qdrant.deleteBySource(this.collection, source);
      await this.qdrant.upsert(this.collection, buildPoints(source, name, type, chunks, chunkIds, vectors));
      report.vectors += chunks.length;
    } catch (err) {
      // Full text is already durable — losing only the vector arm is a degradation.
      report.mode = "fts_only";
      report.warnings.push(`${source} 向量化失败，已退化为仅全文索引: ${messageOf(err)}`);
    }
  }

  private async captionFrame(framePath: string, opts: IngestOptions): Promise<CaptionResult> {
    if (this.captionerOverride) return this.captionerOverride(framePath);
    return captionFrame(framePath, {
      model: this.visionModel,
      ollamaUrl: this.ollamaUrl,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  private async transcribe(wavPath: string, opts: IngestOptions): Promise<Transcript> {
    if (this.transcriberOverride) return this.transcriberOverride(wavPath);
    return transcribeAudio(wavPath, {
      model: this.whisperModel,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Hybrid retrieval. Qdrant/Ollama offline → keyword-only with `mode: "fts_only"`.
   * Both arms broken → structured KB_SEARCH_UNAVAILABLE.
   */
  async search(query: string, topK = 5, opts: { signal?: AbortSignal } = {}): Promise<SearchResult> {
    const trimmed = query.trim();
    if (!trimmed) throw new KbError("KB_INVALID_INPUT", "search 需要非空 query");
    const limit = Math.min(Math.max(Math.trunc(topK), 1), 50);

    let keywordHits: KeywordHit[] = [];
    let keywordError: unknown;
    try {
      keywordHits = this.store.keywordSearch(trimmed, RECALL_LIMIT);
    } catch (err) {
      keywordError = err;
    }

    let vectorHits: QdrantHit[] = [];
    let vectorError: string | undefined;
    const health = await this.qdrant.health();
    if (!health.ok) {
      vectorError = `Qdrant 不可用（${health.url}）: ${health.error ?? "连接失败"}`;
    } else {
      try {
        const vector = await this.embedder.embed(trimmed, opts.signal);
        vectorHits = await this.qdrant.search(this.collection, vector, RECALL_LIMIT);
      } catch (err) {
        vectorError = messageOf(err);
      }
    }

    if (keywordError !== undefined && vectorHits.length === 0) {
      throw new KbError(
        "KB_SEARCH_UNAVAILABLE",
        `知识库检索不可用：全文索引失败（${messageOf(keywordError)}）；向量检索失败（${vectorError ?? "健康检查未通过"}）`,
        keywordError,
      );
    }

    const fused = fuseHits(vectorHits, keywordHits).slice(0, limit);
    const stored = this.store.getChunksByIds(fused.map((item) => item.chunkId));
    const hits: SearchHit[] = [];
    for (const item of fused) {
      const chunk = stored.get(item.chunkId);
      if (!chunk) continue;
      const hit: SearchHit = {
        source: chunk.sourcePath,
        heading: chunk.heading,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        text: chunk.text,
        score: round(item.score),
      };
      if (chunk.startMs !== undefined) hit.startMs = chunk.startMs;
      if (chunk.endMs !== undefined) hit.endMs = chunk.endMs;
      if (chunk.kind) hit.kind = chunk.kind;
      if (item.vectorScore !== undefined) hit.vectorScore = round(item.vectorScore);
      if (item.keywordScore !== undefined) hit.keywordScore = round(item.keywordScore);
      hits.push(hit);
    }
    hits.push(...this.filenameHits(trimmed, hits, limit));

    const result: SearchResult = { mode: vectorError ? "fts_only" : "hybrid", hits };
    if (vectorError) result.degraded = { code: "QDRANT_DEGRADED", message: vectorError };
    return result;
  }

  /**
   * Intent-style queries ("查看我的简历") often miss: the resume's *content* never says
   * "简历", so both vector and FTS return lookalike notes instead. The file *name* is the
   * missing signal — scan indexed paths for query terms and surface those sources. Terms
   * are latin words (≥2 chars) plus every CJK substring of length 2..run-length, because
   * without a segmentation dictionary "我的简历" must be sliced into "我的"/"简历"/…
   * Cheap at personal scale (in-memory list of ~1k paths, plain substring tests).
   */
  private filenameHits(query: string, existing: SearchHit[], limit: number): SearchHit[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const seen = new Set(existing.map((hit) => hit.source));
    const extras: SearchHit[] = [];
    for (const source of this.store.listSources()) {
      if (extras.length >= Math.min(3, Math.max(1, limit - existing.length))) break;
      const lowerPath = source.path.toLowerCase();
      const matched = terms.find((term) => lowerPath.includes(term));
      if (!matched || seen.has(source.path)) continue;
      seen.add(source.path);
      const chunks = this.store.readChunks(source.path);
      const chunk = chunks[0];
      if (!chunk) continue;
      const hit: SearchHit = {
        source: chunk.sourcePath,
        heading: chunk.heading,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        text: chunk.text,
        // Fixed boost below typical fused winners: filename evidence, not content evidence.
        score: round(0.45),
        matchedBy: "filename",
      };
      if (chunk.kind) hit.kind = chunk.kind;
      extras.push(hit);
    }
    return extras;
  }

  /**
   * Full text of a source, or just one section ("安装 > 配置" / "配置"), or one time window
   * of a media source ("12:00-14:30"). Media chunks are selected by timeline overlap.
   */
  async read(sourcePath: string, heading?: string, timeRange?: string): Promise<ReadResult> {
    if (!sourcePath || !sourcePath.trim()) throw new KbError("KB_INVALID_INPUT", "read 需要 sourcePath");
    const source = this.store.findSource(sourcePath.trim());
    if (!source) {
      const known = this.store.listSources().slice(0, 10).map((s) => s.path);
      const hint = known.length ? `已导入的来源示例: ${known.join(", ")}` : "知识库为空，请先 ingest";
      throw new KbError("KB_SOURCE_NOT_FOUND", `知识库中没有来源 "${sourcePath}"。${hint}`);
    }
    const section = heading?.trim();
    const window = timeRange?.trim() ? parseTimeRange(timeRange) : undefined;
    const chunks = this.store.readChunks(source.path, section, window);
    if (!chunks.length) {
      const scope = [
        section ? `章节 "${section}"` : "",
        window ? `时间区间 ${timeRange}` : "",
      ].filter((part) => part.length > 0);
      throw new KbError(
        "KB_SECTION_NOT_FOUND",
        `来源 ${source.path} 中没有匹配${scope.length ? ` ${scope.join(" / ")} 的` : ""}内容；` +
          `已索引章节: ${summarizeHeadings(this.store.readChunks(source.path))}`,
      );
    }
    const result: ReadResult = {
      source: source.path,
      heading: section,
      chunkCount: chunks.length,
      text: chunks.map((chunk) => chunk.text).join("\n\n"),
    };
    if (window) result.timeRange = window;
    return result;
  }

  /** All indexed sources (path, type, mtime, chunkCount) for the admin UI. */
  listSources(): Array<{ id: number; path: string; type: string; mtime: number; chunkCount: number }> {
    return this.store.listSources().map(({ id, path, type, mtime, chunkCount }) => ({ id, path, type, mtime, chunkCount }));
  }

  /**
   * Dry-run of clean+chunk for one document file — no writes anywhere. Powers the
   * admin "预览切片" so the user can sanity-check cleaning and window size before
   * committing an ingest. Media files have no text to preview up front.
   */
  previewIngest(file: string, opts: { clean?: CleanOptions; chunk?: ChunkOptions } = {}): KbPreview {
    if (classifyMedia(file)) {
      throw new KbError("KB_INVALID_INPUT", "媒体文件（视频/音频/图片）走转写/画面描述流水线，不支持导入前文本切片预览");
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new KbError("KB_INVALID_INPUT", `预览路径不存在: ${file}`);
    }
    if (!stat.isFile()) throw new KbError("KB_INVALID_INPUT", `预览需要单个文件路径，收到: ${file}`);
    if (stat.size > this.maxFileBytes) {
      throw new KbError("KB_INVALID_INPUT", `文件超过导入上限 ${this.maxFileBytes} 字节: ${file}`);
    }

    const doc = parseFile(file);
    const text = opts.clean ? cleanText(doc.text, opts.clean) : doc.text;
    const { max, overlap } = resolveChunkOptions(opts.chunk);
    const chunks = chunkDocument({ ...doc, text }, opts.chunk);
    const preview: KbPreview = {
      file,
      type: doc.type,
      originalChars: doc.text.length,
      cleanedChars: text.length,
      chunkCount: chunks.length,
      maxChars: max,
      overlapChars: overlap,
      chunks: chunks.slice(0, 8).map((chunk) => ({
        index: chunk.index,
        heading: chunk.path || chunk.heading,
        chars: chunk.text.length,
        text: chunk.text.slice(0, 160),
      })),
    };
    return preview;
  }

  /**
   * Admin: remove one source from the index. SQLite rows go first (source of
   * truth for text/citations); Qdrant vectors are dropped best-effort — if the
   * vector arm is unreachable the stale points are harmless (their chunk ids no
   * longer resolve) and will be overwritten by a future re-ingest of the path.
   */
  async removeSource(path: string): Promise<KbRemoveResult> {
    const removed = this.store.removeSource(path);
    if (!removed) return { removed: false, vectorsDropped: false };

    let vectorsDropped = false;
    let warning: string | undefined;
    try {
      const health = await this.qdrant.health();
      if (health.ok) {
        await this.qdrant.deleteBySource(this.collection, path);
        vectorsDropped = true;
      } else {
        warning = `Qdrant 不可用，残留向量将在重新导入该路径时被覆盖: ${health.error ?? "连接失败"}`;
      }
    } catch (err) {
      warning = `向量删除失败（全文索引已移除）: ${messageOf(err)}`;
    }
    this.log(`已移除来源: ${path}${vectorsDropped ? "（含向量）" : "（仅全文索引）"}`);
    return { removed: true, vectorsDropped, ...(warning ? { warning } : {}) };
  }

  async stats(): Promise<KbStats> {
    const base = this.store.stats();
    const health = await this.qdrant.health();
    return {
      ...base,
      vector: {
        ok: health.ok,
        url: health.url,
        collection: this.collection,
        ...(health.error ? { error: health.error } : {}),
      },
    };
  }

  close(): void {
    this.store.close();
  }

  /** Ensure the collection exists and the vector arm is usable; otherwise degrade quietly. */
  private async prepareVectorArm(report: IngestReport): Promise<boolean> {
    const health = await this.qdrant.health();
    if (!health.ok) {
      report.warnings.push(`Qdrant 不可用（${health.url}），本次仅写入全文索引: ${health.error ?? "连接失败"}`);
      return false;
    }
    try {
      const created = await this.qdrant.ensureCollection(this.collection, this.vectorSize, this.distance);
      if (created) this.log(`已创建 Qdrant collection "${this.collection}" (${this.vectorSize}d, ${this.distance})`);
      report.mode = "hybrid";
      return true;
    } catch (err) {
      report.warnings.push(`Qdrant collection 准备失败，仅写入全文索引: ${messageOf(err)}`);
      return false;
    }
  }
}

/** Recursively expand files/directories; unknown extensions are filtered out early. */
export function expandPaths(inputs: string[]): string[] {
  const files = new Set<string>();
  const missing: string[] = [];

  for (const input of inputs) {
    const target = resolve(input);
    let stat;
    try {
      stat = statSync(target);
    } catch {
      missing.push(input);
      continue;
    }
    if (stat.isFile()) {
      files.add(target);
    } else if (stat.isDirectory()) {
      for (const file of walkDirectory(target)) files.add(file);
    } else {
      missing.push(input);
    }
  }

  if (missing.length) {
    throw new KbError("KB_INVALID_INPUT", `路径不存在或不是普通文件/目录: ${missing.join(", ")}`);
  }
  if (!files.size) {
    throw new KbError(
      "KB_INVALID_INPUT",
      "没有找到可导入的文件（支持 .md/.txt/.csv/.pdf/.docx/.doc、常见源代码扩展名，以及 .mp4/.mov/.mkv/.webm/.m4v 视频、" +
        ".mp3/.wav/.m4a/.flac/.ogg 音频、.png/.jpg/.jpeg/.webp 图片）",
    );
  }
  return [...files].sort();
}

function walkDirectory(root: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found; // unreadable directory: skip, never abort the whole ingest
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, .DS_Store, editor dirs
    if (entry.isSymbolicLink()) continue; // avoid cycles
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkDirectory(full));
      continue;
    }
    if (!entry.isFile()) continue;
    // Deferred formats (xlsx/pptx/...) stay in the list on purpose: ingest surfaces their
    // explicit "需要外部解析器" error instead of silently dropping them. Media files and
    // pdf/docx/doc are routed to their own pipelines, so they must survive this filter.
    if (classifyFile(full) === "unknown" && !isMediaFile(full)) continue;
    found.push(full);
  }
  return found;
}

interface FusedHit {
  chunkId: number;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

/** Min-max normalize each arm, then weighted merge; a hit found by both arms wins. */
function fuseHits(vectorHits: QdrantHit[], keywordHits: KeywordHit[]): FusedHit[] {
  const vectorScores = normalize(vectorHits.map((hit) => hit.score));
  const keywordScores = normalize(keywordHits.map((hit) => hit.score));
  const fused = new Map<number, FusedHit>();

  vectorHits.forEach((hit, index) => {
    const chunkId = payloadChunkId(hit);
    if (chunkId <= 0) return;
    const score = VECTOR_WEIGHT * (vectorScores[index] ?? 0);
    fused.set(chunkId, { chunkId, score, vectorScore: hit.score });
  });

  keywordHits.forEach((hit, index) => {
    const score = KEYWORD_WEIGHT * (keywordScores[index] ?? 0);
    const existing = fused.get(hit.chunkId);
    if (existing) {
      existing.score += score;
      existing.keywordScore = hit.score;
      return;
    }
    fused.set(hit.chunkId, { chunkId: hit.chunkId, score, keywordScore: hit.score });
  });

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

function payloadChunkId(hit: QdrantHit): number {
  const raw = hit.payload["chunkId"] ?? hit.id;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function normalize(values: number[]): number[] {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((value) => (value - min) / (max - min));
}

function buildPoints(
  source: string,
  sourceName: string,
  type: string,
  chunks: ChunkInput[],
  chunkIds: number[],
  vectors: number[][],
): { id: number; vector: number[]; payload: Record<string, unknown> }[] {
  const points: { id: number; vector: number[]; payload: Record<string, unknown> }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const id = chunkIds[i];
    const vector = vectors[i];
    if (!chunk || id === undefined || !vector) continue;
    const payload: Record<string, unknown> = {
      chunkId: id,
      source,
      sourceName,
      path: chunk.heading,
      heading: chunk.heading,
      index: chunk.index,
      type,
    };
    // Timeline survives the round-trip through Qdrant so payload-only clients keep timestamps.
    if (chunk.startMs !== undefined) payload["startMs"] = chunk.startMs;
    if (chunk.endMs !== undefined) payload["endMs"] = chunk.endMs;
    if (chunk.kind) payload["kind"] = chunk.kind;
    points.push({ id, vector, payload });
  }
  return points;
}

function toChunkInputs(chunks: Chunk[]): ChunkInput[] {
  return chunks.map((chunk) => ({
    // Breadcrumb is what citations print and what `read(path, heading)` matches on.
    heading: chunk.path || chunk.heading,
    index: chunk.index,
    text: chunk.text,
  }));
}

function summarizeHeadings(chunks: { heading: string }[]): string {
  const headings = [...new Set(chunks.map((chunk) => chunk.heading).filter((h) => h.length > 0))];
  if (!headings.length) return "(无标题段落)";
  return headings.slice(0, 12).join(" | ") + (headings.length > 12 ? " ..." : "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Errors from any layer keep their code so the CLI can print `EMPTY_DOCUMENT` vs `FFMPEG_MISSING`. */
function errorCodeOf(err: unknown): string {
  if (
    err instanceof ParseError ||
    err instanceof MediaError ||
    err instanceof TranscribeError ||
    err instanceof KbError
  ) {
    return err.code;
  }
  return "INGEST_FAILED";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KbError("KB_INGEST_FAILED", "ingest 已被取消");
}

// ---------------------------------------------------------------------------------------------
// media timeline alignment (design doc §5.3: "时间轴对齐（描述+转写文本均带时间戳）")
// ---------------------------------------------------------------------------------------------

export interface FrameCaption {
  atMs: number;
  caption: string;
}

interface TimelineWindow {
  startMs: number;
  endMs: number;
  captions: FrameCaption[];
  segments: TranscriptSegment[];
  chars: number;
}

/** ≈512 tokens of mixed CJK once captions are attached. */
const MEDIA_CHUNK_MAX_CHARS = 1600;
/** A window never spans more than two minutes — longer answers cite better. */
const MEDIA_WINDOW_MAX_MS = 120_000;
/** A silence longer than this starts a new window (speaker/topic change). */
const SEGMENT_GAP_MS = 20_000;
/** A frame belongs to a window when it falls just outside its speech bounds. */
const CAPTION_SLACK_MS = 3_000;
/** Frames without speech are grouped into 60s slices so a silent video is not one giant chunk. */
const CAPTION_BUCKET_MS = 60_000;
/** How long a caption "describes" the screen after the sampled frame. */
const CAPTION_HOLD_MS = 5_000;

/**
 * Merge the two timelines: transcript segments define speech windows, frame captions are
 * attached to the window they fall into, and leftover frames become visual-only windows.
 * Every resulting chunk carries an explicit [startMs, endMs].
 */
export function alignTimeline(input: {
  name: string;
  kind: "video" | "audio";
  durationMs: number;
  captions: FrameCaption[];
  segments: TranscriptSegment[];
}): ChunkInput[] {
  const speechWindows = groupSegments(input.segments);
  const orphans: FrameCaption[] = [];

  for (const caption of input.captions) {
    const host = speechWindows.find(
      (window) =>
        caption.atMs >= window.startMs - CAPTION_SLACK_MS && caption.atMs <= window.endMs + CAPTION_SLACK_MS,
    );
    if (host) host.captions.push(caption);
    else orphans.push(caption);
  }

  const windows = [...speechWindows, ...bucketCaptions(orphans)].sort((a, b) => a.startMs - b.startMs);
  return windows.map((window, index) => toMediaChunk(window, index, input));
}

function groupSegments(segments: TranscriptSegment[]): TimelineWindow[] {
  const windows: TimelineWindow[] = [];
  let current: TimelineWindow | undefined;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (current && fitsWindow(current, segment, text.length)) {
      current.segments.push(segment);
      current.endMs = Math.max(current.endMs, segment.endMs);
      current.chars += text.length;
      continue;
    }
    current = { startMs: segment.startMs, endMs: segment.endMs, captions: [], segments: [segment], chars: text.length };
    windows.push(current);
  }
  return windows;
}

function fitsWindow(window: TimelineWindow, segment: TranscriptSegment, chars: number): boolean {
  return (
    window.chars + chars <= MEDIA_CHUNK_MAX_CHARS &&
    segment.startMs - window.endMs <= SEGMENT_GAP_MS &&
    segment.endMs - window.startMs <= MEDIA_WINDOW_MAX_MS
  );
}

function bucketCaptions(captions: FrameCaption[]): TimelineWindow[] {
  const buckets = new Map<number, TimelineWindow>();
  for (const caption of [...captions].sort((a, b) => a.atMs - b.atMs)) {
    const key = Math.floor(caption.atMs / CAPTION_BUCKET_MS);
    const existing = buckets.get(key);
    if (existing) {
      existing.captions.push(caption);
      existing.endMs = Math.max(existing.endMs, caption.atMs + CAPTION_HOLD_MS);
      continue;
    }
    buckets.set(key, {
      startMs: caption.atMs,
      endMs: caption.atMs + CAPTION_HOLD_MS,
      captions: [caption],
      segments: [],
      chars: 0,
    });
  }
  return [...buckets.values()];
}

function toMediaChunk(
  window: TimelineWindow,
  index: number,
  input: { name: string; kind: "video" | "audio"; durationMs: number },
): ChunkInput {
  const startMs = Math.max(0, Math.round(window.startMs));
  const limit = input.durationMs > 0 ? input.durationMs : Number.POSITIVE_INFINITY;
  const endMs = Math.max(startMs + 1_000, Math.min(Math.round(window.endMs), limit));
  const heading = formatTimeRange(startMs, endMs);
  const lines: string[] = [`[${input.name} ${heading}]`];

  for (const caption of [...window.captions].sort((a, b) => a.atMs - b.atMs)) {
    lines.push(`【画面 ${formatTimestamp(caption.atMs)}】${caption.caption}`);
  }
  const speech = window.segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
  if (speech) lines.push(input.kind === "audio" ? `【转写】${speech}` : `【口播】${speech}`);

  return { heading, index, text: lines.join("\n"), startMs, endMs, kind: input.kind };
}

/** "12:00-14:30" / "1:02:03-1:03:00" / "120-180" (seconds) → a half-open ms window. */
const CLOCK_PATTERN = "(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{2})";
const RANGE_PATTERN = new RegExp(`^\\s*${CLOCK_PATTERN}\\s*[-~–]\\s*${CLOCK_PATTERN}\\s*$`);
const SECONDS_PATTERN = /^\s*(\d+)\s*[-~–]\s*(\d+)\s*$/;

export function parseTimeRange(value: string): TimeWindow {
  const clock = RANGE_PATTERN.exec(value);
  if (clock) {
    const fromMs = clockToMs(clock[1], clock[2], clock[3]);
    const toMs = clockToMs(clock[4], clock[5], clock[6]);
    if (toMs > fromMs) return { fromMs, toMs };
    throw new KbError("KB_INVALID_INPUT", `timeRange 起点必须早于终点: "${value}"`);
  }

  const seconds = SECONDS_PATTERN.exec(value);
  if (seconds) {
    const fromMs = Number(seconds[1]) * 1000;
    const toMs = Number(seconds[2]) * 1000;
    if (toMs > fromMs) return { fromMs, toMs };
    throw new KbError("KB_INVALID_INPUT", `timeRange 起点必须早于终点: "${value}"`);
  }

  throw new KbError(
    "KB_INVALID_INPUT",
    `timeRange 格式应为 "mm:ss-mm:ss"（如 "12:00-14:30"）或秒数区间（如 "120-180"），收到 "${value}"`,
  );
}

function clockToMs(hours: string | undefined, minutes: string | undefined, seconds: string | undefined): number {
  const h = hours ? Number(hours) : 0;
  const m = minutes ? Number(minutes) : 0;
  const s = seconds ? Number(seconds) : 0;
  return Math.round(((h * 60 + m) * 60 + s) * 1000);
}

/** Lowercase terms for path matching: latin/digit words ≥2 chars + CJK substrings of 2..n. */
function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const run of query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) terms.add(run);
      continue;
    }
    // CJK run: enumerate substrings, longest first (deduped by the Set).
    for (let len = run.length; len >= 2; len--) {
      for (let start = 0; start + len <= run.length; start++) terms.add(run.slice(start, start + len));
    }
  }
  return [...terms];
}

// ---------------------------------------------------------------------------------------------
// lazy facade — the CLI surfaces (chat REPL, tools) must not open kb.db at process start
// ---------------------------------------------------------------------------------------------

/** The read-only subset the tools need; KnowledgeBase satisfies it structurally. */
export interface KbQueryApi {
  search(query: string, topK?: number, opts?: { signal?: AbortSignal }): Promise<SearchResult>;
  read(sourcePath: string, heading?: string, timeRange?: string): Promise<ReadResult>;
  /** Indexed-source listing for the kb:sources discovery tool. */
  listSources(): Array<{ id: number; path: string; type: string; mtime: number; chunkCount: number }>;
}

export interface KbAdminApi extends KbQueryApi {
  ingest(paths: string[], opts?: IngestOptions): Promise<IngestReport>;
  removeSource(path: string): Promise<KbRemoveResult>;
  stats(): Promise<KbStats>;
  listSources(): Array<{ id: number; path: string; type: string; mtime: number; chunkCount: number }>;
  previewIngest(file: string, opts?: { clean?: CleanOptions; chunk?: ChunkOptions }): KbPreview;
  close(): void;
}

export interface LazyKnowledgeBase extends KbAdminApi {
  /** undefined until the first call actually touches the store. */
  readonly instance: KnowledgeBase | undefined;
}

/**
 * Defer construction until first use: `new KbStore(...)` creates directories and opens SQLite,
 * which an interactive `harness` session should not pay for until it actually searches.
 */
export function lazyKnowledgeBase(options: KnowledgeBaseOptions = {}): LazyKnowledgeBase {
  let instance: KnowledgeBase | undefined;
  const get = (): KnowledgeBase => {
    if (instance) return instance;
    try {
      instance = new KnowledgeBase(options);
      return instance;
    } catch (err) {
      throw new KbError("KB_UNAVAILABLE", `知识库初始化失败: ${messageOf(err)}`, err);
    }
  };

  return {
    get instance() {
      return instance;
    },
    search: (query, topK, opts) => get().search(query, topK, opts),
    read: (sourcePath, heading, timeRange) => get().read(sourcePath, heading, timeRange),
    ingest: (paths, opts) => get().ingest(paths, opts),
    removeSource: (path) => get().removeSource(path),
    stats: () => get().stats(),
    listSources: () => get().listSources(),
    previewIngest: (file, opts) => get().previewIngest(file, opts),
    close: () => {
      instance?.close();
      instance = undefined;
    },
  };
}
