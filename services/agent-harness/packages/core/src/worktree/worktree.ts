/**
 * WorktreeManager — task-level filesystem isolation via `git worktree` (design doc §8.1).
 *
 * One light-weight working tree per subagent task:
 *   <repo>/../<repoName>-worktrees/task-<taskId>   on branch harness/task-<taskId>
 *
 * The worktree shares the parent repository's object database, so creation is cheap and the
 * task's commits stay reviewable by the parent session (`diffSummary`) before a merge — the
 * merge itself is a `needsApproval` decision of the parent, never taken here.
 *
 * Every git invocation is bounded by `timeoutMs` (default 10s) and failures surface as
 * `WorktreeError` with a stable `code`, so a non-git directory is an explicit error rather than
 * a silent fallback to the shared working directory.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

export type WorktreeErrorCode =
  | "INVALID_TASK_ID"
  | "NOT_A_GIT_REPO"
  | "WORKTREE_CREATE_FAILED"
  | "WORKTREE_REMOVE_FAILED"
  | "BRANCH_NOT_FOUND"
  | "GIT_FAILED"
  | "GIT_TIMEOUT";

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    /** git stderr / OS message, clipped — surfaced to the model as structured evidence. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeInfo {
  taskId: string;
  /** Absolute path of the task's working tree. */
  path: string;
  /** Branch checked out in the worktree: `harness/task-<taskId>`. */
  branch: string;
  /** Absolute path of the repository that owns the worktree. */
  repoRoot: string;
}

export interface WorktreeManagerOptions {
  /** Default repository root; individual calls may override it. Defaults to process.cwd(). */
  repoRoot?: string;
  gitBin?: string;
  /** Per-command timeout — git must never wedge a turn. */
  timeoutMs?: number;
  /** Branch namespace, `harness/task-` + taskId. */
  branchPrefix?: string;
  /** Worktree directory is a sibling of the repo: `<repo>/../<repoName>-worktrees`. */
  dirSuffix?: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DETAIL = 2_000;

export class WorktreeManager {
  private readonly gitBin: string;
  private readonly timeoutMs: number;
  private readonly branchPrefix: string;
  private readonly dirSuffix: string;
  /** Root of the last repository this manager touched — lets diffSummary/remove work without it. */
  private lastRepoRoot: string | undefined;

  constructor(private readonly opts: WorktreeManagerOptions = {}) {
    this.gitBin = opts.gitBin ?? "git";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.branchPrefix = opts.branchPrefix ?? "harness/task-";
    this.dirSuffix = opts.dirSuffix ?? "-worktrees";
    this.lastRepoRoot = opts.repoRoot ? resolvePath(opts.repoRoot) : undefined;
  }

  /** Create `<repo>/../<repoName>-worktrees/task-<taskId>` on a fresh `harness/task-<taskId>` branch. */
  async create(repoRoot: string, taskId: string): Promise<WorktreeInfo> {
    const layout = this.layoutFor(repoRoot, taskId);
    const { root } = await this.resolveRepoRoot(repoRoot);
    const info = { ...layout, repoRoot: root };

    mkdirSync(dirname(info.path), { recursive: true });
    try {
      await this.git(root, ["worktree", "add", info.path, "-b", info.branch]);
    } catch (err) {
      throw this.asError("WORKTREE_CREATE_FAILED", err, `cannot create worktree for task "${taskId}"`);
    }
    this.lastRepoRoot = root;
    return info;
  }

  /** `git diff <base>...harness/task-<taskId> --stat` — `main` when it exists, HEAD otherwise. */
  async diffSummary(taskId: string, repoRoot?: string): Promise<string> {
    const { root } = await this.resolveRepoRoot(repoRoot);
    const { branch } = this.layoutFor(root, taskId);
    await this.assertBranch(root, branch);

    const base = (await this.branchExists(root, "main")) ? "main" : "HEAD";
    const { stdout } = await this.git(root, ["diff", `${base}...${branch}`, "--stat"]);
    const stat = stdout.trim();
    return stat.length > 0 ? stat : `(no changes on ${branch} vs ${base})`;
  }

  /** Remove the working tree and delete its branch. `force` discards uncommitted work / unmerged commits. */
  async remove(
    taskId: string,
    options: { force?: boolean; repoRoot?: string } = {},
  ): Promise<{ removed: boolean; path: string; branch: string }> {
    const { root } = await this.resolveRepoRoot(options.repoRoot);
    const { path, branch } = this.layoutFor(root, taskId);

    let removed = false;
    const args = ["worktree", "remove", path];
    if (options.force) args.push("--force");
    try {
      await this.git(root, args);
      removed = true;
    } catch (err) {
      // Already gone (removed by hand / never created): idempotent, but a dirty tree is a real error.
      if (!isMissingWorktree(err)) {
        throw this.asError("WORKTREE_REMOVE_FAILED", err, `cannot remove worktree for task "${taskId}"`);
      }
    }

    try {
      await this.git(root, ["branch", options.force ? "-D" : "-d", branch]);
    } catch (err) {
      if (!isMissingBranch(err)) {
        throw this.asError("WORKTREE_REMOVE_FAILED", err, `cannot delete branch "${branch}"`);
      }
    }

    return { removed, path, branch };
  }

  /** All task worktrees of the repository (`harness/task-*` branches only). */
  async list(repoRoot?: string): Promise<WorktreeInfo[]> {
    const { root } = await this.resolveRepoRoot(repoRoot);
    const { stdout } = await this.git(root, ["worktree", "list", "--porcelain"]);

    const entries: WorktreeInfo[] = [];
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
        branch = undefined;
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      } else if (line.trim() === "") {
        pushEntry(entries, root, path, branch, this.branchPrefix);
        path = undefined;
        branch = undefined;
      }
    }
    pushEntry(entries, root, path, branch, this.branchPrefix);
    return entries;
  }

  /** Deterministic layout — `create`, `diffSummary` and `remove` must agree on it. */
  private layoutFor(repoRoot: string, taskId: string): { taskId: string; path: string; branch: string } {
    if (!TASK_ID_RE.test(taskId)) {
      throw new WorktreeError(
        "INVALID_TASK_ID",
        `invalid task id "${taskId}": use letters, digits, ".", "_" or "-"`,
      );
    }
    const root = resolvePath(repoRoot);
    const repoName = basename(root);
    const path = join(dirname(root), `${repoName}${this.dirSuffix}`, `task-${taskId}`);
    return { taskId, path, branch: `${this.branchPrefix}${taskId}` };
  }

  /** Normalize the given root to the repository top level; a non-git directory is an error. */
  private async resolveRepoRoot(input?: string): Promise<{ root: string }> {
    const cwd = resolvePath(input ?? this.lastRepoRoot ?? process.cwd());
    let stdout: string;
    try {
      ({ stdout } = await this.git(cwd, ["rev-parse", "--show-toplevel"]));
    } catch (err) {
      throw this.asError("NOT_A_GIT_REPO", err, `"${cwd}" is not a git repository`);
    }
    const root = stdout.trim();
    if (!root) throw new WorktreeError("NOT_A_GIT_REPO", `"${cwd}" is not a git repository`);
    this.lastRepoRoot = root;
    return { root };
  }

  private async branchExists(root: string, branch: string): Promise<boolean> {
    try {
      await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async assertBranch(root: string, branch: string): Promise<void> {
    if (await this.branchExists(root, branch)) return;
    throw new WorktreeError("BRANCH_NOT_FOUND", `branch "${branch}" does not exist`);
  }

  private git(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      execFile(
        this.gitBin,
        args,
        { cwd, timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ stdout, stderr });
            return;
          }
          const timedOut = err.killed === true || err.signal === "SIGTERM";
          const detail = (stderr || err.message).trim().slice(0, MAX_DETAIL);
          reject(
            new WorktreeError(
              timedOut ? "GIT_TIMEOUT" : "GIT_FAILED",
              `git ${args.join(" ")} failed${timedOut ? " (timeout)" : ""}`,
              detail,
            ),
          );
        },
      );
    });
  }

  /** Re-wrap a git failure under the operation's own code, keeping the original detail. */
  private asError(code: WorktreeErrorCode, err: unknown, message: string): WorktreeError {
    if (err instanceof WorktreeError) return new WorktreeError(code, message, err.detail ?? err.message);
    return new WorktreeError(code, message, err instanceof Error ? err.message : String(err));
  }
}

function pushEntry(
  entries: WorktreeInfo[],
  repoRoot: string,
  path: string | undefined,
  branch: string | undefined,
  branchPrefix: string,
): void {
  if (!path || !branch || !branch.startsWith(branchPrefix)) return;
  entries.push({ taskId: branch.slice(branchPrefix.length), path, branch, repoRoot });
}

function isMissingWorktree(err: unknown): boolean {
  if (!(err instanceof WorktreeError)) return false;
  return /not a working tree|no such file|does not exist|not a git repository/i.test(
    `${err.detail ?? ""} ${err.message}`,
  );
}

function isMissingBranch(err: unknown): boolean {
  if (!(err instanceof WorktreeError)) return false;
  return /not found/i.test(`${err.detail ?? ""} ${err.message}`);
}
