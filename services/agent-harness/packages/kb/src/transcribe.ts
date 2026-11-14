/**
 * whisper.cpp transcription (design doc §5.3: "音轨分离 → Whisper 本地转写").
 *
 * whisper-cli reads 16 kHz mono wav directly, so callers always go through media.extractAudio
 * first — no per-format branching here. `-oj` writes `<prefix>.json`, which is the only output
 * we parse: stdout mixes progress bars and timestamps and is not a contract.
 *
 * Missing binary / missing model are distinct, actionable errors: one is `brew install`,
 * the other is "download the 1 GB model".
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_WHISPER_BIN = "/opt/homebrew/bin/whisper-cli";
/** ggml-large-v3 q5_0 — the model already provisioned on this machine. */
export const DEFAULT_WHISPER_MODEL = join(homedir(), ".cortxtos", "models", "ggml-large-v3-q5_0.bin");
export const WHISPER_MODEL_HINT = "https://huggingface.co/ggerganov/whisper.cpp/tree/main (下载 ggml-large-v3-q5_0.bin)";

const DEFAULT_TIMEOUT_MS = 600_000;

export type TranscribeErrorCode = "WHISPER_MISSING" | "WHISPER_MODEL_MISSING" | "TRANSCRIBE_FAILED";

export class TranscribeError extends Error {
  readonly code: TranscribeErrorCode;

  constructor(code: TranscribeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TranscribeError";
    this.code = code;
  }
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** All segment texts joined — empty when the track carries no speech. */
  text: string;
  language?: string;
  durationMs: number;
}

export interface TranscribeOptions {
  /** Path to the ggml model; defaults to DEFAULT_WHISPER_MODEL. */
  model?: string;
  /** Path to the whisper-cli binary; defaults to DEFAULT_WHISPER_BIN. */
  binPath?: string;
  /** `auto` lets whisper.cpp detect it (mixed-language meetings). */
  language?: string;
  timeoutMs?: number;
  /** Where the scratch .json goes; a temp dir is created (and removed) when omitted. */
  tempDir?: string;
  signal?: AbortSignal;
}

/** Run whisper-cli and normalize its JSON into millisecond segments. */
export async function transcribeAudio(wavPath: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const binPath = opts.binPath ?? process.env["HARNESS_WHISPER_BIN"] ?? DEFAULT_WHISPER_BIN;
  const model = opts.model ?? process.env["HARNESS_WHISPER_MODEL"] ?? DEFAULT_WHISPER_MODEL;

  if (!existsSync(binPath)) {
    throw new TranscribeError(
      "WHISPER_MISSING",
      `未找到 whisper-cli（${binPath}）。安装: brew install whisper-cpp`,
    );
  }
  if (!existsSync(model)) {
    throw new TranscribeError("WHISPER_MODEL_MISSING", `未找到 Whisper 模型 ${model}。${WHISPER_MODEL_HINT}`);
  }

  // Never write the scratch JSON next to the user's wav: a private temp dir is removed in finally.
  const workDir = opts.tempDir ?? (await mkdtemp(join(tmpdir(), "harness-whisper-")));
  const ownsWorkDir = opts.tempDir === undefined;
  const prefix = join(workDir, `transcript-${Date.now()}`);
  const jsonPath = `${prefix}.json`;

  try {
    await runWhisper(
      binPath,
      ["-m", model, "-f", wavPath, "-oj", "-of", prefix, "-l", opts.language ?? "auto"],
      opts,
    );

    if (!existsSync(jsonPath)) {
      throw new TranscribeError(
        "TRANSCRIBE_FAILED",
        `whisper-cli 未产出 ${basename(jsonPath)}（音频可能是纯静音或格式不受支持）`,
      );
    }

    let parsed: WhisperJson;
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as WhisperJson;
    } catch (err) {
      throw new TranscribeError("TRANSCRIBE_FAILED", `无法解析 whisper-cli JSON: ${jsonPath}`, err);
    }

    const segments = normalizeSegments(parsed);
    const durationMs = segments.reduce((max, s) => Math.max(max, s.endMs), 0);
    const transcript: Transcript = {
      segments,
      text: segments.map((s) => s.text).join(" "),
      durationMs,
    };
    const language = parsed.result?.language ?? parsed.params?.language;
    if (typeof language === "string" && language.length > 0 && language !== "auto") {
      transcript.language = language;
    }
    return transcript;
  } finally {
    discard(jsonPath);
    if (ownsWorkDir) discardDir(workDir);
  }
}

function runWhisper(binPath: string, args: string[], opts: TranscribeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binPath,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new TranscribeError("WHISPER_MISSING", `无法执行 whisper-cli: ${binPath}`));
          return;
        }
        const timedOut = (err as { killed?: boolean }).killed === true;
        const detail = tail(String(stderr ?? ""), 400);
        reject(
          new TranscribeError(
            "TRANSCRIBE_FAILED",
            `whisper-cli 转写失败${timedOut ? "（超时）" : ""}: ${detail || err.message}`,
            err,
          ),
        );
      },
    );
  });
}

/** whisper.cpp emits `offsets` already in ms; fall back to parsing `timestamps` ("00:00:12.340"). */
function normalizeSegments(parsed: WhisperJson): TranscriptSegment[] {
  const raw = Array.isArray(parsed.transcription) ? parsed.transcription : [];
  const segments: TranscriptSegment[] = [];
  for (const item of raw) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text || isNoise(text)) continue;
    const startMs = item.offsets?.from ?? parseClock(item.timestamps?.from);
    const endMs = item.offsets?.to ?? parseClock(item.timestamps?.to);
    if (startMs === undefined) continue;
    segments.push({ startMs: Math.max(0, startMs), endMs: Math.max(startMs, endMs ?? startMs), text });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Whisper invents stock phrases when the audio has no speech (music, tone, room noise). Left in,
 * they pollute the index and show up as confidently-cited nonsense, so they are dropped by pattern.
 */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /subtitles?\s+(by|from)\s+the\s+amara\.org\s+community/i,
  /amara\.org.*(community|社区)/i,
  /字幕由?\s*amara\.?org?\s*社区提供/i,
  /^(thanks?|thank you)\s+(you\s+)?for\s+watching\.?$/i,
  /^please\s+subscribe.*$/i,
  /请不吝点赞.*(订阅|转发|打赏).*$/,
  /^(字幕|本字幕).{0,8}提供$/,
  /ご視聴ありがとうございました/,
  /^www\.\S+\.(org|com)$/i,
];

/** whisper.cpp marks silence as "[BLANK_AUDIO]", "(音乐)" or "♪" — not indexable content. */
function isNoise(text: string): boolean {
  if (/^[[(（【].*(BLANK_AUDIO|SILENCE|NO SPEECH|音乐|静音|无声).*[\])）】]$/i.test(text)) return true;
  if (/^[♪\s.…,-]+$/.test(text)) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(text.trim()));
}

/** "00:12.340" / "01:02:03.500" → ms. */
function parseClock(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  let seconds = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return undefined;
    seconds = seconds * 60 + n;
  }
  return Math.round(seconds * 1000);
}

function discard(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort
  }
}

function discardDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

interface WhisperJson {
  transcription?: {
    timestamps?: { from?: string; to?: string };
    offsets?: { from?: number; to?: number };
    text?: string;
  }[];
  result?: { language?: string };
  params?: { language?: string };
}
