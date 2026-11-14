#!/usr/bin/env node
/**
 * launchd hosting for the two long-lived pieces of the platform (design doc §17.4 item 2).
 *
 *   node scripts/service/install.mjs install qdrant      # vector store, KeepAlive
 *   node scripts/service/install.mjs install scheduler   # `harness auto start`, KeepAlive
 *   node scripts/service/install.mjs install all
 *   node scripts/service/install.mjs status
 *   node scripts/service/install.mjs uninstall qdrant|scheduler|all
 *
 * Why launchd instead of `nohup`: a login agent survives terminal close, restarts on crash, and is
 * stopped by one command — the whole point of §17.2's "stopping is not killing".
 *
 * launchd is deliberately user-scoped (gui/<uid>): the harness is a personal platform, not a daemon
 * running as root. No sudo anywhere in this file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const UID = process.getuid?.() ?? 0;
const AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const HARNESS_DIR = join(HOME, ".harness");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const QDRANT_BIN = join(HARNESS_DIR, "bin", "qdrant");
const QDRANT_DIR = join(HARNESS_DIR, "qdrant");
const LOG_DIR = join(HARNESS_DIR, "logs");

/** launchctl speaks to the user's GUI domain; anything else means "not installed", never a crash. */
function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  } catch (err) {
    if (!quiet) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`  ! launchctl ${args.join(" ")} — ${detail}`);
    }
    return "";
  }
}

function plistString(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function plist(label, { args, cwd, env = {}, logFile, keepAlive = true }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${plistString(k)}</key><string>${plistString(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistString(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${plistString(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${plistString(cwd)}</string>
${envXml ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n` : ""}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><${keepAlive ? "true" : "false"}/>
  <key>StandardOutPath</key><string>${plistString(logFile)}</string>
  <key>StandardErrorPath</key><string>${plistString(logFile)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

const SERVICES = {
  qdrant: {
    label: "com.harness.qdrant",
    logFile: join(QDRANT_DIR, "qdrant.log"),
    describe: "Qdrant 向量库 (127.0.0.1:6333)",
    preflight() {
      if (!existsSync(QDRANT_BIN)) {
        throw new Error(
          `缺少 qdrant 二进制：${QDRANT_BIN}\n` +
            "  Qdrant 不在 Homebrew core，请下载官方 arm64 包：\n" +
            "    mkdir -p ~/.harness/bin && curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.harness/bin",
        );
      }
      mkdirSync(join(QDRANT_DIR, "storage"), { recursive: true });
      return plist("com.harness.qdrant", {
        args: [QDRANT_BIN],
        cwd: QDRANT_DIR,
        env: {
          QDRANT__STORAGE__STORAGE_PATH: join(QDRANT_DIR, "storage"),
          QDRANT__SERVICE__HOST: "127.0.0.1",
        },
        logFile: join(QDRANT_DIR, "qdrant.log"),
      });
    },
  },
  scheduler: {
    label: "com.harness.scheduler",
    logFile: join(LOG_DIR, "scheduler.log"),
    describe: "定时调度器 (harness auto start)",
    preflight() {
      const cli = join(REPO_ROOT, "packages", "cli", "dist", "main.js");
      if (!existsSync(cli)) {
        throw new Error(`缺少 CLI 构建产物：${cli}\n  先运行: pnpm build`);
      }
      mkdirSync(LOG_DIR, { recursive: true });
      return plist("com.harness.scheduler", {
        args: [process.execPath, cli, "auto", "start"],
        cwd: REPO_ROOT,
        env: {
          PATH: `${join(HARNESS_DIR, "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME,
        },
        logFile: join(LOG_DIR, "scheduler.log"),
      });
    },
  },
};

function install(name) {
  const service = SERVICES[name];
  if (!service) throw new Error(`未知服务 ${name}（可选：${Object.keys(SERVICES).join(" / ")} / all）`);
  const content = service.preflight();
  mkdirSync(AGENTS_DIR, { recursive: true });
  const file = join(AGENTS_DIR, `${service.label}.plist`);
  writeFileSync(file, content, "utf8");
  launchctl(["bootout", `gui/${UID}/${service.label}`], { quiet: true });
  const out = launchctl(["bootstrap", `gui/${UID}`, file], { quiet: true });
  const loaded = launchctl(["print", `gui/${UID}/${service.label}`], { quiet: true }).includes(service.label);
  if (!loaded) {
    throw new Error(
      `launchd 未接受 ${service.label}。\n` +
        `  在系统终端里手动执行: launchctl bootstrap gui/${UID} ${file}\n` +
        (out ? `  launchctl 输出: ${out.trim()}` : ""),
    );
  }
  console.log(`✓ ${service.describe} 已由 launchd 托管`);
  console.log(`  plist: ${file}`);
  console.log(`  日志:  ${service.logFile}`);
}

function uninstall(name) {
  const service = SERVICES[name];
  if (!service) throw new Error(`未知服务 ${name}`);
  launchctl(["bootout", `gui/${UID}/${service.label}`], { quiet: true });
  const file = join(AGENTS_DIR, `${service.label}.plist`);
  if (existsSync(file)) unlinkSync(file);
  console.log(`✓ ${service.describe} 已停止并从 launchd 移除`);
}

function status() {
  console.log(`launchd 用户域: gui/${UID}\n`);
  for (const [name, service] of Object.entries(SERVICES)) {
    const out = launchctl(["print", `gui/${UID}/${service.label}`], { quiet: true });
    const loaded = out.includes(service.label);
    const state = /state = (\w+)/.exec(out)?.[1] ?? "—";
    const pid = /pid = (\d+)/.exec(out)?.[1];
    console.log(`${loaded ? "●" : "○"} ${name.padEnd(10)} ${service.describe}`);
    console.log(`   ${loaded ? `已加载，状态 ${state}${pid ? `，pid ${pid}` : ""}` : "未加载"}`);
  }
  const qdrant = probe("http://127.0.0.1:6333/collections");
  console.log(`\nQdrant HTTP: ${qdrant ? "在线" : "离线"}`);
}

function probe(url) {
  try {
    execFileSync("curl", ["-s", "--max-time", "2", url], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const [command, target = "all"] = process.argv.slice(2);
const targets = target === "all" ? Object.keys(SERVICES) : [target];

try {
  switch (command) {
    case "install":
      for (const name of targets) install(name);
      break;
    case "uninstall":
    case "remove":
      for (const name of targets) uninstall(name);
      break;
    case "status":
    case "list":
      status();
      break;
    default:
      console.log(
        [
          "用法:",
          "  node scripts/service/install.mjs install qdrant|scheduler|all",
          "  node scripts/service/install.mjs status",
          "  node scripts/service/install.mjs uninstall qdrant|scheduler|all",
        ].join("\n"),
      );
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
