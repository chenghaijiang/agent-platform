/**
 * Frame captioning via the local vision model (design doc §5.3: "关键帧过视觉模型生成描述").
 *
 * One frame is one Ollama /api/generate call with `stream: false`; the image goes in as base64.
 * A caption is enrichment, not a prerequisite: after one retry the function returns an empty
 * caption plus the error text so a 40-frame video degrades to "some frames described" instead
 * of failing the whole ingest.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_OLLAMA_URL } from "./embed.js";

export const DEFAULT_VISION_MODEL = "qwen3-vl:30b";

/** Short and objective: long prompts on local VLMs produce rambling, unusable chunks. */
export const CAPTION_PROMPT =
  "客观描述这张图片的画面内容；若包含图表或文字，请转写其中的关键信息。不超过 80 字，不要客套话。";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface CaptionOptions {
  model?: string;
  ollamaUrl?: string;
  prompt?: string;
  timeoutMs?: number;
  /** Retries after the first attempt (spec: 1). */
  retries?: number;
  signal?: AbortSignal;
}

export interface CaptionResult {
  /** Empty string when every attempt failed — callers must handle that. */
  caption: string;
  model: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export class CaptionError extends Error {
  readonly code: "CAPTION_UNAVAILABLE" | "CAPTION_HTTP_ERROR" | "CAPTION_BAD_RESPONSE" | "CAPTION_READ_FAILED";
  readonly status?: number;

  constructor(
    code: CaptionError["code"],
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CaptionError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** Never throws for model/network failures — returns `{ ok: false, caption: "" }` instead. */
export async function captionFrame(imagePath: string, opts: CaptionOptions = {}): Promise<CaptionResult> {
  const model = opts.model ?? process.env["HARNESS_VISION_MODEL"] ?? DEFAULT_VISION_MODEL;
  const attempts = Math.max(1, 1 + (opts.retries ?? 1));

  let base64: string;
  try {
    base64 = readFileSync(imagePath).toString("base64");
  } catch (err) {
    return {
      caption: "",
      model,
      ok: false,
      attempts: 0,
      error: `无法读取关键帧 ${basename(imagePath)}: ${messageOf(err)}`,
    };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await delay(500);
    try {
      const caption = await callVision(imagePath, base64, model, opts);
      return { caption, model, ok: true, attempts: attempt };
    } catch (err) {
      lastError = messageOf(err);
    }
  }
  return { caption: "", model, ok: false, attempts, error: lastError };
}

async function callVision(
  imagePath: string,
  base64: string,
  model: string,
  opts: CaptionOptions,
): Promise<string> {
  const baseUrl = (opts.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: opts.prompt ?? CAPTION_PROMPT,
        images: [base64],
        stream: false,
        options: { temperature: 0.1 },
      }),
      signal: composeSignal(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal),
    });
  } catch (err) {
    throw new CaptionError(
      "CAPTION_UNAVAILABLE",
      `无法连接 Ollama ${baseUrl}（${basename(imagePath)}）。启动: brew services start ollama`,
      { cause: err },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = res.status === 404 ? `；模型可能未安装: ollama pull ${model}` : "";
    throw new CaptionError("CAPTION_HTTP_ERROR", `Ollama /api/generate 返回 ${res.status}${hint}: ${body.slice(0, 200)}`, {
      status: res.status,
    });
  }

  let payload: { response?: unknown };
  try {
    payload = (await res.json()) as { response?: unknown };
  } catch (err) {
    throw new CaptionError("CAPTION_BAD_RESPONSE", "Ollama /api/generate 返回了非 JSON 响应", { cause: err });
  }
  if (typeof payload.response !== "string") {
    throw new CaptionError("CAPTION_BAD_RESPONSE", `Ollama /api/generate 响应缺少 response 字段（model=${model}）`);
  }
  const caption = payload.response.replace(/\s+/g, " ").trim();
  if (!caption) throw new CaptionError("CAPTION_BAD_RESPONSE", `视觉模型返回了空描述（model=${model}）`);
  return caption;
}

function composeSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
