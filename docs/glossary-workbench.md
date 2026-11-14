# 术语表增补：智能工作台域（glossary addendum）

> 主表：`../2026/docs/glossary.md`（v0.2，仓库外，ADR-008 裁决基准）。
> 本表自 2026-11-14 起承载本仓库新增术语，与主表同规则：所有 ADR 与代码以本表为准。

| 术语 | 英文 | 定义 | 归属 | 阶段 |
| --- | --- | --- | --- | --- |
| 智能体 | Agent Profile | 用户在统一工作台可选择的 Agent 应用落地实体：system prompt + 工具集 + 执行图/内核模板 + 默认执行模式。与主表「Agent 应用」为同一概念两个视角（ADR-014 裁决） | 控制面 | 统一工作台一期 |
| 统一工作台 | Unified Workbench | 升级后的聊天框：唯一用户入口，问答与 Agent 执行（进度、审批）在同一聊天流呈现 | 渠道层 | 统一工作台一期 |
| 审批卡片 | Approval Card | 聊天流内的结构化消息（type=approval_card）：呈现计划确认/工具审批，按钮决策即 resume 执行 | 渠道层 | 统一工作台一期 |
| 消息信封 | Message Envelope | 聊天流消息的统一格式 `{type, seq, ts, data}`，type ∈ text / agent_event / approval_card 等 | 渠道层 | 统一工作台一期 |
| 智能体内核 | Agent Runtime | 自研执行内核（while 循环 + stop_reason + TOOL_HANDLERS dispatch + hooks），承载 20 项能力全景（ADR-015 分三期）；一期以 agentdesk_bridge 过渡，二期起为 code-engineer 的执行基座 | Agent 执行内核 | 二期起 |
| 子智能体 | Subagent | 以 fresh messages[] 上下文隔离派生的下级执行体；权限 = 父 Task 的 mode/owns/grants 交集，只可收窄不可放大，审批决策冒泡（ADR-017） | Agent 执行内核 | 二期 |
| 记忆 | Memory | `agent_memories` 表（PG + pgvector）：selection/extraction/consolidation 三段生命周期，按 user × profile 组织（ADR-017） | Agent 执行内核 | 二期 |
| 工作树 | Worktree | 任务绑定的 git worktree（共享主仓对象库 + 分支隔离），`WorktreeRecord(task_id, worktree_path, branch)` 落 PG；由现有 workspace 拷贝装载原地升级（ADR-017） | Agent 执行环境 | 二期 |
| 模型策略 | Model Policy | Profile 携带的 `{primary, fallbacks[]}`，缺省回落全局映射；Error Recovery 重试与换模链的数据源（ADR-016） | 控制面 | 一期 |
| 消息流水 | Chat Messages | `chat_messages` 表：会话级 `{seq, type, data, task_id}` 消息持久化，支持 Last-Event-ID 续传与卡片回放（ADR-015） | 渠道层 | 一期 |
| Harness 内核 | Agent Harness | 外部引入的 TypeScript 自研 Agent 内核工程（`services/agent-harness/`，ADR-019）：TurnMachine 阶段状态机 + 工具波次调度 + 审批挂起 + Context Compact + Subagent + Skills + 任务看板 + 内置 KB（FTS5+Qdrant） | Agent 执行内核 | ADR-019 起 |
| 协议服务器 | Protocol Server | harness 的 HTTP 面（Node 进程，内网 4173）：`/api/turn`、`/api/events`（SSE）、`/api/approve` 等；本地信任无认证，可访问性由平台网关收口（ADR-019） | Agent 执行内核 | ADR-019 起 |
| Harness 网关 | Harness Gateway | 平台侧 `src/agent_platform/harness/api.py`：`/api/harness/{path}` catch-all 反代（require_auth + 方法/体/头透传 + SSE 流式透传 + 凭证不下渗 + 上游不可达 502） | 渠道层 | ADR-019 起 |
| 审批常允许 | Always Allowed | harness 审批决策三选之一（allowed/denied/always）：always 后同工具后续调用免审批（会话级记忆）；与 agentdesk 域 `AlwaysAllowed` 表语义对应（ADR-019 术语对齐） | Agent 执行内核 | ADR-019 起 |
