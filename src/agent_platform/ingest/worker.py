"""入库 Worker（T05）：轮询 PG 任务队列，认领 → 处理 → 状态落库。

独立进程入口：python -m agent_platform.ingest.worker（compose worker 服务）。
租约语义：认领时写 lease_expires_at；进程崩溃未续约 → 到期被其它 Worker 重新认领；
处理前清理同任务半成品 chunks，保证重试幂等。
"""

import asyncio
import logging

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.core.config import settings
from agent_platform.db.models import IngestTask, KbChunk, KnowledgeBase
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
    """主循环：ingest 队列轮询消费。"""
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
        health_task.cancel()
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    asyncio.run(run_worker())
