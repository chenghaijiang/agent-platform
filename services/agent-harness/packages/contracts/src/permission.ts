/** Permission & guardrail contract (design doc §6). */

import type { ToolCall } from "./tool.js";

/** Decision chain order: rules -> readonly policy -> hook trust -> user approval. */
export type PermissionSource =
  | "allowlist"
  | "denylist"
  | "readonly_policy"
  | "hook_trust"
  | "user";

export type PermissionDecisionKind = "allowed" | "denied" | "needs_user_approval";

export interface PermissionDecision {
  kind: PermissionDecisionKind;
  source: PermissionSource;
  /** Human-readable justification, surfaced in the trace and the approval card. */
  reason: string;
}

export interface PermissionRequest {
  call: ToolCall;
  /** Tool-declared level (from manifest). */
  level: "read" | "write" | "destructive" | "external";
}

/** Non-negotiable red lines — no config may override these (design doc §6.2). */
export const HARD_RED_LINES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, reason: "rm -rf is forbidden" },
  { pattern: /\bsudo\s+rm\b/, reason: "sudo rm is forbidden" },
  { pattern: /(Desktop|Downloads|Documents|~\/(?:Desktop|Downloads|Documents))\b.*(rm|del|shred|mv\s+\/dev\/null)/i, reason: "destructive ops on personal directories are forbidden" },
  { pattern: /mkfs|dd\s+if=\/dev\/zero|:(){ :\|:& };:/, reason: "disk-destroying commands are forbidden" },
];

export function checkRedLines(command: string): string | null {
  for (const rule of HARD_RED_LINES) if (rule.pattern.test(command)) return rule.reason;
  return null;
}
