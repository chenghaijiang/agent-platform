"""会话与 Run 记录（T07）：会话元数据 CRUD + Run 状态记录（running/completed/failed）。"""

import json
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.db.models import ChatRun, ChatSession


async def create_session(session: AsyncSession, *, user_id: str, title: str | None = None) -> ChatSession:
    """创建会话：thread_id 与会话同生命周期（session.thread_id ↔ LangGraph thread 映射）。"""
    chat_session = ChatSession(user_id=user_id, title=title, thread_id=uuid.uuid4())
    session.add(chat_session)
    await session.commit()
    await session.refresh(chat_session)
    return chat_session


async def get_owned_session(session: AsyncSession, session_id: uuid.UUID, user_id: str) -> ChatSession | None:
    """会话归属校验：只能访问自己的会话（跨用户访问一律 404，不泄露存在性）。"""
    chat_session = await session.get(ChatSession, session_id)
    if chat_session is None or chat_session.user_id != user_id:
        return None
    return chat_session


async def list_user_sessions(session: AsyncSession, user_id: str) -> list[ChatSession]:
    rows = await session.scalars(
        select(ChatSession).where(ChatSession.user_id == user_id).order_by(ChatSession.created_at.desc())
    )
    return list(rows.all())


async def list_session_runs(session: AsyncSession, chat_session_id: uuid.UUID) -> list[ChatRun]:
    rows = await session.scalars(
        select(ChatRun)
        .where(ChatRun.session_id == chat_session_id)
        .order_by(ChatRun.created_at.desc())
    )
    return list(rows.all())


async def record_run_start(session: AsyncSession, *, chat_session_id: uuid.UUID, question: str) -> ChatRun:
    """Run 开始：一次提问对应一次 Run 执行记录（glossary：Run ≠ 任务）。"""
    run = ChatRun(session_id=chat_session_id, question=question, status="running")
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


async def record_run_end(
    session: AsyncSession,
    run_id: uuid.UUID,
    *,
    answer: str | None = None,
    citations: list[dict] | None = None,
    error: str | None = None,
) -> str:
    """Run 结束：completed（含引用 JSON）/ failed（含错误）。返回终态。"""
    from datetime import UTC, datetime

    values: dict[str, object] = {"finished_at": datetime.now(UTC)}
    if error is not None:
        values["status"] = "failed"
        values["error"] = error[-2000:]
    else:
        values["status"] = "completed"
        values["answer"] = answer
        values["citations"] = json.dumps(citations or [], ensure_ascii=False)
    run = await session.get(ChatRun, run_id)
    if run is None:
        raise LookupError(f"chat run {run_id} not found")
    for key, value in values.items():
        setattr(run, key, value)
    await session.commit()
    return str(values["status"])


def serialize_session(chat_session: ChatSession) -> dict:
    return {
        "id": str(chat_session.id),
        "thread_id": str(chat_session.thread_id),
        "title": chat_session.title,
        "created_at": chat_session.created_at.isoformat() if chat_session.created_at else None,
    }


def serialize_run(run: ChatRun, *, with_citations: bool = False) -> dict:
    body = {
        "id": str(run.id),
        "session_id": str(run.session_id),
        "question": run.question,
        "status": run.status,
        "answer": run.answer,
        "error": run.error,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
    if with_citations and run.citations:
        body["citations"] = json.loads(run.citations)
    return body
