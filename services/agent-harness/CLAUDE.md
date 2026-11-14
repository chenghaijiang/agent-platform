# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

pnpm 工作区，要求 Node >= 22（`@harness/kb` 依赖 `node:sqlite`：Node >= 22.13 可直接用；22.5–22.12 需要加 `--experimental-sqlite`）。

```bash
pnpm install
pnpm build                 # 对所有包执行 tsc -b（composite 项目引用）
pnpm check                 # build + architecture:check（边界规则 R1–R4）
pnpm architecture:check    # 仅做导入边界检查（扫描 src，无需先 build）
pnpm start                 # CLI（packages/cli/dist/main.js）；另有 `pnpm harness`、`pnpm auto`、`pnpm kb`
pnpm serve                 # 协议服务器，http://127.0.0.1:4173（可用 PORT 环境变量覆盖）
pnpm ctl start|stop|status|restart|logs [server|qdrant]   # 后台启停 server 与 qdrant
pnpm service               # launchd 安装辅助脚本（scripts/service/install.mjs）
node --check packages/web/public/app.js   # web 客户端唯一的检查方式（无构建步骤）
```

测试与 lint：
- 没有配置测试框架和 lint 工具。测试套件是单个脚本：`node tests/capability-test.mjs`。它从 `packages/*/dist` 导入模块，因此要先执行 `pnpm build`。该脚本不支持按用例过滤；若只想跑某一项检查，把对应的 `check(...)` 代码块复制到 `/tmp` 下的临时 `.mjs` 文件中，再用 node 执行。
- 日常验证以针对运行中服务器的端到端测试为主（用 curl 访问 `/api/*`，回放 SSE），不用 mock。单元级测试只用于协议适配器和确定性的 core 组件。

运行时状态：`~/.harness/`（config.yaml、models.json、knowledge/kb.db、qdrant/、run/ 下的 PID 文件、logs/）。首次运行时会写入带默认值的 `config.yaml`，并由 zod 校验；配置无效会直接报错，这是有意的设计。仓库内的 `.harness/` 被 gitignore，只有 `.harness/skills/` 例外。

## 架构

**包分层。** `contracts`（共享类型：turn 阶段及其转移表、`SessionEvent`、`ToolManifest`、权限负载、`checkRedLines`）← `core`（运行时）← `server` / `cli`；`kb` 是被 `server` 和 `cli` 使用的库；`web` 是 `packages/web/public/` 下的静态文件，只通过 `/api/*` 与服务通信。`scripts/architecture/check.mjs` 强制以下规则：contracts 不导入任何 `@harness/*`；core 不导入 cli/server/web；cli/server/web 只能通过裸的 `@harness/core` 入口引用 core（不允许深路径导入）；客户端表层之间互不导入。违反规则会使 `pnpm check` 失败。

**Agent 循环（core）。** `AgentRuntime`（`core/src/runtime/agent-runtime.ts`）按 思考 → 调度 → 授权 → 执行 → 观察 的顺序运行。每个 turn 由 `TurnMachine`（`core/src/turn/machine.ts`）驱动，它只能沿 contracts 中定义的转移前进，非法转移会抛出异常。关键规则：
- `tool/scheduler.ts` 根据工具元数据生成执行波次：`concurrentSafe && !destructive` 的调用会进入并行波次（上限为 `loop.parallel_tool_limit`），其余调用串行执行。未知工具按破坏性、非并发处理。
- `permission/service.ts` 对每一次单独调用做授权；`awaiting_permission` 阶段由表层注入的审批处理器驱动。
- 上下文管理由 `compact/compact.ts` 负责（微压缩与自动压缩，在 `context.auto_compact_threshold` 处触发），并带有快速回填保护；token 估算来自 `context/tokens.ts`。

**模型（core/src/model）。** `ProviderRegistry`（`registry.ts`）把模型名映射到三种适配器之一：`chat-completions`（`openai.ts`）、`anthropic-messages`（`anthropic.ts`）、`responses`（`responses.ts`），共用的 SSE 解析在 `sse.ts`。未知或不可达的模型会回退到 `model.fallback` 并标记 `degraded`；不支持工具调用的提供方会去掉工具并标记 `degradedMode`。用户添加的自定义模型保存在 `~/.harness/models.json` 中，且不允许静默回退。

**扩展点（core）。** 工具注册在 `ToolRegistry` 中（内置工具在 `tools/builtin.ts`，知识库工具经 `kb/src/tools.ts`，任务工具在 `tasks/tools.ts`）。技能是包含 `SKILL.yaml` + `SKILL.md` 的目录，从 `.harness/skills/`（项目级）和 `~/.harness/skills/`（用户级）加载，同名时项目级覆盖用户级；每个 turn 都会重新扫描。其他子系统：`memory/manager.ts`、`tasks/`（共享任务看板与 agent 消息通道）、`subagent/task-tool.ts`、`automation/`（调度器）、`worktree/`（git worktree 管理）。

**服务器（`packages/server`）。** `RuntimeHost`（`runtime-host.ts`）是包裹 `AgentRuntime` 的进程级单例：按模型构建运行时，串行化 turn（一个 turn 运行中再调用 `submitTurn` 会被拒绝），把事件整理为转录记录与快照，并暴露 HTTP 层调用的方法。`http.ts` 是手写的路由（不使用框架）：每个 `/api/*` 路由自行检查 HTTP 方法，并通过 `sendError` 返回 JSON 错误。`/api/events` 是 SSE，也是唯一的实时通道；事件携带 `traceId`，以便 web 客户端把事件路由到正确的会话。`/api/fs/*`、`/api/db/*`、`/api/qdrant/*` 会暴露本地数据；服务器只绑定 127.0.0.1，`db/query` 端点只允许 SELECT 且只读。

**知识库（`packages/kb`）。** 摄取流水线：解析（docx 原生解析，.doc 走 `textutil`，.pdf 走 `pdftotext`）→ 清洗（`clean.ts`）→ 切分（`chunk.ts`）→ 向量化（Ollama）→ 存入 SQLite FTS5（`kb.db`，表 `sources`/`chunks`/`chunks_fts`）以及 Qdrant 向量库。检索是混合式的（向量 + FTS），外加文件名子串命中。摄取是异步的：`POST /api/kb/ingest` 返回任务 ID，客户端轮询 `/api/kb/jobs/:id`。Qdrant 离线只会禁用向量部分，FTS 仍可用。

**客户端。** `packages/cli` 在进程内直接驱动 `@harness/core`（不经过服务器）。`packages/web` 是无需构建、无框架的客户端（`index.html`、`app.js`、`markdown.js`、`styles.css`）；会话元数据保存在 localStorage 中，聊天内容则由 SSE 回放重建。

**设计文档。** 代码注释中引用了 "design doc §N"，该文档位于仓库之外（相对仓库根目录为 `../agent-harness-design.md`）。改动架构级行为时需要同步更新它。

## 值得了解的约定

- 注释、界面文案和大部分文档使用中文；请与所在文件的语言保持一致。
- 近期提交使用约定式前缀（`feat:`、`fix:`、`skill:`）。
- 修改 `packages/server` 或 `packages/core` 后，需要先执行 `pnpm build` 再重启服务器。`pnpm ctl start` 只在缺少构建产物时才会构建，所以执行 `pnpm ctl restart` 前请自行运行 `pnpm build`。
- web 端的转录记录保存在 `~/.harness/sessions/web.jsonl`（可用 `HARNESS_SESSION_FILE` 覆盖）。
- `packages/*/dist`、`*.tsbuildinfo`、`traces/` 和 `sessions/` 是构建或运行时产物，已被 gitignore。根目录下的 `hello.py` 和 `shanghai_weather.py` 是独立脚本，与 harness 无关。
