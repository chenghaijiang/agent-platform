/** NDJSON trace writer (design doc §13) — every session event becomes one JSON line. */
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@harness/contracts";

export class TraceWriter {
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.file = join(dir, `${date}.ndjson`);
  }

  write(event: SessionEvent): void {
    appendFileSync(this.file, JSON.stringify(event) + "\n");
  }
}
