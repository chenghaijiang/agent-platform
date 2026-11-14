#!/usr/bin/env node
/**
 * Architecture boundary checker (design doc §12) — structural drift is a build failure.
 *
 * Rules:
 *  R1. contracts 不得 import 其它 @harness 包（contracts 是最底层）。
 *  R2. core 不得 import 客户端表面层（cli/server/web）。
 *  R3. cli/server/web 只能通过根入口 "@harness/core" 引用 core —— 禁止深路径（core 内部不是公共 API）。
 *  R4. 客户端表面层之间（cli/server/web）不得互相 import。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIRS = ["contracts", "core", "cli", "server", "web"].map((p) =>
  join(ROOT, "packages", p, "src"),
);

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|mts|cts|tsx)$/.test(name)) yield full;
  }
}

function collectSources() {
  const files = [];
  for (const dir of SRC_DIRS) {
    try {
      for (const f of walk(dir)) files.push(f);
    } catch {
      /* package src may not exist yet */
    }
  }
  return files;
}

function pkgOf(filePath) {
  const rel = relative(join(ROOT, "packages"), filePath);
  return rel.split(sep)[0];
}

const violations = [];

for (const file of collectSources()) {
  const pkg = pkgOf(file);
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!spec) continue;

    let target = null;
    if (spec.startsWith("@harness/")) {
      target = spec.split("/")[1].split("#")[0];
      const isDeep = spec.split("/").length > 2;
      // R3: clients may only use the bare "@harness/core" root entry.
      if (["cli", "server", "web"].includes(pkg) && target === "core" && isDeep) {
        violations.push(`${relative(ROOT, file)}: R3 deep import "${spec}" — use "@harness/core" only`);
      }
    } else if (spec.startsWith(".") || spec.startsWith("/")) {
      // Relative escape out of the package (e.g. ../../core/src/...) — map it back.
      const resolved = relative(join(ROOT, "packages"), dirname(file));
      const inPackages = !resolved.startsWith("..");
      if (inPackages) {
        const segs = resolved.split(sep);
        target = segs[0] !== pkg ? segs[0] : null;
        if (target && ["cli", "server", "web"].includes(pkg) && target === "core") {
          violations.push(`${relative(ROOT, file)}: R3 relative escape into core ("${spec}")`);
        }
      }
    } else {
      continue; // third-party or node: builtin
    }

    if (!target || !["contracts", "core", "cli", "server", "web"].includes(target)) continue;

    if (pkg === target) continue;
    if (target === "contracts") continue; // everyone may import contracts
    if (pkg === "contracts") {
      violations.push(`${relative(ROOT, file)}: R1 contracts imports @harness/${target}`);
    }
    if (pkg === "core" && ["cli", "server", "web"].includes(target)) {
      violations.push(`${relative(ROOT, file)}: R2 core imports client surface @harness/${target}`);
    }
    if (["cli", "server", "web"].includes(pkg) && ["cli", "server", "web"].includes(target)) {
      violations.push(`${relative(ROOT, file)}: R4 client "${pkg}" imports client "${target}"`);
    }
  }
}

if (violations.length) {
  console.error(`✗ architecture:check — ${violations.length} violation(s):\n`);
  for (const v of [...new Set(violations)]) console.error(`  ${v}`);
  process.exit(1);
}
console.log("✓ architecture:check — all boundary rules hold (R1–R4)");
