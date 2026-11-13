# Agent Platform（企业内部 Agent 平台 MVP）

面试作品向的企业 Agent 平台 MVP 实现，范围收敛为**同步知识问答（RAG）**单一场景。
方案与决策依据：`../2026/day32企业内部 Agent 平台方案-v0.2.md`、`../2026/docs/adr/`（10 条 ADR）。

当前进度：**T01–T10 全部完成，MVP 全量交付**（105 单测全绿；票据与逐项验收记录见 `../.scratch/mvp-agent-platform/issues/`）。

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

## 平台能力（T04–T10）

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

## 服务拓扑（T01/T05）

| 服务 | 镜像 | 宿主端口 | 说明 |
| --- | --- | --- | --- |
| app | 自建（uv + FastAPI） | 8000 | 平台应用骨架，启动前自动执行 Alembic 迁移 |
| db | pgvector/pgvector:pg17 | 127.0.0.1:15432 | 平台主库（用户/ACL/任务队列/Checkpoint/向量），initdb 自动启用 vector 扩展 |
| redis | redis:7 | 127.0.0.1:16379 | 平台缓存/限流/登录态 |
| worker | 自建（与 app 同镜像） | - | 入库流水线消费者：SKIP LOCKED 租约认领 PG 队列任务，解析/切分/向量化（ADR-005） |
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
docker exec agent-platform-db-1 psql -U postgres -d agent_platform -c "SELECT * FROM alembic_version" # 0007_prompts
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
├── alembic/                  # 迁移链 0001→0007（accounts / kb_metadata / ingestion / chat / audit / prompts）
├── tools/fake-openai/        # OpenAI-compatible 演示服务（T03，免真实 key）
├── prompts/chat_qa.yaml      # 问答系统提示词（启动登记 → 版本化发布，T10）
├── evals/                    # 金标集 golden_set.jsonl + run_eval.py 回归（T10，结果存 results/）
├── web/                      # T09 前端三件套（纯静态，main.py StaticFiles 兜底挂载）
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
│   └── prompts/              # T10：版本表读写 + publish/current API
├── tests/                    # 105 单测
├── .env.example              # 环境变量样例（含密钥生成命令）
└── README.md
```

## 交付票据

~~T01 骨架~~ ✅ → ~~T02 账号体系~~ ✅ → ~~T03 模型网关~~ ✅ → ~~T04 知识库/ACL~~ ✅ →
~~T05 入库流水线~~ ✅ → ~~T06 检索服务~~ ✅ → ~~T07 Chat Run（LangGraph）~~ ✅ →
~~T08 Guardrails/审计~~ ✅ → ~~T09 Web 前端~~ ✅ → ~~T10 版本与评测~~ ✅（MVP 全量交付）
