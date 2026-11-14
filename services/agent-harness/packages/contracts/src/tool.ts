/** Tool registry contract (design doc §7). Metadata drives the scheduler — lying is a build failure. */

export type ToolPermission = "read" | "write" | "destructive" | "external";

/** A tool's full manifest. All safety metadata fields are REQUIRED. */
export interface ToolManifest {
  /** Globally unique, namespaced: e.g. "fs:read_file" */
  name: string;
  description: string;
  permission: ToolPermission;
  /** Safety metadata — the scheduler refuses to register a tool missing any of these. */
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  needsApproval: boolean;
  timeoutMs: number;
  /** Output token budget; the harness summarizes/truncates beyond this. */
  outputBudget: number;
  /** JSON Schema for input validation. Calls are strictly validated — no guessed params. */
  inputSchema: Record<string, unknown>;
}

export function validateManifest(m: ToolManifest): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(m.name))
    errors.push(`name "${m.name}" must be namespaced as "namespace:name"`);
  if (m.destructive && m.concurrentSafe)
    errors.push(`"${m.name}": destructive tools must NOT be concurrentSafe`);
  if (m.destructive && m.readOnly)
    errors.push(`"${m.name}": cannot be both readOnly and destructive`);
  if (m.permission === "read" && !m.readOnly)
    errors.push(`"${m.name}": permission "read" requires readOnly=true`);
  if ((m.permission === "destructive" || m.permission === "external") && !m.needsApproval)
    errors.push(`"${m.name}": permission "${m.permission}" requires needsApproval=true`);
  if (m.timeoutMs <= 0) errors.push(`"${m.name}": timeoutMs must be positive`);
  if (m.outputBudget <= 0) errors.push(`"${m.name}": outputBudget must be positive`);
  return errors;
}

export interface ToolCall {
  id: string;
  tool: string;
  input: unknown;
}

export type ToolStatus = "pending" | "running" | "ok" | "error" | "denied" | "timeout";

export interface ToolResult {
  callId: string;
  status: ToolStatus;
  /** Tool output within budget; truncated/summarized when over outputBudget. */
  output?: string;
  error?: { code: string; message: string };
  durationMs: number;
}

/** Scheduler plan: parallel waves, destructive calls serialized (design doc §6.2). */
export interface SchedulingWave {
  index: number;
  calls: ToolCall[];
  /** Why this wave exists: all calls here may run in parallel. */
  parallel: boolean;
}
