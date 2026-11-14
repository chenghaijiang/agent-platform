/** Built-in tools M1: fs:read_file, fs:write_file, shell:run (design doc §7). */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { checkRedLines } from "@harness/contracts";
import { CancelledError, cancelReasonOf } from "../model/cancelled.js";
import type { ToolExecutionContext, ToolRegistry } from "../tool/registry.js";

const MAX_FILE_BYTES = 512 * 1024;
/** Same ceiling `exec()` applied to shell output before we took the child over. */
const MAX_SHELL_BYTES = 4 * 1024 * 1024;

/** Refuse work that was cancelled before the tool got its hands on it (§17.4). */
function throwIfCancelled(ctx: ToolExecutionContext | undefined): void {
  if (ctx?.signal?.aborted) throw new CancelledError(cancelReasonOf(ctx.signal));
}

/**
 * Kill the whole process group, not just `sh`: `sh -c "sleep 30 | cat"` leaves grandchildren
 * behind otherwise. Returns true when a signal was actually delivered.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

function withLineNumbers(content: string, offset = 1): string {
  const lines = content.split("\n");
  return lines
    .slice(0, 2000)
    .map((l, i) => `${String(offset + i).padStart(6)}\t${l}`)
    .join("\n") + (lines.length > 2000 ? `\n... (${lines.length - 2000} more lines truncated)` : "");
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "fs:read_file",
      description: "Read a local file; returns numbered lines (first 2000 lines, 512KB cap).",
      permission: "read",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      timeoutMs: 10_000,
      outputBudget: 20_000,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "absolute or cwd-relative path" } },
        required: ["path"],
      },
    },
    async (input, ctx) => {
      throwIfCancelled(ctx);
      const { path } = input as { path: string };
      const st = statSync(path);
      if (st.isDirectory()) return `ERROR: ${path} is a directory`;
      const content = readFileSync(path, "utf8").slice(0, MAX_FILE_BYTES);
      return withLineNumbers(content);
    },
  );

  registry.register(
    {
      name: "fs:write_file",
      description: "Write (overwrite) a UTF-8 text file. Creating directories is NOT implied.",
      permission: "write",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      needsApproval: false, // M2 will gate workspace writes by sandbox policy
      timeoutMs: 10_000,
      outputBudget: 1_000,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    async (input, ctx) => {
      throwIfCancelled(ctx);
      const { path, content } = input as { path: string; content: string };
      writeFileSync(path, content, "utf8");
      return `OK: wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  );

  registry.register(
    {
      name: "shell:run",
      description:
        "Execute a shell command (sh -c), capture stdout+stderr. Hard red lines are rejected. 30s default timeout.",
      permission: "write",
      readOnly: false,
      destructive: false, // cannot know statically — treated as writable, red-lines guard the worst
      concurrentSafe: false,
      needsApproval: false, // M2: approval levels & sandbox
      timeoutMs: 30_000,
      outputBudget: 20_000,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "the shell command to run" },
          timeoutMs: { type: "integer", description: "optional timeout in ms (max 60000)" },
        },
        required: ["command"],
      },
    },
    async (input, ctx) => {
      throwIfCancelled(ctx);
      const { command, timeoutMs } = input as { command: string; timeoutMs?: number };
      const redLine = checkRedLines(command);
      if (redLine) return `DENIED by hard red line: ${redLine}`;
      const timeout = Math.min(timeoutMs ?? 30_000, 60_000);
      const signal = ctx?.signal;
      return runShell(command, timeout, signal);
    },
  );
}

/**
 * `sh -c <command>` in its own process group (design doc §17.4).
 *
 * `execFile` silently drops `detached`, so a group kill would only take `sh` down and orphan the
 * command's children — hence `spawn`. The abort signal reaches Node (which kills the direct child)
 * *and* our own listener (which kills the whole group, escalating to SIGKILL if needed).
 */
function runShell(command: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGTERM",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let cut: "timeout" | "buffer" | null = null;

    const hardStop = (why: "timeout" | "buffer"): void => {
      cut ??= why;
      killGroup(child.pid, "SIGKILL");
    };

    /** SIGTERM the group, then make sure a stubborn child cannot outlive the turn. */
    const terminate = (): void => {
      if (!killGroup(child.pid, "SIGTERM")) return;
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 2_000).unref();
    };

    const timer = setTimeout(() => hardStop("timeout"), timeoutMs);
    timer.unref();

    const onAbort = (): void => terminate();
    signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_SHELL_BYTES) {
        hardStop("buffer");
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on("data", collect(stdoutChunks));
    child.stderr?.on("data", collect(stderrChunks));

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      // An aborted spawn reports AbortError — the close handler owns that path.
      if (signal?.aborted) return;
      cleanup();
      resolve(`SHELL_ERROR: ${err.message}`);
    });

    child.on("close", (code, killedBy) => {
      cleanup();
      const parts: string[] = [];
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stdout) parts.push(stdout.slice(0, 32_000));
      if (stderr) parts.push(`[stderr]\n${stderr.slice(0, 8_000)}`);
      if (signal?.aborted) parts.push("[cancelled by user]");
      else if (cut === "timeout") parts.push(`[exit ${code ?? "?"}] (timeout)`);
      else if (cut === "buffer") parts.push(`[exit ${code ?? "?"}] (output > ${MAX_SHELL_BYTES} bytes)`);
      else if (code !== 0) parts.push(`[exit ${code ?? "?"}]${killedBy ? ` (${killedBy})` : ""}`);
      resolve(parts.join("\n") || "(no output)");
    });
  });
}
