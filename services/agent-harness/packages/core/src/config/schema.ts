/** config.yaml schema (design doc §11). Local-first defaults tuned for Ollama (M4 Max / 48GB). */
import { z } from "zod";

export const providerSchema = z.object({
  name: z.string(),
  type: z.enum(["ollama", "openai-compatible"]),
  base_url: z.string().url(),
  api_key: z.string().optional(),
  models: z.array(z.string()).default([]),
  capabilities: z
    .object({
      tool_calling: z.boolean().default(true),
      streaming: z.boolean().default(true),
      structured_output: z.boolean().default(false),
      vision: z.boolean().default(false),
      context_window: z.number().int().positive().default(32768),
      max_output_tokens: z.number().int().positive().default(8192),
    })
    .default({}),
});

export const configSchema = z.object({
  model: z
    .object({
      /** Ollama-first (route decision 2026-11-07): local model as default. */
      default: z.string().default("qwen3.8:27b-mlx"),
      fallback: z.string().optional(),
      providers: z.array(providerSchema).default([
        {
          name: "ollama-local",
          type: "ollama",
          base_url: "http://localhost:11434/v1",
          models: ["qwen3.8:27b-mlx", "gpt-oss:20b", "qwen3-vl:30b", "qwen3-embedding:0.6b"],
          capabilities: {
            tool_calling: true,
            streaming: true,
            structured_output: true,
            vision: true,
            context_window: 32768,
            max_output_tokens: 8192,
          },
        },
      ]),
    })
    .default({}),
  loop: z
    .object({
      max_iterations: z.number().int().positive().default(25),
      max_tool_errors_same_kind: z.number().int().positive().default(2),
      parallel_tool_limit: z.number().int().positive().default(10),
      retry_budget: z.number().int().positive().default(4),
    })
    .default({}),
  context: z
    .object({
      /** Local 27B @ 32K window: compact earlier than cloud 1M. */
      auto_compact_threshold: z.number().min(0.3).max(0.95).default(0.7),
      rapid_refill_guard: z.boolean().default(true),
    })
    .default({}),
  permissions: z
    .object({
      sandbox: z.enum(["strict", "permissive"]).default("strict"),
      confirm_levels: z
        .array(z.enum(["read", "write", "destructive", "external"]))
        .default(["destructive", "external"]),
      /** Explicit permission rules (design doc §6.1 step 1). Tool names, `*` wildcard allowed. */
      allowlist: z.array(z.string()).default([]),
      denylist: z.array(z.string()).default([]),
    })
    .default({}),
  memory: z
    .object({
      l2_max_chars: z.number().int().positive().default(4000),
      l3_max_chars: z.number().int().positive().default(3000),
      log_rotate_days: z.number().int().positive().default(30),
    })
    .default({}),
  vector_store: z
    .object({
      type: z.literal("qdrant").default("qdrant"),
      url: z.string().url().default("http://localhost:6333"),
      collection_prefix: z.string().default("harness_"),
      degrade_to_fts_only: z.boolean().default(true),
    })
    .default({}),
  hooks: z
    .object({
      hard_reject_exit_code: z.number().int().default(2),
      workspace_trust: z.enum(["required", "optional"]).default("required"),
    })
    .default({}),
  logging: z
    .object({
      trace_enabled: z.boolean().default(true),
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .default({}),
});

export type HarnessConfig = z.infer<typeof configSchema>;
