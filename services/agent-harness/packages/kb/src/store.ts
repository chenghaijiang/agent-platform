/**
 * Metadata + full-text store — node:sqlite `DatabaseSync` (design doc §5.1: "SQLite 管其余").
 *
 * kb.db holds three tables:
 *   sources(path, type, mtime, hash, chunk_count)  ← incremental ingest bookkeeping
 *   chunks(id, source_id, heading, idx, text)      ← canonical chunk text (citation source)
 *   chunks_fts(...)                                ← FTS5 virtual table, written in the same tx
 *
 * `chunks.heading` stores the heading breadcrumb ("安装 > 配置") so a section can be read back
 * whole; chunks_fts.rowid is the chunk id, so search joins are a straight primary-key hit.
 *
 * If FTS5 is not compiled into the running SQLite, schema creation fails: we degrade to LIKE
 * matching and say so in the log rather than pretending full-text works.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export type FtsMode = "fts5" | "like";

export interface SourceRecord {
  id: number;
  path: string;
  type: string;
  /** Epoch millis from stat; combined with `hash` for the incremental skip. */
  mtime: number;
  hash: string;
  chunkCount: number;
}

export interface ChunkInput {
  /** Heading breadcrumb ("安装 > 配置"); "" when the chunk has no heading. */
  heading: string;
  index: number;
  text: string;
  /** Media timeline (ms); undefined for text documents. */
  startMs?: number;
  endMs?: number;
  /** "video" / "audio" / "image" for media chunks, "" for documents. */
  kind?: string;
}

export interface StoredChunk {
  id: number;
  sourceId: number;
  sourcePath: string;
  heading: string;
  index: number;
  text: string;
  startMs?: number;
  endMs?: number;
  kind: string;
}

/** Half-open [fromMs, toMs) window used by `kb:read` timeRange. */
export interface TimeWindow {
  fromMs: number;
  toMs: number;
}

export interface KeywordHit {
  chunkId: number;
  sourceId: number;
  sourcePath: string;
  heading: string;
  text: string;
  /** Higher is better (bm25 negated, or 1 for LIKE fallback). */
  score: number;
}

export interface ReplaceResult {
  sourceId: number;
  /** SQLite chunk ids, reused as Qdrant point ids. */
  chunkIds: number[];
  replaced: boolean;
}

export interface StoreStats {
  sources: number;
  chunks: number;
  ftsMode: FtsMode;
  dbPath: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     path TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL,
     mtime INTEGER NOT NULL,
     hash TEXT NOT NULL,
     chunk_count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     heading TEXT NOT NULL DEFAULT '',
     idx INTEGER NOT NULL,
     text TEXT NOT NULL,
     start_ms INTEGER,
     end_ms INTEGER,
     kind TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id, idx)`,
];

const FTS_SQL = `
  SELECT c.id AS id, c.source_id AS source_id, c.heading AS heading, c.text AS text,
         s.path AS source_path, bm25(chunks_fts) AS bm25_score
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.rowid
  JOIN sources s ON s.id = c.source_id
  WHERE chunks_fts MATCH ?
  ORDER BY bm25(chunks_fts)
  LIMIT ?`;

const LIKE_SQL = `
  SELECT c.id AS id, c.source_id AS source_id, c.heading AS heading, c.text AS text, s.path AS source_path
  FROM chunks c
  JOIN sources s ON s.id = c.source_id
  WHERE c.text LIKE ? ESCAPE '\\'
  ORDER BY c.id
  LIMIT ?`;

/** Columns every chunk read must return so citations can carry a media timestamp. */
const CHUNK_COLUMNS = `c.id AS id, c.source_id AS source_id, c.heading AS heading, c.idx AS idx,
       c.text AS text, c.start_ms AS start_ms, c.end_ms AS end_ms, c.kind AS kind`;

export class KbStore {
  readonly dbPath: string;
  readonly ftsMode: FtsMode;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    for (const sql of SCHEMA) this.db.exec(sql);
    this.ensureChunkColumns();
    this.ftsMode = this.initFts();
  }

  /** kb.db from an earlier M6 build has no media columns — add them in place (no rebuild). */
  private ensureChunkColumns(): void {
    const existing = new Set(
      this.db.prepare("PRAGMA table_info(chunks)").all().map((row) => asString(row["name"])),
    );
    const additions: [string, string][] = [
      ["start_ms", "INTEGER"],
      ["end_ms", "INTEGER"],
      ["kind", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, ddl] of additions) {
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE chunks ADD COLUMN ${name} ${ddl}`);
    }
  }

  /** Trigram first (works for CJK substrings), then unicode61, then LIKE degradation. */
  private initFts(): FtsMode {
    for (const tokenizer of ["tokenize='trigram'", "tokenize='unicode61'"]) {
      try {
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, source_id UNINDEXED, heading UNINDEXED, ${tokenizer})`,
        );
        return "fts5";
      } catch {
        // try the next tokenizer; if all fail the table below simply stays absent
      }
    }
    log("FTS5 不可用（当前 SQLite 未编译 FTS5 模块），关键词检索降级为 LIKE 扫描");
    return "like";
  }

  getSource(path: string): SourceRecord | undefined {
    const row = this.db.prepare("SELECT id, path, type, mtime, hash, chunk_count FROM sources WHERE path = ?").get(path);
    return row ? toSource(row) : undefined;
  }

  listSources(): SourceRecord[] {
    return this.db
      .prepare("SELECT id, path, type, mtime, hash, chunk_count FROM sources ORDER BY path")
      .all()
      .map(toSource);
  }

  /** Exact path, then resolved path, then suffix, then basename — agents pass partial paths. */
  findSource(target: string): SourceRecord | undefined {
    const exact = this.getSource(target) ?? this.getSource(resolve(target));
    if (exact) return exact;
    const all = this.listSources();
    const normalized = target.replace(/\\/g, "/");
    return (
      all.find((s) => s.path.replace(/\\/g, "/").endsWith(normalized)) ??
      all.find((s) => basename(s.path) === basename(target))
    );
  }

  /** True when mtime and content hash both match — the incremental skip. */
  isUnchanged(path: string, mtime: number, hash: string): boolean {
    const existing = this.getSource(path);
    return existing !== undefined && existing.mtime === mtime && existing.hash === hash;
  }

  /** Replace all chunks of a source atomically (delete + insert + FTS, one transaction). */
  replaceSource(path: string, type: string, mtime: number, hash: string, chunks: ChunkInput[]): ReplaceResult {
    return this.tx(() => {
      const existing = this.getSource(path);
      if (existing) this.deleteSourceRows(existing.id);

      const inserted = this.db
        .prepare("INSERT INTO sources (path, type, mtime, hash, chunk_count) VALUES (?, ?, ?, ?, ?)")
        .run(path, type, mtime, hash, chunks.length);
      const sourceId = asNumber(inserted.lastInsertRowid);

      const insertChunk = this.db.prepare(
        "INSERT INTO chunks (source_id, heading, idx, text, start_ms, end_ms, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts =
        this.ftsMode === "fts5"
          ? this.db.prepare("INSERT INTO chunks_fts (rowid, text, source_id, heading) VALUES (?, ?, ?, ?)")
          : undefined;

      const chunkIds: number[] = [];
      for (const chunk of chunks) {
        const id = asNumber(
          insertChunk.run(
            sourceId,
            chunk.heading,
            chunk.index,
            chunk.text,
            chunk.startMs ?? null,
            chunk.endMs ?? null,
            chunk.kind ?? "",
          ).lastInsertRowid,
        );
        chunkIds.push(id);
        insertFts?.run(id, chunk.text, sourceId, chunk.heading);
      }
      return { sourceId, chunkIds, replaced: existing !== undefined };
    });
  }

  removeSource(path: string): boolean {
    return this.tx(() => {
      const existing = this.getSource(path);
      if (!existing) return false;
      this.deleteSourceRows(existing.id);
      return true;
    });
  }

  /** chunkId → stored chunk (citations need the canonical text, not the vector payload). */
  getChunksByIds(ids: number[]): Map<number, StoredChunk> {
    const out = new Map<number, StoredChunk>();
    if (!ids.length) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT ${CHUNK_COLUMNS}, s.path AS source_path
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.id IN (${placeholders})`,
      )
      .all(...ids);
    for (const row of rows) {
      const chunk = toChunk(row);
      out.set(chunk.id, chunk);
    }
    return out;
  }

  /**
   * All chunks of one source in document order, optionally filtered to a section and/or a
   * time window (media sources only — text chunks carry no timestamps and are excluded then).
   */
  readChunks(sourcePath: string, heading?: string, window?: TimeWindow): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT ${CHUNK_COLUMNS}, s.path AS source_path
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE s.path = ? ORDER BY c.idx`,
      )
      .all(sourcePath);
    let chunks = rows.map(toChunk);
    if (heading) {
      const needle = heading.trim().toLowerCase();
      chunks = chunks.filter((c) => c.heading.toLowerCase().includes(needle));
    }
    if (window) chunks = chunks.filter((c) => overlaps(c, window));
    return chunks;
  }

  /** Hybrid-retrieval keyword arm: FTS5 (bm25) with a LIKE fallback for short/CJK queries. */
  keywordSearch(query: string, limit = 20): KeywordHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    if (this.ftsMode === "fts5") {
      try {
        const rows = this.db.prepare(FTS_SQL).all(buildMatchExpression(trimmed), limit);
        if (rows.length) {
          return rows.map((row) => ({
            chunkId: asNumber(row["id"]),
            sourceId: asNumber(row["source_id"]),
            sourcePath: asString(row["source_path"]),
            heading: asString(row["heading"]),
            text: asString(row["text"]),
            score: -asNumber(row["bm25_score"]),
          }));
        }
      } catch {
        // malformed MATCH expression (e.g. punctuation-only query) → fall through to LIKE
      }
    }

    const rows = this.db.prepare(LIKE_SQL).all(`%${escapeLike(trimmed)}%`, limit);
    return rows.map((row) => ({
      chunkId: asNumber(row["id"]),
      sourceId: asNumber(row["source_id"]),
      sourcePath: asString(row["source_path"]),
      heading: asString(row["heading"]),
      text: asString(row["text"]),
      score: 1,
    }));
  }

  stats(): StoreStats {
    return {
      sources: this.count("sources"),
      chunks: this.count("chunks"),
      ftsMode: this.ftsMode,
      dbPath: this.dbPath,
    };
  }

  close(): void {
    this.db.close();
  }

  private deleteSourceRows(sourceId: number): void {
    if (this.ftsMode === "fts5") {
      this.db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE source_id = ?)").run(sourceId);
    }
    this.db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
  }

  private count(table: "sources" | "chunks"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row ? asNumber(row["n"]) : 0;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // nothing to roll back
      }
      throw err;
    }
  }
}

/** FTS5 boolean OR of the query terms; quoting neutralizes operators in user input. */
function buildMatchExpression(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/["'*()]/g, "").trim())
    .filter((term) => term.length > 0);
  if (!terms.length) return '""';
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: asNumber(row["id"]),
    path: asString(row["path"]),
    type: asString(row["type"]),
    mtime: asNumber(row["mtime"]),
    hash: asString(row["hash"]),
    chunkCount: asNumber(row["chunk_count"]),
  };
}

function toChunk(row: Record<string, unknown>): StoredChunk {
  const chunk: StoredChunk = {
    id: asNumber(row["id"]),
    sourceId: asNumber(row["source_id"]),
    sourcePath: asString(row["source_path"]),
    heading: asString(row["heading"]),
    index: asNumber(row["idx"]),
    text: asString(row["text"]),
    kind: asString(row["kind"]),
  };
  const startMs = asOptionalNumber(row["start_ms"]);
  const endMs = asOptionalNumber(row["end_ms"]);
  if (startMs !== undefined) chunk.startMs = startMs;
  if (endMs !== undefined) chunk.endMs = endMs;
  return chunk;
}

/** Chunk overlaps the window when its [start, end] intersects [from, to). */
function overlaps(chunk: StoredChunk, window: TimeWindow): boolean {
  if (chunk.startMs === undefined) return false;
  const end = chunk.endMs ?? chunk.startMs;
  return chunk.startMs < window.toMs && end > window.fromMs;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = asNumber(value);
  return Number.isFinite(n) ? n : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function log(message: string): void {
  console.warn(`[kb] ${message}`);
}
