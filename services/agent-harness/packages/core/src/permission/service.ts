/**
 * PermissionService — the single gate every tool call passes through (design doc §6).
 *
 * The decision chain is FIXED (order may not be rearranged):
 *   denylist → allowlist → shell read-only policy → confirm_levels → user approval
 *
 * `evaluate()` runs steps 1–4 synchronously so the turn can decide whether it must suspend in
 * `awaiting_permission` before any human is bothered; `requestApproval()` is step 5, delegated to
 * the surface layer (CLI readline today, an approval card on the web tomorrow).
 */
import {
  checkRedLines,
  type PermissionDecision,
  type PermissionRequest,
  type ToolManifest,
  type ToolPermission,
} from "@harness/contracts";

export type ApprovalOutcome = "allowed" | "denied";
export type ApprovalHandler = (
  request: PermissionRequest,
  manifest: ToolManifest,
) => Promise<ApprovalOutcome>;

/** The slice of `config.permissions` the service needs (structurally compatible). */
export interface PermissionPolicy {
  confirm_levels?: readonly ToolPermission[];
  allowlist?: readonly string[];
  denylist?: readonly string[];
}

export interface PermissionServiceOptions {
  permissions?: PermissionPolicy;
  /** Injected by the surface layer; absent means "nothing can be approved" (fail closed). */
  approvalHandler?: ApprovalHandler;
}

/** Levels that need a human unless config overrides them (design doc §6.2). */
export const DEFAULT_CONFIRM_LEVELS: readonly ToolPermission[] = ["destructive", "external"];

const SHELL_TOOL = "shell:run";

/** Commands that only read. Args are still inspected below — a whitelisted name is not a blank check. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "du",
  "find",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "pwd",
  "echo",
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff"]);

/** `find` predicates that execute programs or delete files. */
const FIND_FORBIDDEN_PREDICATES: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
  "-fwrite",
]);

/** `git` flags that can write files or spawn external programs. */
const GIT_FORBIDDEN_FLAGS = /^--(output|ext-diff|exec-path|upload-pack)/;

/**
 * True only if EVERY segment of the command is a whitelisted read-only invocation.
 * Shell metacharacters are rejected outright, so `ls; rm -rf /`, `cat a | sh`,
 * `echo x > f` and `$(...)`/backtick substitution can never masquerade as read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = command
    .split(/;|&&|\|\||\||\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
  // Redirection / subshell / background / command substitution all imply writes or escaping.
  if (/[`<>&()]|\$\(/.test(segment)) return false;

  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0] ?? "";
  const name = head.split("/").pop() ?? "";
  if (!name) return false;

  if (name === "git") {
    const sub = tokens[1] ?? "";
    // Options before the subcommand (`-c`, `-C`, …) are not worth reasoning about — reject them.
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    return !tokens.some((t) => GIT_FORBIDDEN_FLAGS.test(t));
  }

  if (name === "find") {
    if (tokens.some((t) => FIND_FORBIDDEN_PREDICATES.has(t))) return false;
    return true;
  }

  return READ_ONLY_COMMANDS.has(name);
}

/** Tool names support `*` as a wildcard: `"shell:*"`, `"fs:write_*"`, `"*_file"`. */
function matchesRule(tool: string, rule: string): boolean {
  if (rule === tool) return true;
  if (!rule.includes("*")) return false;
  const pattern = `^${rule.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern).test(tool);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellCommandOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function clip(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export class PermissionService {
  private readonly confirmLevels: readonly ToolPermission[];
  private readonly allowlist: readonly string[];
  private readonly denylist: readonly string[];
  private readonly approvalHandler: ApprovalHandler | undefined;

  constructor(options: PermissionServiceOptions = {}) {
    const policy = options.permissions ?? {};
    this.confirmLevels = policy.confirm_levels ?? DEFAULT_CONFIRM_LEVELS;
    this.allowlist = policy.allowlist ?? [];
    this.denylist = policy.denylist ?? [];
    this.approvalHandler = options.approvalHandler;
  }

  /** Steps 1–4: no user interaction, so it is safe to call while still in `scheduling_tools`. */
  evaluate(request: PermissionRequest, manifest: ToolManifest): PermissionDecision {
    const tool = request.call.tool;
    const command = tool === SHELL_TOOL ? shellCommandOf(request.call.input) : undefined;

    // 1a. denylist rules (config) …
    const denyRule = this.denylist.find((rule) => matchesRule(tool, rule));
    if (denyRule) {
      return { kind: "denied", source: "denylist", reason: `tool "${tool}" matches denylist rule "${denyRule}"` };
    }
    // … and the non-negotiable hard red lines, which no config may override (design doc §6.2).
    if (command !== undefined) {
      const redLine = checkRedLines(command);
      if (redLine) return { kind: "denied", source: "denylist", reason: `hard red line: ${redLine}` };
    }

    // 2. allowlist rules.
    const allowRule = this.allowlist.find((rule) => matchesRule(tool, rule));
    if (allowRule) {
      return { kind: "allowed", source: "allowlist", reason: `tool "${tool}" matches allowlist rule "${allowRule}"` };
    }

    // 3. shell read-only policy: a provably read-only command is downgraded to `read` and let through.
    if (command !== undefined && isReadOnlyCommand(command)) {
      return {
        kind: "allowed",
        source: "readonly_policy",
        reason: `read-only shell command, downgraded to level "read": ${clip(command)}`,
      };
    }

    // 4. confirmation levels declared by config / manifest.
    if (this.confirmLevels.includes(request.level) || manifest.needsApproval) {
      return {
        kind: "needs_user_approval",
        source: "user",
        reason: `level "${request.level}" requires confirmation`,
      };
    }

    if (manifest.readOnly || request.level === "read") {
      return { kind: "allowed", source: "readonly_policy", reason: "read-only tool" };
    }
    return { kind: "allowed", source: "allowlist", reason: `level "${request.level}" is not in confirm_levels` };
  }

  /** Step 5: ask the human. No handler means no approval — we fail closed, never open. */
  async requestApproval(request: PermissionRequest, manifest: ToolManifest): Promise<PermissionDecision> {
    if (!this.approvalHandler) {
      return { kind: "denied", source: "user", reason: "no approval handler wired; refused (fail closed)" };
    }
    let outcome: ApprovalOutcome;
    try {
      outcome = await this.approvalHandler(request, manifest);
    } catch (err) {
      return {
        kind: "denied",
        source: "user",
        reason: `approval handler failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return outcome === "allowed"
      ? { kind: "allowed", source: "user", reason: "approved by user" }
      : { kind: "denied", source: "user", reason: "denied by user" };
  }

  /** Full chain, including the human step when the earlier steps abstain. */
  async resolve(request: PermissionRequest, manifest: ToolManifest): Promise<PermissionDecision> {
    const decision = this.evaluate(request, manifest);
    return decision.kind === "needs_user_approval" ? this.requestApproval(request, manifest) : decision;
  }
}
