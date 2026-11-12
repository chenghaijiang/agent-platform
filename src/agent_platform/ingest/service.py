"""入库任务服务（T05，ADR-005 任务模型）：

- create_task：上传侧入口，content_hash 幂等（同 KB 同内容未终态任务直接复用）
- claim_next_task：Worker 认领，UPDATE...WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)，
  覆盖三类可认领态：queued / failed 且退避到期 / running 且租约到期（进程崩溃恢复）
- mark_succeeded / mark_failed：状态机流转（五态见 db.models.TASK_STATUSES）

时间统一用应用时钟 aware-UTC（SQLite 不支持 statement timestamp，PG 侧同为 UTC）。
"""

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import ScalarResult, and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.db.models import IngestTask, KnowledgeBase
from agent_platform.ingest.storage import DocumentStorage

# 幂等键 kb_id + content_hash：仅 dead 允许重新上传重建（死信重传）；
# succeeded 复用避免同内容重复 chunks，queued/running/failed 复用避免并发重复任务


class UnknownKnowledgeBaseError(Exception):
    """目标知识库不存在（API 层转 404）。"""


def content_hash_of(data: bytes) -> str:
    """内容指纹：幂等键的一部分（kb_id + content_hash）。"""
    return hashlib.sha256(data).hexdigest()


async def create_task(
    session: AsyncSession,
    *,
    kb_id: uuid.UUID,
    filename: str,
    data: bytes,
    storage: DocumentStorage,
    max_attempts: int = 3,
) -> tuple[IngestTask, bool]:
    """创建入库任务；幂等命中（同 KB 同内容且非终态）时返回已有任务与 False。

    原始文件在入库前先归档对象存储，key 含 content_hash 天然去重。
    """
    if await session.get(KnowledgeBase, kb_id) is None:
        raise UnknownKnowledgeBaseError(f"knowledge base {kb_id} does not exist")

    digest = content_hash_of(data)
    existing: ScalarResult[IngestTask] = await session.scalars(
        select(IngestTask)
        .where(
            IngestTask.kb_id == kb_id,
            IngestTask.content_hash == digest,
            IngestTask.status != "dead",
        )
        .order_by(IngestTask.created_at.desc())
        .limit(1)
    )
    reusable = existing.first()
    if reusable is not None:
        return reusable, False

    object_key = f"kb/{kb_id}/{digest}/{filename}"
    await asyncio.to_thread(storage.put, object_key, data)

    task = IngestTask(
        kb_id=kb_id,
        status="queued",
        max_attempts=max_attempts,
        source_filename=filename[-256:],  # 截断防御：列宽 256
        content_hash=digest,
        object_key=object_key,
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task, True


def _claimable_condition(now: datetime):
    """三类可认领状态（ADR-005）：新任务 / 失败退避到期 / 租约过期（崩溃恢复）。"""
    return or_(
        IngestTask.status == "queued",
        and_(
            IngestTask.status == "failed",
            or_(IngestTask.next_retry_at.is_(None), IngestTask.next_retry_at <= now),
        ),
        and_(
            IngestTask.status == "running",
            IngestTask.lease_expires_at.isnot(None),
            IngestTask.lease_expires_at <= now,
        ),
    )


async def claim_next_task(session: AsyncSession, *, lease_seconds: int) -> IngestTask | None:
    """原子认领一个任务：置 running、attempt+1、写入租约。

    子查询 FOR UPDATE SKIP LOCKED 保证多 Worker 并发认领不取到同一行；
    认领即提交（释放行锁），处理失败不影响该行已被本 Worker 持有的语义。
    """
    now = datetime.now(UTC)
    candidate_ids = (
        select(IngestTask.id)
        .where(_claimable_condition(now))
        .order_by(IngestTask.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    result = await session.execute(
        update(IngestTask)
        .where(IngestTask.id.in_(candidate_ids))
        .values(
            status="running",
            attempt=IngestTask.attempt + 1,
            lease_expires_at=now + timedelta(seconds=lease_seconds),
        )
        .returning(IngestTask)
    )
    task = result.scalar_one_or_none()
    await session.commit()
    return task


async def mark_succeeded(session: AsyncSession, task_id: uuid.UUID) -> None:
    await session.execute(
        update(IngestTask)
        .where(IngestTask.id == task_id)
        .values(status="succeeded", lease_expires_at=None, last_error=None)
    )
    await session.commit()


async def mark_failed(
    session: AsyncSession, task_id: uuid.UUID, error: str, *, backoff_seconds: int
) -> str:
    """失败流转：attempt 未耗尽 → failed（写入退避时间）；耗尽 → dead（死信）。

    返回终态字符串，供 Worker 日志与验收断言。
    """
    task = await session.get(IngestTask, task_id)
    if task is None:
        raise LookupError(f"task {task_id} not found")

    values: dict[str, object] = {"lease_expires_at": None, "last_error": error[-2000:]}
    if task.attempt >= task.max_attempts:
        values["status"] = "dead"
    else:
        values["status"] = "failed"
        values["next_retry_at"] = datetime.now(UTC) + timedelta(seconds=backoff_seconds)

    await session.execute(update(IngestTask).where(IngestTask.id == task_id).values(**values))
    await session.commit()
    return str(values["status"])
