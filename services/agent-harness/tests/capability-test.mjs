// Agent Harness 能力验证套件（单元级，确定性组件，不依赖 LLM）
// 运行：node tests/capability-test.mjs
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scheduleCalls, DEFAULT_PARALLEL_LIMIT } from "../packages/core/dist/tool/scheduler.js";
import { PermissionService, isReadOnlyCommand } from "../packages/core/dist/permission/service.js";
import { TurnMachine } from "../packages/core/dist/turn/machine.js";
import { microCompact, autoCompact, RapidRefillGuard } from "../packages/core/dist/compact/compact.js";
import { estimateTokens, messagesTokens } from "../packages/core/dist/context/tokens.js";
import { MemoryManager } from "../packages/core/dist/memory/manager.js";
import { SharedTaskBoard } from "../packages/core/dist/tasks/board.js";
import { AgentMessageChannel } from "../packages/core/dist/tasks/message.js";
import { parseSchedule, nextRunAt, nextRunAtFrom, ScheduleError } from "../packages/core/dist/automation/schedule.js";
import { WorktreeManager } from "../packages/core/dist/worktree/worktree.js";
import { ToolRegistry } from "../packages/core/dist/tool/registry.js";
import { checkRedLines } from "../packages/contracts/dist/index.js";

let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    pass++; results.push(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    fail++; results.push(`  ❌ ${name} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg ?? "值不等"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// contracts 真实类型形状
const manifestOf = (name, over = {}) => ({
  name, description: name, permission: "read", readOnly: true,
  destructive: false, concurrentSafe: true, needsApproval: false,
  inputSchema: { type: "object", properties: {} }, ...over,
});
let seq = 0;
const callOf = (tool, input = {}) => ({ id: `${tool}-${++seq}`, tool, input });
// PermissionRequest = { call, level }
const requestOf = (call, manifest) => ({ call, level: manifest.permission });

console.log("\n═══ Agent Harness 能力验证（单元级） ═══\n");

// ── 1. Wave 调度器 ──────────────────────────────────────────────
console.log("1️⃣  Wave 调度器（tool scheduler）");
await check("只读可并发工具 → 单个并行 wave", () => {
  const entries = [
    { call: callOf("fs:read_file"), manifest: manifestOf("fs:read_file") },
    { call: callOf("shell:run"), manifest: manifestOf("shell:run") },
    { call: callOf("kb:search"), manifest: manifestOf("kb:search") },
  ];
  const waves = scheduleCalls(entries);
  eq(waves.length, 1, "wave 数");
  eq(waves[0].parallel, true, "应标记 parallel");
  eq(waves[0].calls.length, 3, "成员数");
});
await check("破坏性工具被抽出为独立串行 wave、绝不与任何调用并行", () => {
  const writeM = manifestOf("fs:write_file", { destructive: true, concurrentSafe: false, readOnly: false, permission: "write" });
  const entries = [
    { call: callOf("fs:read_file", { path: "a" }), manifest: manifestOf("fs:read_file") },
    { call: callOf("fs:write_file"), manifest: writeM },
    { call: callOf("fs:read_file", { path: "b" }), manifest: manifestOf("fs:read_file") },
  ];
  const waves = scheduleCalls(entries);
  const writeWave = waves.find(w => w.calls.some(c => (c.tool ?? c.call?.tool) === "fs:write_file"));
  assert(writeWave, "write 所在 wave 存在");
  eq(writeWave.parallel, false, "write wave 应为串行");
  eq(writeWave.calls.length, 1, "write 独占 wave（不与任何调用并行）");
});
await check("并发上限 cap 生效（25 个调用 / limit 10 → 3 waves）", () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({ call: callOf("kb:search", { q: i }), manifest: manifestOf("kb:search") }));
  const waves = scheduleCalls(entries, 10);
  assert(waves.every(w => w.parallel), "全部并行 wave");
  eq(waves.length, 3, "25/10 → 3 waves");
  eq(waves[0].calls.length, DEFAULT_PARALLEL_LIMIT, "首 wave 满员");
});
await check("确定性：同输入同输出", () => {
  const mk = () => Array.from({ length: 8 }, (_, i) => ({ call: { id: `fixed-${i}`, tool: "kb:search", input: { q: i } }, manifest: manifestOf("kb:search") }));
  eq(JSON.stringify(scheduleCalls(mk())), JSON.stringify(scheduleCalls(mk())));
});

// ── 2. 权限与红线 ────────────────────────────────────────────────
console.log("\n2️⃣  权限护栏（permission & red lines）");
await check("硬红线：毁灭性命令被拒（不可配置覆盖）", () => {
  assert(checkRedLines("rm -rf ~") !== null, "rm -rf ~ 应命中");
  assert(checkRedLines("rm -rf /Users/chenghaijiang") !== null, "家目录绝对路径应命中");
  assert(checkRedLines("mkfs.ext4 /dev/disk0") !== null, "磁盘毁灭命令应命中");
});
await check("无害命令不触发红线", () => {
  eq(checkRedLines("ls -la packages"), null, "ls 不应命中");
  eq(checkRedLines("du -sh ."), null, "du 不应命中");
});
await check("shell 只读策略：白名单放行 / 注入与写操作拒绝", () => {
  eq(isReadOnlyCommand("ls -la"), true, "ls");
  eq(isReadOnlyCommand("git status && git log"), true, "只读 git 组合");
  eq(isReadOnlyCommand("git push origin main"), false, "push 非只读");
  eq(isReadOnlyCommand("cat a; rm -rf b"), false, "分号拼接含删除 → 拒");
  eq(isReadOnlyCommand("echo hi > /etc/hosts"), false, "重定向 → 拒");
  eq(isReadOnlyCommand("find . -name x -delete"), false, "find -delete → 拒");
  eq(isReadOnlyCommand("cat a | sh"), false, "管道到 sh → 拒");
});
await check("PermissionService 决策链：denylist > 红线 > allowlist > 只读降级 > 审批", () => {
  const ro = manifestOf("shell:run");
  const rw = manifestOf("fs:write_file", { readOnly: false, permission: "write", destructive: false, concurrentSafe: false });
  const destructive = manifestOf("fs:write_file", { readOnly: false, permission: "destructive", destructive: true, concurrentSafe: false });

  const svcDeny = new PermissionService({ permissions: { denylist: ["shell:*"] } });
  const d1 = svcDeny.evaluate(requestOf(callOf("shell:run", { command: "ls" }), ro), ro);
  eq(d1.kind, "denied", "denylist 通配拒绝");

  const svc = new PermissionService({ approvalHandler: async () => "allowed" });
  const d2 = svc.evaluate(requestOf(callOf("shell:run", { command: "ls packages" }), ro), ro);
  eq(d2.kind, "allowed", "只读命令降级放行");
  const d3 = svc.evaluate(requestOf(callOf("fs:write_file", { path: "x" }), rw), rw);
  eq(d3.kind, "allowed", "write 级不在默认 confirm_levels → 放行");
  const d4 = svc.evaluate(requestOf(callOf("fs:write_file", { path: "x" }), destructive), destructive);
  eq(d4.kind, "needs_user_approval", "destructive 需审批");
});
await check("红线在任何配置下都生效（denylist 移除也拦不住红线外的东西？——红线是独立层）", () => {
  const svc = new PermissionService({});
  const d = svc.evaluate(requestOf(callOf("shell:run", { command: "rm -rf /Users/chenghaijiang" }), manifestOf("shell:run")), manifestOf("shell:run"));
  eq(d.kind, "denied", "rm -rf 家目录直接 denied");
  assert(String(d.reason).includes("red line"), "来源是硬红线");
});

// ── 3. Turn 状态机 ───────────────────────────────────────────────
console.log("\n3️⃣  Turn 状态机（phase machine）");
await check("合法全流程流转（含 cancelling 收口路径）", () => {
  const m = new TurnMachine();
  for (const to of ["awaiting_model", "streaming", "scheduling_tools", "executing_tools", "aggregating_results", "awaiting_model", "streaming", "cancelling", "completing"]) m.to(to);
  eq(m.phase, "completing", "终态");
  eq(m.history.length, 10, "轨迹含初始");
});
await check("空输入轮：processing_input → completing 合法（设计如此）", () => {
  const m = new TurnMachine();
  m.to("completing");
  eq(m.phase, "completing", "空 turn 直接收口");
});
await check("非法转换抛 IllegalPhaseTransitionError（executing_tools → awaiting_model）", () => {
  const m = new TurnMachine();
  m.to("awaiting_model"); m.to("streaming"); m.to("scheduling_tools"); m.to("executing_tools");
  let threw = false;
  try { m.to("awaiting_model"); } catch { threw = true; }
  assert(threw, "executing_tools 不能跳回 awaiting_model（须经 aggregating_results）");
});
await check("终态封闭：completing 无出路", () => {
  const m = new TurnMachine();
  m.to("completing");
  let threw = false;
  try { m.to("awaiting_model"); } catch { threw = true; }
  assert(threw, "completing → 任何状态应被拒");
});

// ── 4. 上下文压缩 ────────────────────────────────────────────────
console.log("\n4️⃣  上下文压缩（compaction）");
await check("microCompact：旧 tool 结果被占位、call/result 链完整成对", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "goal" },
    { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "shell:run", input: {} }] },
    { role: "tool", content: "very long output ".repeat(100) },
    { role: "user", content: "recent goal" },
    { role: "assistant", content: "recent answer" },
  ];
  const out = microCompact(msgs, 1);
  assert(out.some(m => m.role === "tool" && m.content.includes("omitted")), "旧 tool 结果应被占位");
  assert(out.some(m => m.role === "assistant" && m.toolCalls?.length), "assistant.tool_calls 保留");
  assert(out.some(m => m.role === "tool"), "tool 消息保留（成对不断链）");
});
await check("autoCompact：产物 = system + 摘要 + 近期轮（结构正确、近期原样）", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "第一个目标" },
    { role: "assistant", content: "第一个结论" },
    { role: "user", content: "第二个目标" },
    { role: "assistant", content: "第二个结论" },
    { role: "user", content: "最新目标" },
    { role: "assistant", content: "最新回答" },
  ];
  const out = autoCompact(msgs, 1);
  eq(out[0].role, "system", "开头是 system");
  assert(JSON.stringify(out).includes("第一个目标"), "摘要含历史轮");
  eq(out[out.length - 1].content, "最新回答", "近期轮原样保留");
  assert(out.length < msgs.length, "消息条数变少（历史折叠为摘要）");
});
await check("token 估算可用（messagesTokens）", () => {
  const msgs = [{ role: "user", content: "hello world" }];
  const t = messagesTokens(msgs);
  assert(t > 0 && t < 50, `合理区间, 实际 ${t}`);
});
await check("RapidRefillGuard：压缩后仍 >80% → 激活防抖，可复位", () => {
  const guard = new RapidRefillGuard();
  eq(guard.check(950, 1000), true, "950 > 1000*0.8 → 激活");
  eq(guard.isActive, true, "激活状态");
  guard.reset();
  eq(guard.check(500, 1000), false, "复位后低水位不激活");
});

// ── 5. 三层记忆 ──────────────────────────────────────────────────
console.log("\n5️⃣  三层记忆（memory）");
await check("L3 写入注入 + 超限拒绝 + 日志追加/读取/轮转", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-mem-home-"));
  const ws = mkdtempSync(join(tmpdir(), "harness-mem-ws-"));
  try {
    const mem = new MemoryManager(ws, { homeDir: home, l3MaxChars: 50 });
    mem.appendLongTerm("用户偏好：本地优先");
    assert(mem.loadMemoryContext().includes("本地优先"), "L3 长期笔记应注入上下文");
    let threw = false, errName = "";
    try { for (let i = 0; i < 10; i++) mem.appendLongTerm("x".repeat(20)); }
    catch (e) { threw = true; errName = e.name ?? ""; }
    assert(threw && errName === "MemoryLimitError", `超限应抛 MemoryLimitError，实际 ${errName || "无异常"}`);
    mem.appendDailyLog("今天完成了能力验证");
    assert(mem.loadMemoryContext().includes("能力验证"), "L3 日志应注入");
    const rotated = mem.rotateOldLogs(0);
    assert(Array.isArray(rotated), "轮转返回被处理日志列表");
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); }
});

// ── 6. 共享任务板 + 消息通道 ─────────────────────────────────────
console.log("\n6️⃣  多 Agent 协作（shared task board + messages）");
await check("add → claim → 他人二次认领被拒 → complete → 结果可查", async () => {
  const ws = mkdtempSync(join(tmpdir(), "harness-board-"));
  try {
    const board = new SharedTaskBoard(ws);
    const t = await board.add("写集成测试");
    const claim1 = await board.claim(t.id, "alice");
    assert(claim1.ok !== false && claim1.task?.claimedBy === "alice", "alice 认领成功");
    let conflict = false;
    try { await board.claim(t.id, "bob"); } catch { conflict = true; }
    const current = (await board.list()).find(x => x.id === t.id);
    assert(conflict || current.claimedBy === "alice", "bob 二次认领应被拒或被拒之门外");
    await board.complete(t.id, "alice", "测试已写完");
    const done = (await board.list()).find(x => x.id === t.id);
    eq(done.status, "done", "状态 done");
    eq(done.result, "测试已写完", "结果已记录");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
await check("20 并发 add 无丢失", async () => {
  const ws = mkdtempSync(join(tmpdir(), "harness-board2-"));
  try {
    const board = new SharedTaskBoard(ws);
    await Promise.all(Array.from({ length: 20 }, (_, i) => board.add(`任务 ${i}`)));
    eq((await board.list()).length, 20, "全部落盘");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
await check("消息通道 send → drain（读后即清）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "harness-msg-"));
  try {
    const ch = new AgentMessageChannel(ws);
    await ch.send("bob", "alice", "请认领任务 T1");
    const inbox1 = await ch.drain("bob");
    eq(inbox1.length, 1, "收到 1 条");
    eq(inbox1[0].from, "alice", "发送者正确");
    eq((await ch.drain("bob")).length, 0, "drain 后清空");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// ── 7. 定时调度表达式 ────────────────────────────────────────────
console.log("\n7️⃣  定时调度（automation）");
await check("@daily / @weekly / @once 解析与下次触发时间", () => {
  const daily = parseSchedule("@daily 09:00");
  eq(daily.kind, "daily", "kind");
  const from = new Date("2026-11-07T10:00:00").getTime();
  const next = nextRunAtFrom(daily, from);
  assert(next !== null && new Date(next).getHours() === 9, "下次触发在 9 点");
  const weekly = parseSchedule("@weekly MO,WE,FR 09:00");
  eq(weekly.kind, "weekly", "weekly kind");
  const once = parseSchedule("@once 2026-11-08T09:00");
  eq(once.kind, "once", "once kind");
  assert(nextRunAt("@once 2026-11-08T09:00") > Date.now(), "once 在未来");
});
await check("非法表达式结构化报错（ScheduleError）", () => {
  let threw = false, name = "";
  try { parseSchedule("@weekly XXYZ 25:99"); } catch (e) { threw = true; name = e.name ?? ""; }
  assert(threw && name === "ScheduleError", `应抛 ScheduleError，实际 ${name || "无异常"}`);
});

// ── 8. Worktree 隔离（本仓库为真实 git 仓库） ─────────────────────
console.log("\n8️⃣  Worktree 隔离（git worktree）");
await check("create → list → diffSummary → remove 全生命周期无残留", async () => {
  const repo = process.cwd();
  const mgr = new WorktreeManager();
  const info = await mgr.create(repo, "verify-test");
  try {
    assert(existsSync(info.path), `工作树应存在: ${info.path}`);
    const list = await mgr.list(repo);
    assert(list.some(w => (w.path ?? "").includes("verify-test")), "list 应包含该树");
    writeFileSync(join(info.path, "harness-verify.txt"), "isolation check\n");
    const diff = await mgr.diffSummary("verify-test", repo);
    assert(typeof diff === "string", "diff 摘要返回");
  } finally {
    await mgr.remove("verify-test", { repoRoot: repo, force: true });
  }
  const after = await mgr.list(repo);
  assert(!after.some(w => (w.path ?? "").includes("verify-test")), "清理后无残留");
});
await check("非 git 目录结构化报错（不崩溃）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-nongit-"));
  try {
    const mgr = new WorktreeManager();
    let threw = false;
    try { await mgr.create(dir, "x"); } catch { threw = true; }
    assert(threw, "非 git 仓库应报错");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 9. 工具注册校验 ──────────────────────────────────────────────
console.log("\n9️⃣  工具注册校验（manifest 谎报即拒）");
await check("破坏性 + concurrentSafe 谎报被拒", () => {
  const reg = new ToolRegistry();
  let threw = false;
  try {
    reg.register(manifestOf("bad:tool", { destructive: true, concurrentSafe: true, readOnly: false, permission: "destructive" }), async () => "x");
  } catch { threw = true; }
  assert(threw, "谎报 manifest 应拒绝注册");
});

// ── 10. RAG 检索（Qdrant 在线直查） ──────────────────────────────
console.log("\n🔟 RAG 检索（Qdrant + FTS5）");
await check("kb.search：混合检索命中降级策略文档", async () => {
  const kbDb = process.env.HARNESS_KB_DB ?? join(process.cwd(), ".harness", "knowledge", "kb.db");
  assert(existsSync(kbDb), `kb.db 存在: ${kbDb}`);
  const { KnowledgeBase } = await import("../packages/kb/dist/index.js");
  const kb = new KnowledgeBase({ dbPath: kbDb });
  const r = await kb.search("降级策略", 3);
  assert(r.hits.length >= 1, `命中 ${r.hits.length} 条`);
  const joined = JSON.stringify(r.hits);
  assert(joined.includes("retrieval"), "命中 retrieval.md");
});

console.log(results.join("\n"));
console.log(`\n═══ 结果: ${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail > 0 ? 1 : 0);
