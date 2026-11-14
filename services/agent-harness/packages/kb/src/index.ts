/**
 * @harness/kb — M6 knowledge base (design doc §5.1–5.3).
 *
 * Ingest local docs → chunk → embed (Ollama) → Qdrant vectors + SQLite FTS5;
 * video/audio through ffmpeg + whisper.cpp + a local vision model, with timestamps kept;
 * search with hybrid retrieval and citations, degrading to keyword-only when Qdrant is down.
 */
export {
  KnowledgeBase,
  KbError,
  DEFAULT_KB_DB_PATH,
  RECALL_LIMIT,
  expandPaths,
  alignTimeline,
  parseTimeRange,
  lazyKnowledgeBase,
  type KbErrorCode,
  type KnowledgeBaseOptions,
  type IngestOptions,
  type KbIngestProgress,
  type KbRemoveResult,
  type KbPreview,
  type KbPreviewChunk,
  type SearchMode,
  type SearchHit,
  type SearchResult,
  type IngestFailure,
  type IngestReport,
  type ReadResult,
  type KbStats,
  type FrameCaption,
  type KbQueryApi,
  type KbAdminApi,
  type LazyKnowledgeBase,
} from "./kb.js";
export { registerKbTools, formatCitation, KB_SEARCH_TOOL, KB_READ_TOOL, type ToolRegistrar, type KbSearchInput, type KbReadInput } from "./tools.js";
export {
  probeMedia,
  extractFrames,
  extractAudio,
  classifyMedia,
  isMediaFile,
  mediaExtensions,
  createMediaTempDir,
  removeMediaTempDir,
  formatTimestamp,
  formatTimeRange,
  MediaError,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  FFMPEG_HINT,
  DEFAULT_FRAME_LIMIT,
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_SCENE_THRESHOLD,
  type MediaKind,
  type MediaProbe,
  type MediaErrorCode,
  type ExtractedFrame,
  type ExtractFramesOptions,
  type FrameExtraction,
} from "./media.js";
export {
  transcribeAudio,
  TranscribeError,
  DEFAULT_WHISPER_BIN,
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODEL_HINT,
  type Transcript,
  type TranscriptSegment,
  type TranscribeOptions,
  type TranscribeErrorCode,
} from "./transcribe.js";
export {
  captionFrame,
  CaptionError,
  DEFAULT_VISION_MODEL,
  CAPTION_PROMPT,
  type CaptionOptions,
  type CaptionResult,
} from "./caption.js";
export { parseFile, classifyFile, normalizeText, supportedExtensions, ParseError, DEFERRED_FORMAT_MESSAGE, type DocType, type ParsedDoc, type FileKind, type ParseErrorCode } from "./parse.js";
export { chunkDocument, chunkText, splitMarkdown, resolveChunkOptions, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, type Chunk, type ChunkOptions } from "./chunk.js";
export { cleanText, type CleanOptions } from "./clean.js";
export {
  OllamaEmbedder,
  EmbeddingError,
  DEFAULT_OLLAMA_URL,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_DIM,
  type Embedder,
  type EmbeddingErrorCode,
  type OllamaEmbedderOptions,
} from "./embed.js";
export {
  QdrantClient,
  QdrantError,
  DEFAULT_QDRANT_URL,
  DEFAULT_COLLECTION,
  DEFAULT_VECTOR_SIZE,
  QDRANT_START_HINT,
  type QdrantErrorCode,
  type QdrantPoint,
  type QdrantHit,
  type QdrantHealth,
  type QdrantClientOptions,
  type DistanceMetric,
} from "./qdrant.js";
export {
  KbStore,
  type FtsMode,
  type SourceRecord,
  type ChunkInput,
  type StoredChunk,
  type KeywordHit,
  type ReplaceResult,
  type StoreStats,
  type TimeWindow,
} from "./store.js";
