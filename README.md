# Agent Platform（企业内部 Agent 平台 MVP）

面试作品向的企业 Agent 平台 MVP 实现，范围收敛为**同步知识问答（RAG）**单一场景。
方案与决策依据：`../2026/day32企业内部 Agent 平台方案-v0.2.md`、`../2026/docs/adr/`（10 条 ADR）。

当前进度：**T01–T15 全部完成，T16 收口中**（284 单测全绿；票据与逐项验收记录见 `../.scratch/mvp-agent-platform/issues/`）。

## API 全表（按模块）

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| POST /api/auth/login | 公开 | 口令登录 → Bearer token（HS256 JWT，含 user/role） |
| GET /api/me | Bearer | 当前身份（user_id/username/role/认证来源） |
| POST /api/admin/users | admin | 创建用户并分配角色（409 重名 / 422 未知角色） |
| GET /api/admin/users · /roles | admin | 用户与角色列表 |
| POST /api/admin/model-gateway/self-test | admin | 网关连通性自检（真实走一次 chat/embed 并等上报完成，返回 model/usage/latency；错误时透出网关错误类型） |
| POST / GET /api/admin/kbs | admin | 知识库创建 / 列表（名称、说明、三密级、索引版本） |
| GET / DELETE /api/admin/kbs/{id} | admin | 详情 / 删除 |
| POST / GET / DELETE /api/admin/kbs/{id}/acls | admin | 角色 read 授权 / 列表 / 撤销（201 / 409 重复授权） |
| GET /api/admin/roles/{role}/kbs | admin | 角色可见知识库查询 |
| POST /api/admin/kbs/{id}/documents | admin | 上传文档建入库任务（≤20MB，PDF/MD/TXT；同库同内容幂等 200 返回已有任务） |
| GET /api/admin/kbs/{id}/tasks · /api/admin/ingest/tasks/{task_id} | admin | 任务列表 / 单任务详情（状态机与重试计数） |
| POST /api/search | Bearer | 检索：pgvector top_k，先按调用者角色 ACL 过滤再排序，返回 citations |
| POST / GET /api/sessions | Bearer | 会话创建 / 列表（按用户隔离） |
| POST /api/sessions/{id}/chat | Bearer | SSE 问答：delta（流式）→ done（run_id + citations）→ error |
| GET /api/sessions/{id}/runs | Bearer | 会话历史 Run（answer/citations 落库可回放，创建时间降序） |
| GET /api/admin/audit-events | admin | 审计事件查询（登录/检索/越权/对话） |
| POST /api/admin/prompts/{id}/publish · GET .../current/{template_key} | admin | Prompt 版本发布 / 读发布版（链路运行时只读发布版） |

认证层为接口抽象 + 实现两段结构（ADR-006）：业务路由只依赖 `AuthProvider` 协议，
默认实现为本地口令（`auth/local.py`），另附模拟 OIDC 第二实现（`auth/fake_oidc.py`）
验证可替换性；阶段二接真实 OIDC 仅改装配点，业务代码零改动。
口令存 `pbkdf2_sha256$…` 加盐哈希，不落明文。

## 模型网关与观测（T03，v0.2 §5.5 M1 形态）

- **统一出口**：所有模型调用必须经 `ModelGateway.chat()/embed()`（应用内模块），调用方不接触 openai SDK，
  供应商异常在网关内翻译为 `ModelGatewayError` 族（Auth/RateLimit/Unavailable/BadRequest/Config）
- **配置驱动映射表**：chat/embedding 两能力位的模型名由 `.env` 配置（`MODEL_CHAT_MODEL`/`MODEL_EMBEDDING_MODEL`），
  改配置重启即切换，零代码改动；默认指向 compose 内 `fake-openai` 演示服务（免真实 API key 即可完整演示）
- **三形态切换**：只改 `.env` 四行（BASE_URL/API_KEY/两模型名）+ `docker compose up -d` 重建，零代码改动
  （模板见 `.env.example` 模型网关段）：
  - **演示**（默认）：compose 内 fake-openai，免真实 key 走通网关与观测链路
  - **线上**：OpenAI / DeepSeek / 通义等任一 OpenAI-compatible 云服务
  - **本地**：宿主机 Ollama / vLLM / LM Studio，如 `MODEL_GATEWAY_BASE_URL=http://host.docker.internal:11434/v1`
    （compose 已为 app/worker 注入 host-gateway 映射，Linux 亦可用；本地服务不校验 key，占位即可）
  - ⚠️ 切换 embedding 模型须清空 kb_chunks 重新入库（不同模型向量空间不可混用；
    embedding 列为无维度 vector，换维度模型无需改表）
- **Langfuse 自动上报**：Langfuse Python SDK v5（OTel/OTLP）+ `langfuse.openai` drop-in instrument：
  每次调用自动产出 `@observe` SPAN → GENERATION/EMBEDDING 层级（含模型名、token 用量、延迟），
  UI（:3000）Tracing 页直接可查；高频路径批量上报，self-test 与关停时显式 flush
- **凭证治理**：API key 仅存 `.env`（gitignore）；Langfuse 项目密钥显式固化在 `LANGFUSE_INIT_PROJECT_*`，重建数据卷后不变

## 平台能力（T04–T13）

### 知识库与 ACL（T04）
- 知识库元数据（名称/说明/三密级 public·internal·confidential/索引版本），CRUD 仅 admin；
- ACL 为角色 × 知识库 read 授权；越权检索在检索层被过滤并写入审计；
- 前端用户管理页用同一份 ACL 数据渲染矩阵，保证「所见即所得」。

### 入库流水线（T05）
- 上传 → 任务入 PG 队列（queued）；worker 独立容器以 `UPDATE…WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`
  租约认领（ADR-005），失败自动重试，attempt 耗尽置 dead；
- 流水线：解析（pypdf / md / txt）→ 切分 → 向量化 → 原文写 MinIO、chunk+embedding 写 pgvector；
- 状态机 queued → running → succeeded / failed（重试中）→ dead，任务表实时可查。

### 检索服务（T06）
- `POST /api/search`：pgvector 余弦 top_k；候选集先按调用者角色 ACL 过滤再排序；
- citations 含 chunk_id / 文档 / 标题路径 / 原文 / 密级 / 相似度——「每条结论可溯源」的数据基础。

### Chat Run（T07）
- 会话与 Run 持久化，标题自动取首问；LangGraph 图 + Postgres checkpoint，进程重启后同 thread 恢复上下文；
- SSE 三帧契约（delta/done/error），Run 与 citations 落库，历史会话可完整回放。

### Guardrails 与审计（T08）
- 输入脱敏（PII）与输出敏感识别，治理结论随 Run 记录；
- 登录/检索/越权/对话写审计事件，`GET /api/admin/audit-events` 可查。

### Prompt 版本与评测（T10）
- `prompts/chat_qa.yaml` 启动登记为版本记录，显式 publish 后链路运行时只读发布版；
- `uv run python -m evals.run_eval` 对金标集（`evals/golden_set.jsonl`）做检索/答案回归并与 baseline 比对，CI 阻断回归。

### Web 前端（T09）
- `web/` 纯静态 vanilla JS 单页（hash 路由，无构建）：登录 / 知识问答（SSE 打字机 + 引用面板 + 角标联动 +
  治理条）/ 知识库（上传 + 任务状态轮询）/ 用户与权限（ACL 矩阵）；
- 视觉对齐交互原型 `2026/docs/prototype/mvp-mockup.html`（密级印章、治理条、状态徽章语义一致）；
- member 视角隐藏管理入口且管理员页 URL 直访被拒；响应式三档断点（≤1180 / ≤1100 / ≤860）。

### AgentDesk 数据层与工作区底座（T11，ADR-011/013）
- Agent 执行域三组表落库：`agent_tasks`（意图容器：goal/owns/mode/九态状态机，Task ≠ Job 术语裁决）、
  `task_events`（证据链实体：seq 按 task 单调递增，(task_id, seq) 唯一，一表三用：SSE 直播 /
  Last-Event-ID 回放 / 审计证据链）、`approvals` + `always_allowed`（L2 命令审批单与带有效期的「总是允许」策略）；
- 工作区底座：compose 为 app/worker 挂 `workspaces/` 命名卷（挂载点 /app/workspaces），
  每个 Task 分配隔离目录 `workspaces/<task_id>/`——路径隔离而非操作系统沙箱（ADR-013 诚实边界）；
- 演示仓 `payment-console`（pricing + pytest + ruff）随 Task 初始化复制进工作区并以 git 基线提交固定初始状态；
  年付计价预置缺陷使 `pytest -q` 失败可见（2 failed / 4 passed），修复即产生可审阅 diff（T13 提交闭环的目标）；
- checks 零额外依赖：pytest/ruff 随平台主依赖进镜像（非 dev 组），容器内可直接运行。

### AgentDesk 策略引擎与工具层（T12，ADR-013）
- 策略引擎（纯函数求值，不触库）：参数校验 → L2 红线（6 类正则 + shlex 解析 `rm -rf` 组合 flag）
  → L1 工作区/owns 边界 → L3 四档模式 × L0/L1/L2 矩阵 → always_allowed 升级；
  红线先于一切，任何模式（含完全访问）与任何授权均不可救回；
- 工具层四工具 schema 注册（read_files L0 / apply_patch L1 / run_command L2 / git_commit L2），
  ToolExecutor 统一执行：每次调用（含被拦截的）写 task_events 证据链与 audit_events
  （payload 带 `domain: agentdesk` 域标签，两域同表可查）；subprocess 带超时与输出截断；
- require_approval 创建 pending 审批单挂起（T13 Graph interrupt 的数据基础），
  always_allowed 仅能将 require_approval 升级为 allow。

### AgentDesk 执行图与审批 interrupt（T13，ADR-012）
- 9 节点 StateGraph：plan → await_confirm（仅确认/计划模式）→ act（LLM 工具循环，
  经 TOOL_QUEUE 逐个出队）↔ check（pytest/ruff 门禁，失败回灌修复 ≤2 轮）→ summarize；
- **interrupt 与副作用分离**（LangGraph resume 重跑语义）：挂起点仅在纯节点，
  LLM 调用/事件写入/工具执行在无 interrupt 节点；求值（policy_gate）与执行（tool_run）分离；
- Postgres Checkpointer 持久化执行态（thread_id=task_id）：进程重启后审批等待态可查可续
  （pending_interrupt → decide resume），挂起-恢复全程事件 seq 连续不断；
- 预算硬上限：步数/token 超限或修复轮次超限均如实降级 partial；
- LLMInvoker 协议隔离模型层：生产走网关 chat_tools，单测/冒烟用 ScriptedInvoker 脚本回放；
- runner 三入口（start/confirm_plan/decide）供 T14 API 面直接消费。

### AgentDesk API 面与 SSE 事件流（T14）
- 8 端点全表（§3）：任务 CRUD（创建即入队 / 列表 / 详情）+ SSE 事件流 + 计划确认与审批决策（resume Run）+
  hunk 接受/拒绝 + 门禁提交；全部 Bearer 鉴权，归属校验（owner 或 admin，否则 404 不泄露存在性）；
- 调度复用 PG 队列模式（ADR-005）：agent_tasks 加 lease_expires_at/attempts，Worker 双队列并行消费
  （入库 + agent 任务）；认领 SKIP LOCKED + 租约，attempts 超限降级 partial；
- SSE 帧 id=seq 即续传游标：连接即回放 Last-Event-ID 之后历史再尾随直播（断线重连零丢失），
  终态且事件耗尽发 done 帧关流；confirm/decide 同步校验挂起点（无挂起 409）后图执行后台跑；
- hunk 评审：review 态详情惰性从 git diff 生成按文件分块清单（幂等落库）；commit 门禁：
  全部 hunk accepted 且 pytest/ruff 双绿才允许，否则 409 带具体原因；通过后演示仓内 git commit（agent: 前缀）。

### AgentDesk 前端（T15）
- `web/agentdesk-demo.html` 为交互规格说明书（视觉与交互 100% 保留，Q3 决策），
  `web/agentdesk.html/js/css` 按其对照实现：数据源全部替换为真实 API（/api/agentdesk/*）；
- SSE 事件订阅驱动渲染：13 类事件 type → 卡片分发，证据链五节点
  （计划→执行→检查→独立验证→验收）按事件推进；打开任务 cursor=0 全量回放重建界面，
  断线重连带 Last-Event-ID 续传（零丢失）；
- 审批三选（once/always/deny）调 decide 端点、hunk 接受/拒绝调 hunks 端点、
  提交调 commit 端点并处理 409 门禁失败提示；快捷键对齐 demo（Shift+Tab 切模式、⌘K 新建任务）；
- 现有 web/ 顶栏增加「Agent 工作台」入口（独立功能域新窗口打开，双功能域并存，Q1 决策），
  登录与账号体系复用（zs_token/zs_user 同一 localStorage 契约）。

### 审计域展示（T16）
- 用户与权限页新增「审计事件」面板：按功能域筛选（Agent 工作台 / 知识问答 / 知识库），
  agentdesk 域五种 action（tool_call / out_of_bounds / redline_blocked / task_committed / approval_decided）
  映射中文动作标签，越界与红线拦截红色标注；治理口径见「能力边界」。

## 能力边界（双口径声明，T16）

| 边界 | 口径 |
| --- | --- |
| 隔离级别 | **路径隔离，非容器沙箱**：owns 约束、红线正则、四档模式在策略引擎层求值拦截（ADR-013 四层安全模型），工具执行限定在任务工作区目录内；生产部署建议叠加容器级隔离 |
| 模型依赖 | **Agent 域（AgentDesk）需真实模型 key**：执行图走模型网关 `chat_tools` tool-calling，fake-openai 不支持工具调用协议；**RAG 域（知识问答）fake 即跑**：演示容器形态下全链路可演示 |
| 交付证据 | MVP 以 diff 评审 + pytest/ruff 检查门禁 + 独立验证作为交付证据；demo 中的沙箱内实时页面预览属完整版能力，当前版本未包含 |

## ZCode 借鉴声明（T16）

AgentDesk 的产品骨架与交互范式参考开源项目 **zai-org/ZCode（v3.18.x，Agentic Development Environment）**，
借鉴以下四个具体设计（竞争力建立在企业治理 + 私有化 + 可验证交付上，见 PRD §1.3）：

1. **ADE 三层结构与证据链交互**：工作区 → 任务 → 会话 → 交付的任务组织方式，
   与「事件流驱动的执行证据链」展示范式；
2. **四档执行模式 + 审批三选交互**：变更前确认 / 自动编辑 / 计划模式 / 完全访问，
   与「仅本次允许 / 本项目总是允许 / 拒绝」的审批心智模型；
3. **权限引擎求值设计**（借鉴 ZCode `permission/service.ts`）：
   `policy(mode, tool, risk_level, always_allowed) → allow | deny | require_approval`，
   红线先于模式求值、永远 deny；
4. **工具循环错误恢复**（借鉴 ZCode 工具循环）：check 失败 → 错误输出截断注入工具结果 →
   Agent 自主修复，修复轮次超限（>2）停止并如实降级 `partial`。

## AgentDesk 文档索引（T16）

| 文档 | 说明 |
| --- | --- |
| `docs/AgentDesk企业智能体工作台PRD.md` | 产品需求文档：定位（ADE + 治理平台）、用户画像、核心场景、红线清单 |
| `web/agentdesk-demo.html` | 交互规格说明书：视觉与交互的验收基准（T15 前端逐项对照实现） |
| `docs/agentdesk-implementation.md` | 实施方案：API 全表、Agent Graph 设计、安全模型、切片划分与验收口径 |

## 服务拓扑（T01/T05）

| 服务 | 镜像 | 宿主端口 | 说明 |
| --- | --- | --- | --- |
| app | 自建（uv + FastAPI） | 8000 | 平台应用骨架，启动前自动执行 Alembic 迁移 |
| db | pgvector/pgvector:pg17 | 127.0.0.1:15432 | 平台主库（用户/ACL/任务队列/Checkpoint/向量），initdb 自动启用 vector 扩展 |
| redis | redis:7 | 127.0.0.1:16379 | 平台缓存/限流/登录态 |
| worker | 自建（与 app 同镜像） | - | 双队列消费者：入库流水线 + Agent 任务（SKIP LOCKED 租约认领 PG 队列，ADR-005）；入库：解析/切分/向量化；agent：认领后跑执行图至挂起/终态 |
| minio | chainguard/minio | 127.0.0.1:9001 | 平台对象存储（文档原文，S3 API；容器 9000 → 宿主 9001） |
| fake-openai | 自建（python:3.12-slim，仅标准库） | 127.0.0.1:8100 | OpenAI-compatible 演示服务（T03）：带 usage 的标准响应，免真实 key 演示网关与观测链路 |
| langfuse-web | langfuse/langfuse:4 | 3000 | 观测 UI（Trace/评测/Prompt 版本） |
| langfuse-worker | langfuse/langfuse-worker:4 | - | Langfuse 异步摄取 worker |
| langfuse-postgres | postgres:17 | - | Langfuse 元数据 |
| langfuse-clickhouse | clickhouse-server:26.3 | - | Langfuse Trace 存储 |
| langfuse-minio | chainguard/minio | 127.0.0.1:9090 | Langfuse 对象存储（浏览器直传媒体） |
| langfuse-redis | redis:7 | - | Langfuse 队列（BullMQ，noeviction） |

> Langfuse 基础设施独立成套（官方自托管模板形态），不与平台 db/redis 共用实例：
> BullMQ 要求 `maxmemory-policy noeviction`，与平台缓存策略诉求冲突，隔离更接近生产形态。

## 快速开始

前置：Docker Desktop 运行中；宿主机 8000/3000/15432/16379/9090 未被占用。

```bash
cp .env.example .env
# 补齐三个 Langfuse 密钥（缺失时 compose 直接报错拦截）
printf 'LANGFUSE_NEXTAUTH_SECRET=%s\nLANGFUSE_SALT=%s\nLANGFUSE_ENCRYPTION_KEY=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
# Langfuse 项目 API keys（显式固定，供应用上报观测；重建数据卷后不变）
printf 'LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-%s\nLANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-%s\n' \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" >> .env

docker compose up -d --build
```

全部 12 个容器 healthy 后（首次约 2~4 分钟）：

```bash
docker compose ps                    # 12/12 healthy
curl -s http://127.0.0.1:8000/healthz       # 平台存活探针
curl -s http://127.0.0.1:8000/readyz        # 就绪探针（校验 PG/Redis 连通）
curl -s http://127.0.0.1:3000/api/public/health   # Langfuse 健康
docker exec agent-platform-db-1 psql -U postgres -d agent_platform -c "SELECT * FROM pg_extension"   # 可见 vector
docker exec agent-platform-db-1 psql -U postgres -d agent_platform -c "SELECT * FROM alembic_version" # 0009_hunks_queue
```

Langfuse UI：<http://localhost:3000>，账号密码见 `.env` 中 `LANGFUSE_INIT_USER_*`（仅数据卷首次创建时生效）。

平台入口：<http://localhost:8000/>（T09 前端）。演示账号：`admin / Changeme-1234`
（来自 `.env` `ADMIN_INITIAL_*`，首启自动 seed）；成员账号经 `POST /api/admin/users` 创建，
如 member 角色的 `t06member / Member-12345`（演示 ACL 隔离：仅可见被授权知识库，管理入口隐藏）。

## 本地开发（不起容器跑应用）

```bash
uv sync                        # 安装依赖
uv run uvicorn agent_platform.main:app --port 8000   # 默认连 127.0.0.1:15432/16379（容器映射端口）
uv run alembic revision -m "..."   # 生成新迁移
```

应用无状态约束（ADR-004）：进程内只持有 PG/Redis 连接，业务状态全部外置；
宿主侧端口取 15432/16379 以避开本机其它项目占用的 5432/6379。

## 环境排障记录（本项目踩过的坑）

1. **Docker Hub DNS 污染**：`registry-1.docker.io` 解析被污染导致拉取超时。
   已在 daemon 层配置 `registry-mirrors`（`~/.docker/daemon.json`：daocloud + 1ms.run）。
   若个别镜像仍卡死，可用显式前缀直拉后 `docker tag` 归位，如
   `docker pull docker.m.daocloud.io/clickhouse/clickhouse-server:<tag>`。
2. **docker.langfuse.com 不可用**：官方模板镜像域 307 回源 Docker Hub，在污染环境同样不可达；
   compose 已改用 Docker Hub 官方路径 `docker.io/langfuse/langfuse(:-worker)`，由 mirrors 代理。
3. **Langfuse 绑定地址**：Next.js 把 `HOSTNAME`（默认=容器主机名→容器 IP）当绑定地址，
   容器内 `127.0.0.1` 不通，healthcheck 会假死；compose 已显式设 `HOSTNAME=0.0.0.0`。
4. **健康端点路径**：web 为 `/api/public/health`，worker 为 `/api/health`，两者不可混用。
5. **initdb SQL 注释**：PG 不支持 `#` 注释，必须用 `--`；initdb 脚本仅在数据卷首次初始化时执行。
6. **Langfuse INIT 显式 API key**：`LANGFUSE_INIT_PROJECT_PUBLIC_KEY/SECRET_KEY` 必须在数据卷首次创建前传入
   langfuse-web/worker（INIT 幂等：已存在的 project 不会更新 key）；若应用侧 key 与项目实际 key 不一致，
   上报报 `Failed to export spans batch code: 401`，删 Langfuse 数据卷重建即可。
7. **Langfuse v4 events_only 模式**：旧查询 API（`/api/public/traces|observations`）已下线，
   验证观测数据走 UI 或 ClickHouse `events_core` 表；Python SDK v5 经 OTLP `/api/public/otel/v1/traces` 上报。

## 目录结构

```text
agent-platform/
├── docker-compose.yml        # 12 服务编排（ADR-004 单机部署单元）
├── Dockerfile                # uv 基础镜像，依赖层/应用层分离
├── docker/initdb/01-extensions.sql   # 平台库自动启用 pgvector
├── alembic/                  # 迁移链 0001→0009（accounts / kb_metadata / ingestion / chat / audit / prompts / agentdesk / hunks_queue）
├── tools/fake-openai/        # OpenAI-compatible 演示服务（T03，免真实 key）
├── prompts/chat_qa.yaml      # 问答系统提示词（启动登记 → 版本化发布，T10）
├── evals/                    # 金标集 golden_set.jsonl + run_eval.py 回归（T10，结果存 results/）
├── web/                      # 前端（纯静态，main.py StaticFiles 兜底挂载）：T09 知识问答三件套 + T15 AgentDesk 工作台（agentdesk.html/js/css）+ 交互规格（agentdesk-demo.html）
├── src/agent_platform/
│   ├── main.py               # FastAPI 入口：/healthz /readyz + 全部路由装配 + 静态挂载（挂载须在最后）
│   ├── core/                 # 12-Factor 配置（含模型映射表）+ 口令加盐哈希
│   ├── db/                   # ORM 全部表 + 会话工厂 + 幂等 seed
│   ├── auth/                 # AuthProvider 协议 + 本地口令实现 + fake OIDC + 依赖装配（ADR-006）
│   ├── model_gateway/        # T03：统一 chat/embed 出口 + 错误族 + Langfuse 上报 + admin self-test
│   ├── api/                  # /api/me、/api/admin/*（users / kbs / audit-events）
│   ├── ingest/               # T05：上传 API + 任务队列（SKIP LOCKED 租约）+ parser/chunker + worker
│   ├── retrieval/            # T06：pgvector 检索 + ACL 过滤 + citations
│   ├── chat/                 # T07：LangGraph 图 + 会话/Run API + SSE
│   ├── guardrails/           # T08：输入脱敏 + 输出敏感识别
│   ├── prompts/              # T10：版本表读写 + publish/current API
│   └── agentdesk/            # T11–T14：数据层 + 工作区 + 策略引擎（policy.py）+ 工具层（tools.py）+ 执行图（graph.py）+ 驱动器（runner.py）+ 模型抽象（llm.py）+ API 面（api.py，含 SSE）+ 演示仓
├── tests/                    # 284 单测
├── .env.example              # 环境变量样例（含密钥生成命令）
└── README.md
```

## 交付票据

~~T01 骨架~~ ✅ → ~~T02 账号体系~~ ✅ → ~~T03 模型网关~~ ✅ → ~~T04 知识库/ACL~~ ✅ →
~~T05 入库流水线~~ ✅ → ~~T06 检索服务~~ ✅ → ~~T07 Chat Run（LangGraph）~~ ✅ →
~~T08 Guardrails/审计~~ ✅ → ~~T09 Web 前端~~ ✅ → ~~T10 版本与评测~~ ✅（MVP 全量交付） →
~~T11 AgentDesk 数据层与工作区底座~~ ✅（Agent 执行域切片开始） → ~~T12 策略引擎与工具层~~ ✅ →
~~T13 Agent 执行图与审批 interrupt~~ ✅ → ~~T14 AgentDesk API 与 SSE~~ ✅ → ~~T15 AgentDesk 前端~~ ✅ →
T16 E2E 冒烟与文档收尾（进行中：审计域展示 / README 三节已落，真实 key 全链路冒烟待人工执行）
