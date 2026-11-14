"""入库 Worker（T05）+ Agent 任务消费循环（T14）：轮询 PG 任务队列，认领 → 处理 → 状态落库。

独立进程入口：python -m agent_platform.ingest.worker（compose worker 服务）。
租约语义：认领时写 lease_expires_at；进程崩溃未续约 → 到期被其它 Worker 重新认领；
处理前清理同任务半成品 chunks，保证重试幂等。

T14 起：同一 Worker 进程并行消费两个队列（asyncio.gather）——
- ingest 循环：知识问答域入库任务（status=queued/failed/租约过期）；
- agent 循环：AgentDesk 任务（status=created）认领后跑 runner.start 至挂起或终态；
  挂起态由 Checkpointer 持久化，后续 resume 由 API 层 confirm/decide 端点驱动，不归 Worker。
"""

import asyncio
import logging

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.agentdesk import service as agentdesk_service
from agent_platform.agentdesk.graph import build_agent_graph
from agent_platform.agentdesk.llm import GatewayInvoker
from agent_platform.agentdesk.runner import AgentDeskRunner
from agent_platform.agentdesk.tools import ToolExecutor
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.core.config import settings
from agent_platform.db.models import AgentTask, IngestTask, KbChunk, KnowledgeBase
from agent_platform.ingest import service
from agent_platform.ingest.chunker import chunk_sections
from agent_platform.ingest.parser import parse
from agent_platform.ingest.storage import DocumentStorage
from agent_platform.model_gateway.gateway import ModelGateway

logger = logging.getLogger("agent_platform.ingest.worker")

# 单次向量化批大小：避开真实供应商单请求条数上限（fake-openai 无限制，统一走批）
EMBED_BATCH_SIZE = 64


async def _health_server(port: int) -> None:
    """极简 TCP 健康：healthcheck 连接成功即视为存活（slim 镜像无 ps/pgrep）。"""

    async def handle(_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            writer.write(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok")
            await writer.drain()
        finally:
            writer.close()

    server = await asyncio.start_server(handle, "0.0.0.0", port)
    async with server:
        await server.serve_forever()


async def process_task(session, task: IngestTask, *, storage: DocumentStorage, gateway: ModelGateway) -> int:
    """执行单个任务：下载 → 解析 → 切分 → 批量向量化 → 落 chunks。返回 chunk 数。

    gateway 只要求具备 embed(texts) -> EmbedResult 的鸭子类型（测试可注入假实现）。
    """
    kb = await session.get(KnowledgeBase, task.kb_id)
    if kb is None:
        raise LookupError(f"knowledge base {task.kb_id} vanished for task {task.id}")

    data = await asyncio.to_thread(storage.get, task.object_key)
    sections = parse(task.source_filename, data)
    chunks = chunk_sections(sections)
    if not chunks:
        raise ValueError("document parsed to zero chunks (empty or unreadable content)")

    # 重试场景清理半成品：同任务 chunks 全量重建（uq 约束兜底）
    await session.execute(delete(KbChunk).where(KbChunk.task_id == task.id))

    texts = [c.content for c in chunks]
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH_SIZE):
        result = await gateway.embed(texts[start : start + EMBED_BATCH_SIZE])
        vectors.extend(result.vectors)

    for index, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True)):
        session.add(
            KbChunk(
                kb_id=task.kb_id,
                task_id=task.id,
                chunk_index=index,
                content=chunk.content,
                heading_path=chunk.heading_path or None,
                classification=kb.classification,  # 密级冗余：T06 ACL 过滤免 join
                content_hash=service.content_hash_of(chunk.content.encode("utf-8")),
                embedding=vector,
            )
        )
    await session.commit()
    return len(chunks)


async def run_worker(stop_event: asyncio.Event | None = None) -> None:
    """主循环：ingest 与 agent 双队列并行消费（T14 起同一进程，各自独立轮询）。"""
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    storage = DocumentStorage.from_settings()
    await asyncio.to_thread(storage.ensure_bucket)
    gateway = ModelGateway.from_settings()

    logger.info(
        "ingest worker started: lease=%ss backoff=%ss poll=%ss",
        settings.ingest_lease_seconds,
        settings.ingest_retry_backoff_seconds,
        settings.ingest_poll_interval_seconds,
    )
    health_task = asyncio.create_task(_health_server(settings.ingest_health_port))
    agent_task = asyncio.create_task(_agent_loop(factory, stop_event))
    try:
        while stop_event is None or not stop_event.is_set():
            try:
                async with factory() as session:
                    task = await service.claim_next_task(
                        session, lease_seconds=settings.ingest_lease_seconds
                    )
                if task is None:
                    await asyncio.sleep(settings.ingest_poll_interval_seconds)
                    continue

                async with factory() as session:
                    current = await session.get(IngestTask, task.id)
                    if current is None:  # 任务所属 KB 被级联删除
                        continue
                    try:
                        count = await process_task(
                            session, current, storage=storage, gateway=gateway
                        )
                        await service.mark_succeeded(session, task.id)
                        logger.info("task %s succeeded: %d chunks", task.id, count)
                    except Exception as exc:  # noqa: BLE001 - 单任务失败由 mark_failed 记录并重试
                        final = await service.mark_failed(
                            session,
                            task.id,
                            f"{type(exc).__name__}: {exc}",
                            backoff_seconds=settings.ingest_retry_backoff_seconds,
                        )
                        logger.warning(
                            "task %s attempt %d/%d -> %s: %s",
                            task.id,
                            task.attempt,
                            task.max_attempts,
                            final,
                            exc,
                        )
                await gateway.flush()
            except Exception:
                # 认领/基础设施异常：不杀进程，退避后继续（任务仍被租约机制保护）
                logger.exception("worker loop error")
                await asyncio.sleep(settings.ingest_poll_interval_seconds)
    finally:
        agent_task.cancel()
        health_task.cancel()
        await engine.dispose()


# ---------------- Agent 任务消费循环（T14，ADR-005 模式复用） ----------------


async def _build_agent_runner(factory) -> AgentDeskRunner:
    """装配 Worker 侧 Agent 执行图：与 main.py 同构（同预算参数、同一 Checkpointer 表）。"""
    checkpoint_dsn = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    pool = AsyncConnectionPool(
        conninfo=checkpoint_dsn,
        max_size=5,
        kwargs={"autocommit": True, "prepare_threshold": 0},
        open=False,
    )
    await pool.open()
    checkpointer = AsyncPostgresSaver(pool)
    await checkpointer.setup()  # 幂等
    workspaces = WorkspaceManager.from_settings()
    graph = build_agent_graph(
        session_factory=factory,
        workspace_manager=workspaces,
        executor=ToolExecutor.from_settings(workspaces),
        invoker=GatewayInvoker(ModelGateway.from_settings()),
        checkpointer=checkpointer,
        max_steps=settings.agentdesk_max_steps,
        max_total_tokens=settings.agentdesk_max_total_tokens,
        max_check_rounds=settings.agentdesk_max_check_rounds,
    )
    return AgentDeskRunner(graph, factory)


async def _agent_loop(factory, stop_event: asyncio.Event | None) -> None:
    """Agent 任务消费：认领 status=created → runner.start 至挂起/终态 → 释放租约。

    重试语义：runner.start 校验失败（状态已推进）直接跳过；图异常已被 runner._fail
    兜底转 partial；认领后进程崩溃 → 租约到期重新认领，attempts 超上限降级 partial。
    """
    runner = await _build_agent_runner(factory)
    logger.info("agent loop started: lease=%ss poll=%ss", settings.agentdesk_lease_seconds, settings.agentdesk_poll_interval_seconds)
    while stop_event is None or not stop_event.is_set():
        task = None
        try:
            async with factory() as session:
                task = await agentdesk_service.claim_next_task(
                    session, lease_seconds=settings.agentdesk_lease_seconds
                )
            if task is None:
                await asyncio.sleep(settings.agentdesk_poll_interval_seconds)
                continue

            if task.attempts > settings.agentdesk_max_attempts:
                async with factory() as session:
                    current = await session.get(AgentTask, task.id)
                    if current is not None and current.status == "created":
                        await agentdesk_service.set_task_status(
                            session,
                            current,
                            "partial",
                            note=f"queue attempts exhausted ({task.attempts})",
                        )
                        await session.commit()
                continue

            logger.info("agent task %s claimed (attempt %d)", task.id, task.attempts)
            result = await runner.start(task.id, username=task.created_by)
            logger.info("agent task %s -> %s", task.id, result)
        except RuntimeError as exc:
            # start 校验失败（任务已推进/已被处理）：不重试，日志留痕
            logger.warning("agent task skipped: %s", exc)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("agent loop error")
        finally:
            if task is not None:
                try:
                    async with factory() as session:
                        await agentdesk_service.release_lease(session, task.id)
                except Exception:  # noqa: BLE001, S110 -- 释放失败由租约到期自愈
                    pass


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    asyncio.run(run_worker())
