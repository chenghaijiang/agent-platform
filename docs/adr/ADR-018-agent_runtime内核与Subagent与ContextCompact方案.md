# ADR-018：agent_runtime 自研内核与 Subagent / Context Compact 方案

- 状态：已接受
- 日期：2026-11-14
- 关联：ADR-015（分期与自研内核裁决）、ADR-016（Profile/model_policy/Permission 泛化时机）、ADR-017（Subagent 权限收窄、TaskRecord 落 PG）
- 来源：二期开工设计。基于四轮审问既有裁决（Q7/Q8A/Q9A/Q12A/Q15A/Q18A/Q19A）的施工级方案，无新增架构分支。

## 背景

一期（统一工作台 MVP）已交付：数据层迁移 0010、后端桥接（SSE 消息信封 + 审批卡片端点 + model_policy fallback）、前端工作台（Profile 选择器 + 卡片渲染 + 会话流）。桥接层复用 agentdesk LangGraph 图，已知边界：惰性桥接依赖单流假设。

二期按 ADR-015 决策 2 开工自研内核，用户指定 **Subagent 与 Context Compact 前移到二期最前**（Q7）。本 ADR 基于对 agentdesk 图与 runner 现有实现的研读，给出内核方案与首批两项能力的落地设计。

### 现有实现盘点（研读结论）

| 资产 | 形态 | 内核处置 |
| --- | --- | --- |
| `agentdesk/graph.py` | LangGraph StateGraph，9 节点（plan → await_confirm → llm_act ↔ policy_gate/approval ↔ tool_run → check → summarize），interrupt 与副作用分离 | 二期保留不动；内核吸收后退役（Q9A「逐项吸收」） |
| `agentdesk/runner.py` | 三入口 start/confirm_plan/decide + pending_interrupt 查询 + 异常兜底 partial | 语义模板：内核 runner 同构（入口 + 挂起查询 + 兜底） |
| `agentdesk/tools.py` | TOOL_REGISTRY（四工具 ToolSchema）+ ToolExecutor 求值/执行分离（evaluate_only / execute_approved / record_denied / record_pending_approval） | **整体复用**：内核 TOOL_HANDLERS dispatch 直接包装 ToolExecutor |
| `agentdesk/policy.py` | 纯函数 evaluate（红线 → 边界/owns → 模式矩阵 → always_allowed） | M0 包装调用（零漂移）；M3 泛化为声明式 PermissionRule（Q15A） |
| `agentdesk/llm.py` | LLMInvoker 协议 + GatewayInvoker + ScriptedInvoker | **整体复用**：内核循环只依赖该协议（含测试脚本回放） |
| `agentdesk/service.py` | append_event（seq 取号）/ set_task_status / claim_next_task（租约）/ release_lease | **整体复用**：task_events 事件链 + 租约语义不变（Q18A） |
| `workbench/service.py` | append_message（chat_messages）/ bridge_task_events（惰性桥接，单流假设）/ resolve_model_chain（fallback 链） | resolve_model_chain 复用；桥接改内核侧 EventSink 双写（见决策 6） |
| `agentdesk/workspace.py` | WorkspaceManager 拷贝装载演示仓 | M0 复用；Worktree 原地升级是二期后项（Q21A，不在本批） |

## 决策

### 1. 内核形态：`src/agent_platform/agent_runtime/`，`while True + stop_reason + TOOL_HANDLERS + hooks`

模块划分（对应 ADR-015 决策 2 的自研内核基座）：

```
agent_runtime/
├── types.py        # RuntimeState / StopReason / ToolCall / ToolResult / LoopLimits
├── loop.py         # 主循环：compact → hooks → invoke → dispatch → 挂起/终态
├── handlers.py     # TOOL_HANDLERS dispatch map（包装 ToolExecutor + spawn_subagent 特殊 handler）
├── hooks.py        # HOOK_REGISTRY[("pre_tool_use"|"post_tool_use"|"before_llm", fn)]（Q12A）
├── compact.py      # Context Compact 四层管线（决策 3）
├── subagent.py     # SubagentSpec / 权限收窄 / 子循环驱动（决策 2）
├── permission.py   # M0：包装 agentdesk.policy + hooks 挂点；M3：声明式泛化（Q15A）
├── events.py       # EventSink：task_events + chat_messages 双写（决策 6）
├── snapshots.py    # 快照持久化与恢复（决策 5）
└── runner.py       # RuntimeRunner：start / confirm_plan / decide / resume（同构 agentdesk.runner）
```

循环主体（每轮）：

```
while True:
    state = compact.apply(state)              # 决策 3：prompt 组装前四层压缩
    hooks.run("before_llm", state)
    resp = await invoker.invoke(messages, tool_defs)   # LLMInvoker 协议（复用）
    state.messages.append(ai(resp))
    if not resp.tool_calls:
        await gate.run_checks(state)          # check 门禁（profile 可配；失败回注重试）
        return stop(end_turn | max_check_rounds → partial)
    for call in resp.tool_calls:
        verdict = hooks.run("pre_tool_use", call)       # hook 可否决/改写
        decision = await permission.evaluate(call)      # 红线→边界→模式→授权（包装期零漂移）
        if decision.require_approval:
            await sink.approval_required(call)          # 审批单 + 事件（复用 agentdesk service）
            return stop(waiting_approval)               # 挂起：快照落库，decide 端点 resume
        result = await handlers.dispatch(call)          # execute_approved（复用）
        hooks.run("post_tool_use", call, result)
        state.messages.append(tool(result))
    if state.steps >= limits.max_steps or state.total_tokens >= limits.max_tokens:
        return stop(max_steps | max_tokens → partial)
```

- **计划确认**保留产品语义（Q4A/Q5A）：`submit_plan` 为特殊 handler——LLM 输出计划 → `needs_confirm` 模式下 `stop(waiting_plan_confirm)` 挂起，confirm 端点 resume 后切 auto_edit（与旧图 await_confirm 行为一致）。
- **StopReason 枚举**：`end_turn / waiting_plan_confirm / waiting_approval / max_steps / max_tokens / cancelled / error`，映射 task 状态机（running/blocked/verifying/review/partial/cancelled）与旧图语义等价。
- **内核引擎接入**：`agent_profiles.engine_kind` 增加 `runtime` 值；workbench 创建任务后按 profile 分派到 RuntimeRunner（旧 `agentdesk_bridge` 路径不动，过渡期双引擎并存，golden 测试锁行为等价——Q17A 延续）。

### 2. Subagent：fresh messages[] 隔离 + 权限收窄交集 + 审批冒泡（Q19A）

```python
@dataclass(frozen=True)
class SubagentSpec:
    name: str                       # 事件留痕与聊天流标签（subagent:<name>）
    instructions: str               # 任务简报 = 子循环 fresh messages[] 的首条 user 消息
    owns: list[str] | None = None   # 收窄后的 owns（None = 继承父；只可取父集合子集）
    mode: str | None = None         # 收窄后的 mode（None = 继承父；只可降档：confirm>auto_edit>plan）
    allowed_tools: tuple[str, ...] | None = None   # 工具白名单（父工具集子集）
    max_steps: int = 6              # 子步数预算（默认小于父）
```

- **spawn 为特殊 handler**（`spawn_subagent`，需在父 profile 工具白名单中显式开启）：校验收窄合法性（owns ⊆ 父 owns、mode ≤ 父 mode、tools ⊆ 父工具集，违反即 deny 事件）→ 构造 `RuntimeState.fresh(instructions)`（**上下文隔离：子循环看不到父消息历史**）→ 递归进入 `loop.run`（子状态、收窄权限、子步数预算）→ 子循环 `end_turn` 后取最终叙述文本作为 ToolResult 回注父上下文。
- **权限继承并收窄**（Q19A）：子代理求值上下文 = 父 Task 的 mode/owns/grants 与 SubagentSpec 的交集，只可收窄不可放大；`full_access` 父可产出 `confirm` 子，反之不行。
- **审批冒泡**：子循环命中 `require_approval` 时——审批单与 `approval_required` 事件照常落库（`data.subagent = spec.name` 标注来源），**stop_reason 沿调用栈上浮**：子循环挂起 → spawn handler 返回 waiting_approval → 父循环同帧挂起（父本就阻塞在 spawn await 上）。用户在聊天流点卡片 → `decide` 端点 resolve → resume 从嵌套快照恢复父子两层循环。**一次决策对父子同时生效**：spawn 栈只在审批挂起点分叉，恢复后子循环先消费决策，父循环无感知续跑。
- **事件可观测**：子代理所有 task_events 带 `subagent` 字段；EventSink 转写 chat_messages 时保留该字段，前端 evt-line 渲染 `subagent:research` 前缀标签（前端改动随 M1 交付）。
- **否决记录**：天然全量（spawn 绕过 owns/审批）与独立声明（子代理自带权限）已在 Q19A 否决，本方案为「继承并收窄」的直接实现。
- 三期衔接：审批冒泡的「决策对父子同时生效」即 Agent Teams 收件箱语义的前置形态（Q19A 原文）。

### 3. Context Compact：snip / micro / budget / auto 四层管线

触发点统一在**每轮 LLM 调用前的 prompt 组装管线**（`compact.apply(state)`），四层按序降级应用，直至上下文落在预算内：

| 层 | 作用面 | 触发条件 | 行为 |
| --- | --- | --- | --- |
| **snip** | 单条工具输出 | 写入 messages 前静态生效 | 按工具类型配置摘要策略（run_command 保留首尾+stderr 段；read_files 行数上限），超限替换为 `[snip] 原始 N 字符` 占位——泛化 tools._truncate 的头 1/3+尾 2/3 策略 |
| **micro** | 旧轮次消息对 | 消息数超过保留窗口 | 最近 K 轮（默认 4）之外的已消费 tool_calls/ToolMessage 对折叠为单行摘要（`tool:read_files → ok(120 lines)`），AIMessage 叙述文本保留 |
| **budget** | 最旧对话轮次 | total_tokens ≥ 预算 80% | 系统提示与最近窗口之外的轮次压缩为结构化摘要（含：目标、已完成步骤、关键发现、待办），规则拼接生成 |
| **auto** | 强制收缩 | 压缩后仍超预算 | 收缩到「系统提示 + 摘要 + 最近 2 轮」并注入 compact 通知消息（LLM 感知上下文被压缩），任务继续不中断 |

- **摘要生成 = 规则拼接**（M1 确定性优先，演示项目基调）：压缩摘要由已完成步骤、工具结论、check 结果等结构化信息规则拼装，零 token 成本、可单测；LLM 生成摘要留作 M2 后可选增强。
- **可观测**：每次压缩写 task_events（`compact` 事件：level、释放 token 数、保留窗口）并经 EventSink 转发聊天流，前端 evt-line 新增 compact 标签——与 Q5A「执行事件流」同一观测口径。
- **与 budget 语义的关系**：循环的 `max_tokens` 终态判定基于压缩后的实际用量——Compact 是预算的守护者而非竞争者：snip/micro 常态运行，budget/auto 在逼近上限时兜底，尽量把 `max_tokens → partial` 降级转化为压缩续跑。
- **Subagent 联动**：子循环独立适用四层管线（子上下文更小，micro 窗口与预算按 SubagentSpec 收紧）——这正是 ADR-015 把两项能力并列前移的原因：Subagent 制造隔离上下文，Compact 保证隔离上下文不膨胀。

### 4. 状态持久化与恢复：`runtime_snapshots` 表 + 租约协同（Q18A）

- 新增表 `runtime_snapshots(id, task_id, step, state JSONB, created_at)`：**每轮循环结束（含挂起与终态前）写一步快照**；`state` 含 messages、plan、steps/total_tokens、check_rounds、子代理嵌套栈（spawn 中的 SubagentSpec + 子 messages）。
- 挂起恢复：`waiting_plan_confirm / waiting_approval` 挂起前先落快照 → `confirm_plan / decide` 端点校验挂起态（同 agentdesk.runner 的 expect_kind/approval_id 匹配语义）→ resume 从最新快照重建循环。
- 进程崩溃恢复：复用租约模式（claim_next_task 已覆盖 created 认领）；对 running 态任务，runner 启动时检测「租约过期 + 最新快照」→ 从快照续跑（attempts 已计数，如实留痕）。
- 与 Checkpointer 分工延续 Q11A 口径：LangGraph checkpointer 只管 QA 图；agentdesk 图继续用其自身 checkpointer；内核用 runtime_snapshots。三套互不越界。

### 5. 权限管线：M0 包装零漂移，M3 声明式泛化（Q15A）

- M0（内核闭环）：`agent_runtime/permission.py` 直接包装 `agentdesk.policy.evaluate`（同参转发，求值结果零漂移），hooks 挂点在包装层前后（pre 求值前、post 落审计前）。
- M3（内核吸收旧图时）：泛化为声明式 `PermissionRule` 管线（规则表 + 审批管线 + hooks 挂点），golden 测试对四工具 × 四模式 × 红线/越界样本集锁两实现行为等价，等价后 agentdesk 图切至新管线再退役旧 policy。Q15A 裁决「二期内核开工时抽取」如实分期：抽取动作在 M3，包装不改变行为等价承诺。

### 6. 事件出口：内核 EventSink 双写，替代惰性桥接

- 内核执行域内事件统一经 `events.EventSink` 落库：同一事务写 `task_events`（证据链/审计口径不变）+ `chat_messages`（会话流水），**替代 workbench 的惰性桥接**（bridge_task_events 保留给旧 agentdesk_bridge 路径，双引擎过渡期互不干扰）。
- 收益：消除 workbench/service.py 声明的「并发双流双写」边界（聊天流单源化：回放与实时都从 chat_messages 读），SSE 端点对 runtime 会话只读 chat_messages。
- 审批卡片行为不变：`plan / approval_required` 事件仍转 `approval_card` 信封（CARD_EVENT_TYPES 映射移入 EventSink），按钮继续调既有 confirm/decide 端点（Q4A）。

### 7. 里程碑（二期首批施工序）

| 里程碑 | 交付 | 验收 |
| --- | --- | --- |
| **M0 内核最小闭环** | loop/stop_reason/TOOL_HANDLERS(包装 ToolExecutor)/hooks 注册表/snapshots/EventSink/engine_kind=runtime 全链路 | 单测（ScriptedInvoker 脚本回放：plan→confirm→act→审批→check 全挂起态覆盖）+ workbench 发消息经内核出事件流 + 快照恢复 |
| **M1 Subagent** | spawn_subagent handler/SubagentSpec 收窄校验/嵌套挂起恢复/子代理事件标签（后端 + 前端 evt 前缀） | 单测（收窄校验拒绝放大、fresh 隔离、审批冒泡 resume）+ 端到端（父 spawn → 子工具审批卡片 → decide → 子完成回注） |
| **M2 Context Compact** | 四层管线/compact 事件/预算联动/子循环独立收紧 | 单测（各层触发与折叠正确性、压缩后续跑）+ 长会话端到端（budget 触发后任务不 partial） |
| **M3 Permission 泛化** | 声明式 PermissionRule + golden 等价测试 | golden 样本集锁等价后切换 |

## 后果

**正面**：

- Subagent 与 Context Compact 同期落地形成闭环：隔离上下文由压缩管线守住，直接服务长任务与后续 Teams/Memory 能力（ADR-015 正面后果兑现）；
- 复用面最大化：LLMInvoker/ToolExecutor/policy/task_events/租约/审批端点/前端卡片全部原样工作，内核新增面集中在循环与快照；
- 聊天流单源化，消除一期惰性桥接的单流假设边界；
- 双引擎过渡由 golden 测试锁行为等价，旧图退役路径清晰（Q9A「逐项吸收」）。

**负面/风险**：

- 嵌套挂起（父子栈快照）是自建持久化中最复杂的部分：快照 schema 含嵌套子循环状态，恢复语义需单测全覆盖；
- 规则拼接摘要的表达力弱于 LLM 摘要：极端长会话下摘要信息密度不足（M2 后按实测决定是否引入 LLM 摘要）；
- 双引擎并存期两套挂起/恢复语义（checkpointer vs runtime_snapshots）增加心智负担，以 M3 后退役旧图为收敛点；
- compact 事件使聊天流事件量增大，前端 evt-line 需要折叠策略（随 M2 交付最小实现）。
