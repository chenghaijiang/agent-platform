/** Config loader: YAML -> zod validation -> HarnessConfig. Bad config is a hard failure, never a default silently. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type HarnessConfig } from "./schema.js";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".harness", "config.yaml");

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): HarnessConfig {
  if (!existsSync(path)) {
    // First run: write a starter config with Ollama-first defaults, then load it.
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSyncIfMissing(path, STARTER_CONFIG_YAML);
  }
  const raw = parseYaml(readFileSync(path, "utf8"));
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  return parsed.data;
}

function writeFileSyncIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, content, "utf8");
}

export const STARTER_CONFIG_YAML = `# Agent Harness config — generated on first run (design doc §11)
model:
  default: qwen3.8:27b-mlx      # Ollama-first (M4 Max / 48GB)
loop:
  max_iterations: 25
  parallel_tool_limit: 10
  retry_budget: 4               # local models need more schema-repair retries
context:
  auto_compact_threshold: 0.7   # 32K window compacts earlier than cloud 1M
permissions:
  sandbox: strict
  confirm_levels: [destructive, external]
vector_store:
  type: qdrant
  url: http://localhost:6333
logging:
  trace_enabled: true
  level: info
`;
