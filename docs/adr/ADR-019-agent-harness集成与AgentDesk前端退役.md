# ADR-019：agent-harness sidecar 集成与 AgentDesk 前端退役

- 状态：已接受
- 日期：2026-11-14
- 关联：ADR-015（自研内核分期）、ADR-016（Profile/退役两段式）、ADR-018（agent_runtime 内核方案）
- 来源：用户引入外部工程 `agent-harness`（TypeScript monorepo：自研 Agent 内核 + 协议服务器 + 无构建 Web 客户端），要求集成进平台并用其替换老 Agent 工作台。四项方向性决策经用户确认。

## 背景

`agent-harness`（工作目录外引入，v0.2.0，Node ≥ 22，pnpm workspace）已实现 ADR-018 规划的内核能力全集：

| harness 资产 | 对应 ADR-018 规划 |
| --- | --- |
| `core/runtime/agent-runtime.ts` + `turn/machine.ts` | while 循环 + TurnMachine 阶段状态机（思考→调度→授权→执行→观察） |
| `tool/scheduler.ts` | 工具波次调度（`concurrentSafe && !destructive` 并行波次，其余串行） |
| `permission/service.ts` + host 审批（5min 超时 + always） | 权限管线 + 审批挂起 |
| `compact/compact.ts` | Context Compact（微压缩 + 自动压缩 + 快速回填保护） |
| `model/registry.ts`（chat-completions / anthropic / responses 三适配器 + 自定义模型热切换） | 模型出口 |
| `subagent/task-tool.ts` | Subagent（spawn 为特殊工具） |
| `tasks/board.ts` + `memory/` + `skills/`（SKILL.yaml+md） | 任务看板 / 记忆 / 技能 |
| `kb/`（SQLite FTS5 + Qdrant 混合检索，Qdrant 离线降级 FTS-only） | 知识检索工具 |
| `server/`（手写 http + SSE `/api/events`，RuntimeHost 单例）+ `web/`（无构建客户端） | 协议层与前端 |

其世界观为**本地单用户**：RuntimeHost 进程级单例、默认绑 127.0.0.1、无认证、状态落 `~/.harness/`。

## 决策

### 1. 集成形态：Node sidecar + FastAPI 认证网关（不重写、不直连）

- **裁决**：harness 源码入库 `services/agent-harness/`（排除构建产物与运行时状态），以独立 Node 服务运行；平台新增 `src/agent_platform/harness/api.py` 网关，`/api/harness/{path}` catch-all 反代（`require_auth` 门禁 + httpx 流式透传）。
- **理由**：完整保留 harness 能力（Python 重写是数倍工作量且二期能力面会持续漂移）；认证/审计在平台收口（浏览器直连 Node 会让凭证体系裂开）。
- **网关契约**：方法/查询串/请求体/响应头透传；`authorization`/`cookie` 不透传上游（sidecar 无认证，凭证不扩散）；`text/event-stream` 以 StreamingResponse 透传（前端 fetch 流式消费）；上游不可达统一 502（sidecar 的 degraded 态由其 `/api/health` 快照表达，网关不做语义翻译）。
- **伴随修补**：`packages/server/src/main.ts` 增加 `HOST` 环境变量（默认仍 127.0.0.1 本地信任；容器内 0.0.0.0 仅暴露 compose 内网）；tsconfig references 补 `@harness/kb`（server/cli 原依赖历史 dist 产物，干净构建会挂）。

### 2. 老 AgentDesk：前端退役 + 后端保留（ADR-016 两段式的执行）

- **裁决**：删除 `web/agentdesk.html/js/css`，平台首页入口改指 `/harness/index.html`；`agentdesk` 后端（LangGraph 图、runner、审批端点、workbench 的 `agentdesk_bridge` 引擎）原样保留。
- **理由**：存量 AgentTask/审批数据与既有测试不受影响；ADR-016 的「卡片功能平价」退役条件由 harness 客户端达成（审批卡片、执行事件流、Subagent 面板均更完整）。hunk 评审/commit 门禁为 agentdesk 专属能力，后端保留期间 `code-engineer` Profile 仍可经统一工作台聊天流使用。

### 3. 用户模型：单实例共享（与 harness 世界观一致）

- **裁决**：一个 harness 实例，登录用户经平台认证后共用（转写与运行时状态单份，落 sidecar 卷）。
- **理由**：演示平台定位；harness 单例重构为多租户是二期议题（多实例 per-user 或 runtime 会话化），一期不做。
- **边界**：`submitTurn` 单飞（busy 即 409）天然串行化并发用户；会话记录为全局 transcript（无用户归属过滤），不做敏感场景使用。

### 4. 模型出口：复用平台 model_gateway 上游（同源 env）

- **裁决**：sidecar entrypoint 以 `MODEL_GATEWAY_BASE_URL / MODEL_GATEWAY_API_KEY / MODEL_CHAT_MODEL` 生成 `~/.harness/config.yaml`（openai-compatible provider），与 app 容器同一组 env——改 `.env` 一处，两侧同时生效。
- **理由**：统一出口与 Langfuse 观测收口（ADR-016 model_policy 精神）；harness 自带 fallback/degraded 逻辑继续在 adapter 层生效。
- **代价**：api_key 落盘到挂载卷 config.yaml（演示环境为 demo key；生产需改密钥注入方式）。

## 落地清单

```
services/agent-harness/          # harness 源码（gitignore 排除 node_modules/dist/tsbuildinfo/traces/.harness）
  ├─ Dockerfile                  # node:22-slim 两阶段：pnpm install --frozen-lockfile → tsc -b
  ├─ docker-entrypoint.sh        # env → config.yaml 生成（声明式，重启覆盖）
  └─ packages/server/src/main.ts # +HOST env 补丁
src/agent_platform/harness/      # api.py：catch-all 反代 + require_auth（httpx 客户端在 main.lifespan 装配）
web/harness/                     # harness 客户端四件套；app.js 改造：API_BASE=/api/harness 前缀 +
                                 #   hw() 统一注入 Bearer（zs_token）+ 401 跳平台登录 +
                                 #   EventSource→fetch 流式（SSE 无法带 header）+ 下载链接加前缀
docker-compose.yml               # harness 服务（内网 4173，healthcheck /api/health，状态卷）；
                                 #   app.environment 增 HARNESS_BASE_URL=http://harness:4173
.env.example / platform.sh       # HARNESS_BASE_URL 与状态行
tests/test_harness_gateway.py    # 网关契约 7 例（401 / 透传保真 / 凭证不扩散 / SSE 逐字节 / 502）
```

## 后果

- ADR-018 的 `src/agent_platform/agent_runtime/` 自研 Python 内核**暂缓**：harness 已覆盖 M0–M2 能力面；若后续需要 PG 持久化快照/多租户/与平台审批域深度合流，再评估「Python 重写 vs harness 会话化」，届时本 ADR 由新 ADR 取代。
- `pnpm check`（tsc -b + 架构边界 R1–R4）为 harness 侧回归门禁；平台侧 pytest 全量（网关 7 例新增）。
- harness 运行时状态（config/sessions/kb.db）在 sidecar 卷，`docker compose down` 保留、`down -v` 清除。
