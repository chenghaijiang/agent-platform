"""FastAPI 应用骨架（T01-T07）：健康检查 + 账号认证 + 模型网关 + 知识库 + 入库流水线 + 在线检索 + 会话问答。

无状态约束（ADR-004）：进程内只持有到 PG / Redis / MinIO 的连接与模型网关 client，任何业务状态外置。
"""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent_platform.api import admin_audit, admin_kbs, admin_users, me
from agent_platform.auth.router import router as auth_router
from agent_platform.chat.api import router as chat_router
from agent_platform.chat.graph import build_chat_graph
from agent_platform.core.config import settings
from agent_platform.db.engine import build_session_factory
from agent_platform.harness.api import router as harness_router
from agent_platform.ingest.api import router as ingest_router
from agent_platform.ingest.storage import DocumentStorage
from agent_platform.model_gateway.api import router as model_gateway_router
from agent_platform.model_gateway.gateway import ModelGateway
from agent_platform.prompts.api import router as prompts_router
from agent_platform.retrieval.api import router as retrieval_router
from agent_platform.retrieval.service import RetrievalService
from agent_platform.workbench.api import router as workbench_router


async def _seed_prompt_baseline(session_factory) -> None:
    """首次启动时把 prompts/chat_qa.yaml 导入为 v1 草稿并发布（表非空则跳过）。"""
    import yaml

    from agent_platform.prompts import service as prompts_service

    baseline = Path(__file__).resolve().parent.parent.parent / "prompts" / "chat_qa.yaml"
    if not baseline.exists():
        return
    async with session_factory() as session:
        if await prompts_service.get_current(session, "chat_qa") is not None:
            return
        if await prompts_service.list_versions(session, "chat_qa"):
            return
        data = yaml.safe_load(baseline.read_text(encoding="utf-8"))
        draft = await prompts_service.create_draft(
            session,
            template_key=data["template_key"],
            template=data["template"],
            change_note="seed from prompts/chat_qa.yaml",
        )
        await prompts_service.publish(session, draft.id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine: AsyncEngine = create_async_engine(settings.database_url, pool_pre_ping=True)
    redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.engine = engine
    app.state.redis = redis_client
    # T02 起：业务端点通过 api.deps.get_session 从 app.state 取会话工厂
    app.state.session_factory = build_session_factory(engine)
    # T03 起：模型网关单例（统一 OpenAI-compatible 出口 + Langfuse 自动上报）
    app.state.model_gateway = ModelGateway.from_settings()
    # T05 起：对象存储单例（桶不存在则幂等建桶；失败不阻塞启动，Worker 侧会重试）
    app.state.document_storage = DocumentStorage.from_settings()
    try:
        await asyncio.to_thread(app.state.document_storage.ensure_bucket)
    except Exception:  # noqa: BLE001, S110 - 建桶失败不阻塞启动（Worker 侧重试）
        pass
    # T06 起：在线检索服务（双路召回 + ACL 过滤，复用模型网关向量化 query）
    retrieval_service = RetrievalService(app.state.model_gateway)
    app.state.retrieval_service = retrieval_service
    # T07 起：问答执行图（LangGraph + Postgres Checkpointer，ADR-008 执行态独立建表）
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg_pool import AsyncConnectionPool

    checkpoint_dsn = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    checkpoint_pool = AsyncConnectionPool(
        conninfo=checkpoint_dsn,
        max_size=10,
        # autocommit：setup() 含 CREATE INDEX CONCURRENTLY，必须在事务块外执行
        kwargs={"autocommit": True, "prepare_threshold": 0},
        open=False,
    )
    await checkpoint_pool.open()  # 显式打开：构造时不隐式启动后台 worker
    checkpointer = AsyncPostgresSaver(checkpoint_pool)
    await checkpointer.setup()  # 幂等建 checkpoints 等表
    app.state.chat_graph = build_chat_graph(
        session_factory=app.state.session_factory,
        retrieval=retrieval_service,
        gateway=app.state.model_gateway,
        checkpointer=checkpointer,
    )
    # T10：Prompt 模板基线 seed（表空时从 prompts/ 目录导入 v1 并发布，幂等）
    await _seed_prompt_baseline(app.state.session_factory)
    # ADR-019：harness 网关上游客户端（连接池复用；SSE 读超时置 None 防长连接被拉断，
    # 上游不可达时由网关统一 502，不阻塞平台启动——工作台连接状态条如实降级）
    app.state.harness_client = httpx.AsyncClient(
        base_url=settings.harness_base_url,
        timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=30.0),
    )
    yield
    # 观测数据落盘后再退出，避免丢失尚未批量上报的 trace
    try:
        await app.state.model_gateway.flush()
    except Exception:  # noqa: BLE001, S110 - 观测 flush 失败不阻塞退出
        pass
    await redis_client.aclose()
    await checkpoint_pool.close()
    await app.state.harness_client.aclose()
    await engine.dispose()


app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)

# 路由注册：认证（公开）与业务（受保护，依赖 require_auth/require_admin）
app.include_router(auth_router)
app.include_router(me.router)
app.include_router(admin_users.router)
app.include_router(admin_audit.router)
app.include_router(prompts_router)
app.include_router(admin_kbs.router)
app.include_router(ingest_router)
app.include_router(retrieval_router)
app.include_router(chat_router)
app.include_router(workbench_router)
# ADR-019：harness 网关（catch-all /api/harness/{path}，需登录）——必须在静态挂载之前
app.include_router(harness_router)
app.include_router(model_gateway_router)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """存活探针：进程存活即返回 200，不触碰外部依赖。"""
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.app_version,
        "env": settings.app_env,
    }


@app.get("/readyz")
async def readyz() -> dict[str, Any]:
    """就绪探针：校验 PG / Redis 连通性，供 Compose healthcheck 与发布前检查使用。"""
    checks = {"postgres": False, "redis": False}

    try:
        async with app.state.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["postgres"] = True
    except Exception:  # noqa: BLE001, S110 - 探针语义：失败即 degraded
        pass

    try:
        checks["redis"] = bool(await app.state.redis.ping())
    except Exception:  # noqa: BLE001, S110 - 探针语义：失败即 degraded
        pass

    if all(checks.values()):
        return {"status": "ready", "checks": checks}
    raise HTTPException(status_code=503, detail={"status": "degraded", "checks": checks})


# T09：静态前端（web/）兜底挂载——必须位于全部 API 路由与探针之后，
# 否则 Mount("/") 会遮蔽后注册的 /healthz、/readyz。
_web_dir = Path(__file__).resolve().parent.parent.parent / "web"
app.mount("/", StaticFiles(directory=_web_dir, html=True), name="web")
