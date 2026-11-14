/** Tool Registry (design doc §7) — metadata-complete registration, native API format output. */
import { validateManifest, type ToolManifest } from "@harness/contracts";
import { validateAgainstSchema } from "./validate.js";

/** Execution context handed to every tool call (design doc §17.4). */
export interface ToolExecutionContext {
  /** Aborts when the turn is cancelled — long-running tools must stop and clean up. */
  signal?: AbortSignal;
}

/**
 * Tools may read the optional context (abort signal) but the old single-argument shape keeps
 * working: a `(input) => Promise<string>` function is assignable to this type.
 */
export type ToolExecute = (input: unknown, ctx?: ToolExecutionContext) => Promise<string>;

export interface ToolEntry {
  manifest: ToolManifest;
  execute: ToolExecute;
}

export class ToolRegistrationError extends Error {
  constructor(tool: string, errors: string[]) {
    super(`Tool "${tool}" rejected by registry:\n  - ${errors.join("\n  - ")}`);
    this.name = "ToolRegistrationError";
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  /** Register throws on any metadata violation — lying on a manifest is a build failure. */
  register(manifest: ToolManifest, execute: ToolExecute): void {
    const errors = validateManifest(manifest);
    if (errors.length) throw new ToolRegistrationError(manifest.name, errors);
    if (this.tools.has(manifest.name)) throw new ToolRegistrationError(manifest.name, ["duplicate name"]);
    this.tools.set(manifest.name, { manifest, execute });
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  list(): ToolManifest[] {
    return [...this.tools.values()].map((t) => t.manifest);
  }

  /** Native /api/chat tool format. */
  toNativeTools(): unknown[] {
    return this.list().map((m) => ({
      type: "function",
      function: { name: m.name, description: m.description, parameters: m.inputSchema },
    }));
  }

  /** Strict input validation before execution — no guessed parameters reach a tool. */
  validateInput(name: string, input: unknown) {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, errors: [`unknown tool "${name}"`] };
    return validateAgainstSchema(input, entry.manifest.inputSchema);
  }
}
