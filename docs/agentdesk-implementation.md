# AgentDesk-lite 改造实施方案

> 依据：AgentDesk PRD v0.9（`docs/AgentDesk企业智能体工作台PRD.md`）、交互 demo（`web/agentdesk-demo.html`）、ADR-011/012/013（`../2026/docs/adr/`）
> 决策访谈：2026-11-13，Q1–Q11 全部定案
> 范围：在 T01–T10 知识问答 MVP 基础上新增 Agent 执行域，双功能域并存

---

## 1. 目标与边界

**目标**：一条垂直切片打穿——新建 Agent 任务 → 计划模式产出方案 → 确认执行 → 工具循环真改文件 → L2 命令触发审批（interrupt）→ 检查回灌 → hunk 逐块接受 → 门禁通过提交到 workspace 分支。全程事件流直播 + 审计留痕。

**明确不做**（列为「PRD 有、平台规划中」，演示时如实说明）：

| PRD 条目 | 不做原因 | 归属 |
| --- | --- | --- |
| 独立验证会话 / 视觉验收 | 浏览器自动化 + 视觉判定链路过重 | 阶段三 |
| MCP / Skill / 插件市场 | 生态治理成本高，MVP 无收益 | 阶段三（ACP 适配） |
| 项目记忆 / Repo Wiki | 知识沉淀依赖 RAG 域已有能力可复述 | 阶段三 |
| 移动端审批 | 依赖推送基础设施 | V1+ |
| 多模型路由策略 / 推理强度 | 模型网关已支持 `.env` 切换，路由策略为锦上添花 | V1 |
| 长任务续跑 / 停滞检测 | LangGraph Checkpointer 已留好，交互先不做 | V1 |

## 2. 总体架构

```
┌────────────────────────── Web 前端（双功能域）──────────────────────────┐
│  知识问答域（现有 web/ 五页面，档案室视觉）  │  Agent 工作台（demo 还原，铜色视觉）│
└──────────────────┬───────────────────────────────────┬───────────────────┘
                   │ 复用：登录/JWT/审计页/模型自检     │ 新增 API
┌──────────────────▼───────────────────────────────────▼───────────────────┐
│                        FastAPI 应用（auth 中间件不变）                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ agentdesk  │ │  策略引擎   │ │ Agent Graph  │ │   事件订阅 API      │  │
│  │  api       │→│ (四档模式×  │→│ (LangGraph:  │→│  SSE + Last-Event- │  │
│  │ (任务CRUD) │ │  工具×命令) │ │  计划→工具循 │ │  ID 回放)           │  │
│  └────────────┘ └────────────┘ │  环→检查)    │ └────────────────────┘  │
│  ┌────────────┐ ┌────────────┐ └──────────────┘ ┌────────────────────┐  │
│  │ 工具层     │ │ workspace  │                  │ 审计（域标签扩展）    │  │
│  │ read/patch │ │ workspaces/│                  │ chat | agentdesk    │  │
│  │ /cmd/git   │ │ <task_id>/ │                  └────────────────────┘  │
│  └────────────┘ └────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────┘
        复用：模型网关（真实 key）· PG 队列 · Checkpointer · Langfuse
```

**关键复用**（T01–T10 资产）：

| 资产 | 复用方式 |
| --- | --- |
| 模型网关 | Agent 工具循环的 LLM 调用出口；Agent 域需真实 tool-calling key |
| PG 队列（ADR-005 模式） | Task 调度：`agent_tasks` 表 + SKIP LOCKED + 租约 |
| Postgres Checkpointer | 执行会话状态持久化（thread_id = execution_session_id） |
| 审计事件 | 域标签扩展，`out_of_bounds` / `redline_blocked` / `approval_decided` 新事件类型 |
| 账号体系 | 登录态与角色直接复用，顶栏双功能域入口 |

## 3. 事件协议（task_events 表 + SSE）

**信封**：`{type, seq, ts, data}`；`seq` 为 task 内自增序号，`Last-Event-ID` 断点续传，重连先回放历史再尾随直播（Q7 决策）。

| type | data 要点 | 前端渲染 |
| --- | --- | --- |
| `task_status` | status: created/planned/running/blocked/verifying/partial/review/committed/cancelled | 状态 pill + 任务列表 dot |
| `plan` | steps[{idx,title,detail}], risk, owns | 计划卡 + 确认/调整按钮 |
| `tool_start` | tool, args 摘要, risk_level, decided: auto/pending | 工具卡头（L0/L1/L2 徽标） |
| `tool_result` | output 截断, exit_code, duration | 工具卡体（代码块） |
| `approval_required` | approval_id, command, scope, reason | 审批卡（三选按钮） |
| `approval_resolved` | approval_id, decision: once/always/deny | 审批卡转完成态 |
| `delta` | text | Agent 思考/叙述流式文本 |
| `check_start` / `check_result` | command, status, output 摘要 | 检查行（spinner/✓/✗） |
| `verify` | criteria[]（MVP 仅 checks 汇总） | 证据链推进 |
| `summary` | diff 统计, checks 结论, owns 结论, 提交状态 | 交付摘要卡 |
| `out_of_bounds` | path, tool | 越界提示 + 审计 |
| `redline_blocked` | pattern, command | 红线拦截提示 + 审计 |

**API 面**：

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| POST /api/agentdesk/tasks | Bearer | 创建任务（goal、owns、mode、`@`引用），入队并分配 workspace |
| GET /api/agentdesk/tasks | Bearer | 任务列表（状态点、diff 统计、相对时间） |
| GET /api/agentdesk/tasks/{id} | Bearer | 任务详情（含 owns、mode、会话） |
| GET /api/agentdesk/tasks/{id}/events | Bearer | SSE 事件流（Last-Event-ID 回放） |
| POST /api/agentdesk/tasks/{id}/plan/confirm | Bearer | 确认计划 → 切自动编辑，Run resume |
| POST /api/agentdesk/approvals/{id}/decide | Bearer | 审批三选（once/always/deny），Run resume |
| POST /api/agentdesk/tasks/{id}/hunks | Bearer | hunk 接受/拒绝（body: hunk_id, action） |
| POST /api/agentdesk/tasks/{id}/commit | Bearer | 门禁求值：全部 hunk 已接受 + checks 通过 → workspace 内 git commit |

## 4. Agent Graph 设计

```python
# 形态示意（决策快照，非最终代码）
graph = StateGraph(AgentState)
graph.add_node("plan", plan_node)        # 计划模式：只读工具，产出 plan 事件
graph.add_node("await_confirm", interrupt_confirm)  # interrupt: 用户确认计划
graph.add_node("act", tool_loop_node)    # 工具循环：read_files/apply_patch/run_command
graph.add_node("check", check_node)      # pytest + ruff，失败回灌 act（≤2 轮）
graph.add_node("summarize", summary_node)
# 边：plan → await_confirm → act ↔ check（fail 且轮次<2）→ summarize
# 审批：工具层 policy 求值 → L2 非完全访问 → interrupt() 挂起 → approvals/{id}/decide → resume
```

- **权限引擎**（借鉴 ZCode `permission/service.ts`）：`policy(mode, tool, risk_level, always_allowed) → allow | deny | require_approval`；红线先于模式求值，永远 deny；
- **工具 schema 注册**：`read_files(L0) / apply_patch(L1) / run_command(L2) / git_commit(L2)`；执行器面向接口，阶段三可替换为 ACP 适配器（ADR-012 三层协议）；
- **错误恢复**（借鉴 ZCode 工具循环）：check 失败 → 错误输出截断注入工具结果 → Agent 自主修复，修复轮次 > 2 停止并 `partial`。

## 5. 安全模型（ADR-013 摘要）

L1 owns 路径约束 → L2 红线正则 → L3 四档模式 × 风险等级求值 → L4 审计。**诚实声明**：路径隔离而非容器沙箱；README「能力边界」章节与演示口径一致。

演示 workspace：`workspaces/<task_id>/payment-console/`（pricing.py + test_pricing.py + pyproject.toml），checks = `pytest -q` + `ruff check`。

## 6. 前端改造

- demo（`web/agentdesk-demo.html`）→ 交互与视觉 100% 保留，把写死的数据源替换为真实 API 调用（SSE 订阅 + 事件分发渲染）；
- 现有 web/ 增加顶栏入口「Agent 工作台」，登录页/账号不动；
- 证据链（plan→exec→check→verify→accept）按事件 type 驱动推进；
- 门禁联动：`已接受 3/3` 且 checks 全绿才可提交（demo 逻辑保留）。

## 7. 切片划分（T11 起）

| 票 | 内容 | Blocked by |
| --- | --- | --- |
| T11 | agent_tasks/task_events/审批策略 三表迁移 + workspace 卷 + 演示仓初始化 | — |
| T12 | 策略引擎（owns/红线/模式求值）+ 工具层四工具（schema 注册、截断、超时） | T11 |
| T13 | Agent Graph（plan→confirm→act→check→summarize）+ interrupt 审批 + 事件写入 | T12 |
| T14 | agentdesk API 面（§3 表）+ SSE 事件流（Last-Event-ID 回放） | T13 |
| T15 | 前端：demo 接真 API（事件渲染、审批交互、hunk 接受、门禁提交） | T14 |
| T16 | 端到端冒烟 + README 双口径（能力边界章节、ZCode 借鉴声明）+ 审计域标签 | T15 |

**验收口径**（T16）：真实 key 下，从创建任务到 committed 全程 ≤ 15 分钟人盯演示一次通过；红线命令 100% 拦截并审计；owns 外写路径 100% 拦截并审计；SSE 断线重连（刷新页面）事件零丢失。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 模型 tool-calling 质量不稳定（不同供应商差异） | 网关已多形态支持，演示锁定单一供应商 + 固定演示任务脚本 |
| 工具循环失控（步数/成本） | 最大步数硬上限 + 单任务 token 预算 + 超限转 partial |
| 审批 SSE 与 resume 时序竞态 | interrupt 状态由 Checkpointer 持久化，事件表 seq 单调，前端以事件表为准 |
| demo 交互复杂度回归 | demo 本身保留为「交互规格说明书」，前端实现对照其行为逐项验收 |
