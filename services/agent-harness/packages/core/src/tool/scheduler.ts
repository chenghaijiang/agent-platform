/**
 * Tool Scheduler — metadata-driven wave planning (design doc §3.1, §6.2, §7).
 *
 * Safety metadata, not luck, decides what may run together:
 * - `concurrentSafe && !destructive` calls are gathered into a parallel wave (bounded by the
 *   configured limit, default 10);
 * - when no such call remains, exactly one call becomes a serial wave — destructive calls
 *   therefore NEVER run in parallel, and neither do tools that did not declare concurrency safety.
 *
 * Grouping is greedy and stable: within a wave the original submission order is preserved, and
 * wave indices are 0-based in plan order.
 */
import type { SchedulingWave, ToolCall, ToolManifest } from "@harness/contracts";

/** Upper bound for a single parallel wave (config.loop.parallel_tool_limit). */
export const DEFAULT_PARALLEL_LIMIT = 10;

export interface ScheduledCall {
  call: ToolCall;
  manifest: ToolManifest;
}

/** A call may join a parallel wave only if it declared both properties truthfully. */
export function isParallelizable(manifest: ToolManifest): boolean {
  return manifest.concurrentSafe && !manifest.destructive;
}

/**
 * Pure function — given the calls of one turn plus their manifests, produce the execution plan.
 * Deterministic: same input (including order) always yields the same waves.
 */
export function scheduleCalls(
  entries: readonly ScheduledCall[],
  limit: number = DEFAULT_PARALLEL_LIMIT,
): SchedulingWave[] {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const pending = entries.slice();
  const waves: SchedulingWave[] = [];

  while (pending.length > 0) {
    const group: ScheduledCall[] = [];
    for (let i = 0; i < pending.length && group.length < cap; ) {
      const candidate = pending[i]!;
      if (isParallelizable(candidate.manifest)) {
        group.push(candidate);
        pending.splice(i, 1); // keep scanning at the same index — `pending[i]` is now a new call
      } else {
        i++; // leave non-parallelizable calls for a serial wave
      }
    }

    if (group.length > 0) {
      waves.push({ index: waves.length, calls: group.map((g) => g.call), parallel: true });
      continue;
    }

    // Nothing left that may run concurrently: execute one call on its own.
    const single = pending.shift()!;
    waves.push({ index: waves.length, calls: [single.call], parallel: false });
  }

  return waves;
}
