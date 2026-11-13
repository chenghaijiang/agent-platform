"""入库 API（T05）：文档上传（幂等建任务，立即返回不阻塞）+ 任务状态查询。

上传仅落对象存储与任务表，解析/向量化由 Worker 异步执行——大文档不占用 HTTP 请求。
"""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.core.config import settings
from agent_platform.db.models import IngestTask, KbChunk, KnowledgeBase
from agent_platform.ingest import service
from agent_platform.ingest.parser import SUPPORTED_SUFFIXES
from agent_platform.ingest.storage import DocumentStorage

router = APIRouter(prefix="/api/admin", tags=["ingest"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # MVP 上限 20MB，防御误传超大文件


def get_storage(request: Request) -> DocumentStorage:
    """从应用 lifespan 取对象存储单例（测试可 override 为内存假实现）。"""
    return request.app.state.document_storage


def _serialize(task: IngestTask) -> dict:
    return {
        "id": str(task.id),
        "kb_id": str(task.kb_id),
        "status": task.status,
        "attempt": task.attempt,
        "max_attempts": task.max_attempts,
        "lease_expires_at": task.lease_expires_at.isoformat() if task.lease_expires_at else None,
        "next_retry_at": task.next_retry_at.isoformat() if task.next_retry_at else None,
        "last_error": task.last_error,
        "source_filename": task.source_filename,
        "content_hash": task.content_hash,
        "created_at": task.created_at.isoformat() if task.created_at else None,
    }


@router.post("/kbs/{kb_id}/documents")
async def upload_document(
    kb_id: uuid.UUID,
    file: UploadFile,
    _admin=Depends(require_admin),
    session: AsyncSession = Depends(get_session),
    storage: DocumentStorage = Depends(get_storage),
) -> Response:
    """上传文档 → 立即返回入库任务（queued）。幂等：同 KB 同内容返回已有任务（200 + duplicate）。"""
    if await session.get(KnowledgeBase, kb_id) is None:
        raise HTTPException(status_code=404, detail="knowledge base not found")

    filename = file.filename or "document"
    if not filename.lower().endswith(SUPPORTED_SUFFIXES):
        raise HTTPException(
            status_code=415,
            detail={
                "message": "unsupported document type",
                "supported": list(SUPPORTED_SUFFIXES),
                "filename": filename,
            },
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large (max 20MB)")

    try:
        task, created = await service.create_task(
            session,
            kb_id=kb_id,
            filename=filename,
            data=data,
            storage=storage,
            max_attempts=settings.ingest_max_attempts,
        )
    except service.UnknownKnowledgeBaseError:
        raise HTTPException(status_code=404, detail="knowledge base not found") from None

    body = _serialize(task)
    body["duplicate"] = not created
    return Response(
        status_code=201 if created else 200,
        content=json.dumps(body, ensure_ascii=False),
        media_type="application/json",
    )


@router.get("/ingest/tasks/{task_id}")
async def get_task(
    task_id: uuid.UUID,
    _admin=Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """任务状态查询：状态机五态 / 重试计数 / 最近错误可见。"""
    task = await session.get(IngestTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return _serialize(task)


@router.get("/kbs/{kb_id}/tasks/{task_id}/chunks")
async def list_task_chunks(
    kb_id: uuid.UUID,
    task_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _admin=Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """切片预览（admin）：查看某入库任务的切分结果与向量维度。

    用于验证切片策略效果（chunk 大小/标题路径/字符数），以及排查
    切换 embedding 模型后的维度混存问题（embedding_dim 字段）。
    """
    task = await session.get(IngestTask, task_id)
    if task is None or task.kb_id != kb_id:
        raise HTTPException(status_code=404, detail="task not found in this knowledge base")
    total = await session.scalar(
        select(func.count()).select_from(KbChunk).where(KbChunk.task_id == task_id)
    )
    chunks = (
        await session.scalars(
            select(KbChunk)
            .where(KbChunk.task_id == task_id)
            .order_by(KbChunk.chunk_index)
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return {
        "task_id": str(task.id),
        "kb_id": str(task.kb_id),
        "source_filename": task.source_filename,
        "status": task.status,
        "total": total,
        "offset": offset,
        "limit": limit,
        "chunks": [
            {
                "chunk_index": c.chunk_index,
                "heading_path": c.heading_path,
                "content": c.content,
                "char_count": len(c.content),
                "classification": c.classification,
                "embedding_dim": len(c.embedding) if c.embedding is not None else None,
            }
            for c in chunks
        ],
    }


@router.get("/kbs/{kb_id}/tasks")
async def list_kb_tasks(
    kb_id: uuid.UUID,
    _admin=Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """知识库维度任务列表（最新在前），供管理界面观察状态流转。"""
    if await session.get(KnowledgeBase, kb_id) is None:
        raise HTTPException(status_code=404, detail="knowledge base not found")
    tasks = (
        await session.scalars(
            select(IngestTask)
            .where(IngestTask.kb_id == kb_id)
            .order_by(IngestTask.created_at.desc())
        )
    ).all()
    return [_serialize(t) for t in tasks]
