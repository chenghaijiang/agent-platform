/**
 * Skills (design doc §10 / §10.1) — zero-code extension: a skill is a directory
 * containing SKILL.yaml (manifest) and SKILL.md (body). Activation is dual-channel:
 *   - explicit slash command  /name [args]  (bypasses intent detection)
 *   - implicit keyword match on the user text (harness-side)
 *
 * Discovery order: user dir (~/.harness/skills) then project dir ({cwd}/.harness/skills).
 * Name conflicts resolve project > user (a project skill shadows the user one).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillManifest {
  name: string;
  /** Slash command including the leading "/", e.g. "/commit". Unique after conflict resolution. */
  slash: string;
  keywords: string[];
  description: string;
  /** Human-facing args spec, e.g. "[<message>] 可选：自定义提交信息". */
  args: string;
  argumentHint: string;
  source: "user" | "project";
  /** SKILL.md body ("" when the file is absent — manifest-only skills are legal). */
  body: string;
  dir: string;
}

export class SkillError extends Error {
  constructor(
    readonly code: "SKILL_NOT_FOUND" | "SKILL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

export interface SkillRegistryOptions {
  /** Defaults: ~/.harness/skills and {cwd}/.harness/skills. */
  userDir?: string;
  projectDir?: string;
}

const MANIFEST_HEADER = /^---\s*$/; // optional YAML frontmatter inside SKILL.md is ignored (yaml lives in SKILL.yaml)

export class SkillRegistry {
  private cache: SkillManifest[] | null = null;

  constructor(private readonly opts: SkillRegistryOptions = {}) {}

  /** Rescan both directories. Cheap enough to call before every turn. */
  list(): SkillManifest[] {
    const userDir = this.opts.userDir ?? join(homedir(), ".harness", "skills");
    const projectDir = this.opts.projectDir ?? join(process.cwd(), ".harness", "skills");

    const user = this.scanDir(userDir, "user");
    const project = this.scanDir(projectDir, "project");

    // project > user by `name`; slash conflicts keep the higher-priority entry too.
    const byName = new Map<string, SkillManifest>();
    for (const skill of user) byName.set(skill.name, skill);
    for (const skill of project) byName.set(skill.name, skill);
    this.cache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this.cache;
  }

  /**
   * `/name args…` resolution. Returns null when the text is not a slash command;
   * throws SKILL_NOT_FOUND for an unknown command (design §10.1: a slash is a strong
   * signal — error out instead of degrading to a normal chat turn).
   */
  resolveSlash(text: string): { skill: SkillManifest; args: string } | null {
    if (!text.startsWith("/")) return null;
    const trimmed = text.trim();
    const spaceAt = trimmed.search(/\s/);
    const command = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
    const args = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
    const skills = this.list();
    const skill = skills.find((s) => s.slash === command);
    if (!skill) {
      const known = skills.map((s) => s.slash).join(" ");
      throw new SkillError(
        "SKILL_NOT_FOUND",
        `未知技能命令 ${command}。可用：${known || "（尚未安装任何技能）"}`,
      );
    }
    return { skill, args };
  }

  /** Keyword auto-trigger (design §10.1 implicit channel): whole-token keyword inclusion. */
  matchKeywords(text: string): SkillManifest[] {
    const lower = text.toLowerCase();
    return this.list().filter((skill) =>
      skill.keywords.some((kw) => kw && lower.includes(kw.toLowerCase())),
    );
  }

  /** Build the per-turn system block for injected skills. */
  renderContext(entries: Array<{ skill: SkillManifest; args?: string }>): string {
    if (!entries.length) return "";
    return entries
      .map(({ skill, args }) => {
        const parts = [
          `### 技能：${skill.slash}（${skill.name}）`,
          skill.description ? `说明：${skill.description}` : "",
          skill.body ? `\n${skill.body}` : "",
          args ? `\n用户参数: ${args}` : "",
        ];
        return parts.filter(Boolean).join("\n");
      })
      .join("\n\n---\n\n");
  }

  /** Scan one directory; invalid entries are skipped (a broken skill must not break startup). */
  private scanDir(dir: string, source: "user" | "project"): SkillManifest[] {
    if (!existsSync(dir)) return [];
    const out: SkillManifest[] = [];
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
        const manifestPath = join(skillDir, "SKILL.yaml");
        if (!existsSync(manifestPath)) continue;
        const manifest = parseManifest(readFileSync(manifestPath, "utf8"), skillDir, source);
        const bodyPath = join(skillDir, "SKILL.md");
        const rawBody = existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "";
        manifest.body = stripFrontmatter(rawBody);
        out.push(manifest);
      } catch {
        // Malformed manifest or unreadable body — skip silently, the rest still load.
      }
    }
    return out;
  }
}

/** Minimal YAML subset for SKILL.yaml: flat `key: value`, inline `[a, b]` arrays, `#` comments. */
function parseManifest(raw: string, dir: string, source: "user" | "project"): SkillManifest {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const stripped = line.replace(/#.*$/, "").trim();
    if (!stripped) continue;
    const colon = stripped.indexOf(":");
    if (colon === -1) continue;
    const key = stripped.slice(0, colon).trim();
    const value = stripped.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields.set(key, value);
  }

  const name = fields.get("name") ?? "";
  if (!name) throw new SkillError("SKILL_INVALID", `SKILL.yaml 缺少 name 字段（${dir}）`);
  const slash = fields.get("slash")?.startsWith("/") ? fields.get("slash")! : `/${name}`;
  const keywords = parseList(fields.get("keywords") ?? "");
  return {
    name,
    slash,
    keywords,
    description: fields.get("description") ?? "",
    args: fields.get("args") ?? "",
    argumentHint: fields.get("argument_hint") ?? "",
    source,
    body: "",
    dir,
  };
}

/** `[提交, commit]` → ["提交", "commit"]; also tolerates a bare scalar. */
function parseList(value: string): string[] {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** SKILL.md may carry YAML frontmatter (name/description) — drop it, the manifest is authoritative. */
function stripFrontmatter(body: string): string {
  const lines = body.split("\n");
  if (lines[0] !== undefined && MANIFEST_HEADER.test(lines[0])) {
    const end = lines.findIndex((line, i) => i > 0 && MANIFEST_HEADER.test(line));
    if (end !== -1) return lines.slice(end + 1).join("\n").trim();
  }
  return body.trim();
}
