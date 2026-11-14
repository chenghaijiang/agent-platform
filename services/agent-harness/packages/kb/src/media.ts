/**
 * Media probing / frame extraction / audio extraction — ffmpeg-backed (design doc §5.3).
 *
 * The video pipeline is "sample + transcribe", never real-time understanding:
 *   probe → scene-change frames (≤40, ≥5s apart) → vision captions → audio track → Whisper.
 *
 * Everything shells out through execFile with an explicit timeout, so a hung ffmpeg can never
 * wedge ingest. A missing ffmpeg is a structured FFMPEG_MISSING error carrying the brew hint —
 * "the tool is not installed" must never look like "this file is corrupt".
 */
import { execFile } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Video containers routed to the frame+caption pipeline. */
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"] as const;
/** Audio formats whisper-cli can consume directly (non-wav goes through 16k mono wav). */
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg"] as const;
/** Images are captioned by the vision model before indexing. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

export type MediaKind = "video" | "audio" | "image";

export const FFMPEG_HINT = "brew install ffmpeg";
export const DEFAULT_FRAME_LIMIT = 40;
export const DEFAULT_FRAME_INTERVAL_MS = 5_000;
export const DEFAULT_SCENE_THRESHOLD = 0.3;
/** Frames are downscaled before captioning — the vision model does not need 4K. */
export const DEFAULT_FRAME_WIDTH = 640;

const PROBE_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 180_000;
const AUDIO_TIMEOUT_MS = 120_000;
/** Safety cap on candidate scene frames before the 5s/40-frame filter runs in JS. */
const MAX_CANDIDATE_FRAMES = 200;

export type MediaErrorCode =
  | "FFMPEG_MISSING"
  | "PROBE_FAILED"
  | "FRAME_EXTRACTION_FAILED"
  | "AUDIO_EXTRACTION_FAILED"
  | "NO_AUDIO_TRACK";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /** Tail of ffmpeg/ffprobe stderr — the only place the real reason shows up. */
  readonly detail?: string;

  constructor(code: MediaErrorCode, message: string, opts: { detail?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "MediaError";
    this.code = code;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}

// ---------------------------------------------------------------------------------------------
// extension dispatch
// ---------------------------------------------------------------------------------------------

const IMAGE_SET = new Set<string>(IMAGE_EXTENSIONS);
const AUDIO_SET = new Set<string>(AUDIO_EXTENSIONS);
const VIDEO_SET = new Set<string>(VIDEO_EXTENSIONS);

/** `undefined` for non-media paths — ingest then falls back to the document parser. */
export function classifyMedia(filePath: string): MediaKind | undefined {
  const ext = extnameLower(filePath);
  if (VIDEO_SET.has(ext)) return "video";
  if (AUDIO_SET.has(ext)) return "audio";
  if (IMAGE_SET.has(ext)) return "image";
  return undefined;
}

export function isMediaFile(filePath: string): boolean {
  return classifyMedia(filePath) !== undefined;
}

export function mediaExtensions(): string[] {
  return [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS].sort();
}

// ---------------------------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------------------------

export interface MediaProbe {
  path: string;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  formatName?: string;
}

/** ffprobe -print_format json; a missing audio stream is reported, not guessed. */
export async function probeMedia(filePath: string, opts: { timeoutMs?: number } = {}): Promise<MediaProbe> {
  const { stdout } = await run(
    resolveBinary("ffprobe"),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    "PROBE_FAILED",
    `ffprobe 无法解析 ${filePath}`,
  );

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    throw new MediaError("PROBE_FAILED", `ffprobe 返回了非 JSON 响应: ${basename(filePath)}`, { cause: err });
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  const durationMs = toMillis(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0);

  if (!video && !audio) {
    throw new MediaError("PROBE_FAILED", `${basename(filePath)} 中既没有视频流也没有音频流`);
  }

  const probe: MediaProbe = {
    path: filePath,
    durationMs,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  };
  if (typeof video?.width === "number") probe.width = video.width;
  if (typeof video?.height === "number") probe.height = video.height;
  if (video?.codec_name) probe.videoCodec = video.codec_name;
  if (audio?.codec_name) probe.audioCodec = audio.codec_name;
  if (parsed.format?.format_name) probe.formatName = parsed.format.format_name;
  return probe;
}

// ---------------------------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------------------------

export interface ExtractedFrame {
  /** JPEG on disk; caller must finish with it before the temp dir is removed. */
  path: string;
  /** Presentation timestamp of the frame inside the source video. */
  atMs: number;
}

export interface ExtractFramesOptions {
  /**
   * Working directory for the JPEGs. Pass one (createMediaTempDir) when the caller wants to
   * control the lifetime; otherwise a fresh temp dir is created and returned in the result.
   */
  tempDir?: string;
  maxFrames?: number;
  minIntervalMs?: number;
  sceneThreshold?: number;
  maxWidth?: number;
  timeoutMs?: number;
}

export interface FrameExtraction {
  frames: ExtractedFrame[];
  /** Whoever created it should remove it (removeMediaTempDir is idempotent). */
  tempDir: string;
}

/**
 * Scene-change sampling: ffmpeg emits `select='gt(scene,0.3)'` candidates with their PTS in
 * showinfo, then JS keeps ≤40 frames spaced ≥5s apart. A clip with no cuts falls back to
 * fixed-interval sampling so a static recording still yields at least one frame.
 */
export async function extractFrames(filePath: string, opts: ExtractFramesOptions = {}): Promise<FrameExtraction> {
  const tempDir = opts.tempDir ?? (await createMediaTempDir("harness-frames-"));
  const maxFrames = Math.max(1, opts.maxFrames ?? DEFAULT_FRAME_LIMIT);
  const minIntervalMs = Math.max(0, opts.minIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS);
  const threshold = opts.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD;
  const width = opts.maxWidth ?? DEFAULT_FRAME_WIDTH;
  const timeoutMs = opts.timeoutMs ?? FRAME_TIMEOUT_MS;

  const sceneCandidates = await extractCandidateFrames(
    filePath,
    tempDir,
    ["-vf", `select='gt(scene,${threshold})',showinfo,scale=${width}:-2`, "-frames:v", String(MAX_CANDIDATE_FRAMES)],
    timeoutMs,
  );

  const candidates = sceneCandidates.length
    ? sceneCandidates
    : await extractCandidateFrames(
        filePath,
        tempDir,
        ["-vf", `fps=1/10,showinfo,scale=${width}:-2`, "-frames:v", String(maxFrames)],
        timeoutMs,
      );

  return { frames: thinOut(candidates, maxFrames, minIntervalMs), tempDir };
}

interface CandidateFrame {
  path: string;
  atMs: number;
}

/** Run one ffmpeg pass and pair every produced JPEG with the PTS reported by showinfo. */
async function extractCandidateFrames(
  filePath: string,
  tempDir: string,
  filterArgs: string[],
  timeoutMs: number,
): Promise<CandidateFrame[]> {
  const pattern = join(tempDir, "frame_%04d.jpg");
  const { stderr } = await run(
    resolveBinary("ffmpeg"),
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      filePath,
      ...filterArgs,
      "-fps_mode",
      "vfr",
      "-q:v",
      "3",
      pattern,
    ],
    timeoutMs,
    "FRAME_EXTRACTION_FAILED",
    `ffmpeg 抽帧失败: ${basename(filePath)}`,
  );

  const stamps = parseShowInfoTimestamps(stderr);
  const frames: CandidateFrame[] = [];
  // Enumerate what ffmpeg actually wrote; timestamps come from showinfo when parseable, and
  // fall back to second-granularity so a truncated stderr never loses the frame entirely.
  for (let index = 0; ; index++) {
    const frame = framePath(tempDir, index + 1);
    if (!existsSync(frame)) break;
    frames.push({ path: frame, atMs: stamps[index] ?? index * 1000 });
  }
  return frames;
}

/** Keep the first frame, then only frames ≥ minIntervalMs after the last kept one. */
function thinOut(candidates: CandidateFrame[], maxFrames: number, minIntervalMs: number): ExtractedFrame[] {
  const sorted = [...candidates].sort((a, b) => a.atMs - b.atMs);
  const kept: ExtractedFrame[] = [];
  for (const frame of sorted) {
    const last = kept[kept.length - 1];
    if (last && frame.atMs - last.atMs < minIntervalMs) {
      discard(frame.path);
      continue;
    }
    kept.push({ path: frame.path, atMs: frame.atMs });
    if (kept.length >= maxFrames) break;
  }
  // Anything beyond the cap must not linger in the temp dir.
  for (const frame of sorted) {
    if (!kept.some((item) => item.path === frame.path)) discard(frame.path);
  }
  return kept;
}

/** `[Parsed_showinfo_1 @ 0x…] n: 0 pts: 0 pts_time:0 …` → timestamps in ms, indexed by frame n. */
function parseShowInfoTimestamps(stderr: string): number[] {
  const stamps: number[] = [];
  const re = /n:\s*(\d+)[^\n]*?pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g;
  for (const match of stderr.matchAll(re)) {
    const index = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(seconds)) continue;
    stamps[index] = Math.round(seconds * 1000);
  }
  return stamps;
}

function framePath(tempDir: string, position: number): string {
  return join(tempDir, `frame_${String(position).padStart(4, "0")}.jpg`);
}

// ---------------------------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------------------------

/**
 * Split the audio track into 16 kHz mono PCM wav — the only thing whisper-cli needs, and the
 * conversion also makes flac/ogg/m4a interchangeable downstream.
 */
export async function extractAudio(
  filePath: string,
  opts: { tempDir?: string; timeoutMs?: number } = {},
): Promise<string> {
  const tempDir = opts.tempDir ?? (await createMediaTempDir("harness-audio-"));
  const wavPath = join(tempDir, "audio.wav");
  await run(
    resolveBinary("ffmpeg"),
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ],
    opts.timeoutMs ?? AUDIO_TIMEOUT_MS,
    "AUDIO_EXTRACTION_FAILED",
    `ffmpeg 音轨转码失败: ${basename(filePath)}`,
  );
  if (!existsSync(wavPath)) {
    throw new MediaError("AUDIO_EXTRACTION_FAILED", `ffmpeg 未产出 wav: ${basename(filePath)}`);
  }
  return wavPath;
}

// ---------------------------------------------------------------------------------------------
// temp dirs
// ---------------------------------------------------------------------------------------------

/** os.tmpdir + mkdtemp: unique per ingest run, outside the workspace. */
export async function createMediaTempDir(prefix = "harness-media-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Never remove anything outside os.tmpdir — a bad caller argument must not delete user data. */
export function removeMediaTempDir(dir: string): void {
  if (!dir || !dir.startsWith(tmpdir())) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort: leftover temp files are the OS's problem, not the user's
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** `mm:ss` for 12m34s; hours are added only when needed (`h:mm:ss`). */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** "00:12–00:30" — used as the heading of every media chunk. */
export function formatTimeRange(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs)}–${formatTimestamp(endMs)}`;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function run(
  binary: string,
  args: string[],
  timeoutMs: number,
  failureCode: MediaErrorCode,
  failurePrefix: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          return;
        }
        const detail = tail(String(stderr ?? ""), 400);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new MediaError("FFMPEG_MISSING", `未找到 ${basename(binary)}。安装后重试: ${FFMPEG_HINT}`, {
              detail,
              cause: err,
            }),
          );
          return;
        }
        const timedOut = (err as { killed?: boolean }).killed === true;
        const reason = timedOut ? `超时 ${Math.round(timeoutMs / 1000)}s` : err.message;
        reject(
          new MediaError(failureCode, `${failurePrefix}（${reason}）${detail ? `: ${detail}` : ""}`, {
            detail,
            cause: err,
          }),
        );
      },
    );
  });
}

/**
 * Resolution order: explicit env override → portable install under `~/.harness/bin` (how this
 * machine gets ffmpeg without Homebrew, which is unavailable here) → Homebrew's prefix (GUI-launched
 * shells lose PATH) → PATH.
 */
function resolveBinary(name: "ffmpeg" | "ffprobe"): string {
  const override = name === "ffmpeg" ? process.env["HARNESS_FFMPEG"] : process.env["HARNESS_FFPROBE"];
  if (override) return override;
  const portable = join(homedir(), ".harness", "bin", name);
  if (existsSync(portable)) return portable;
  const brew = `/opt/homebrew/bin/${name}`;
  return existsSync(brew) ? brew : name;
}

function extnameLower(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

function toMillis(seconds: unknown): number {
  const value = typeof seconds === "number" ? seconds : Number(seconds);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string | number;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string | number; format_name?: string };
}
