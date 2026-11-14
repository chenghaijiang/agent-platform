"""AgentDesk API 面（T14，agentdesk-implementation.md §3 全表）。

任务 CRUD + SSE 事件流 + 计划确认/审批决策 resume + hunk 评审 + 门禁提交：

- 创建任务即入队（status=created，租约空闲），Worker 经 SKIP LOCKED 认领跑 runner.start；
- SSE（GET + fetch/ReadableStream + Bearer header，与 chat SSE 同机制）：连接即回放
  Last-Event-ID 之后的历史事件再尾随直播（Q7 断线重连零丢失），帧 id=seq 即续传游标；
- confirm/decide 端点同步校验挂起点（防重复 resume 与决策错配）后，图执行经
  asyncio.create_task 后台跑（runner 三入口都是长时 await，不能阻塞请求）；
- hunk 接受/拒绝落库；commit 门禁：全部 hunk accepted 且 checks 全绿，否则 409 带原因。

鉴权全部 require_auth；任务归属校验（owner 或 admin，否则 404 不泄露存在性）。
"""

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.agentdesk import service
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import (
    AGENT_TASK_MODES,
    AGENT_TASK_TERMINAL_STATUSES,
    AgentHunk,
    AgentTask,
    Approval,
)

logger = logging.getLogger("agent_platform.agentdesk.api")

router = APIRouter(prefix="/api/agentdesk", tags=["agentdesk"])

SSE_POLL_INTERVAL_SECONDS = 0.5


# ---------- 请求/响应模型 ----------


class CreateTaskRequest(BaseModel):
    goal: str = Field(min_length=1, max_length=2000)
    owns: list[str] = Field(default_factory=list)
    mode: str = Field(default="confirm")
    refs: list[str] = Field(default_factory=list)
    title: str | None = Field(default=None, max_length=128)


class PlanConfirmRequest(BaseModel):
    action: str  # approve / cancel


class DecideRequest(BaseModel):
    decision: str  # once / always / deny


class HunkActionRequest(BaseModel):
    hunk_id: str
    action: str  # accept / reject


# ---------- 内部辅助 ----------


async def _owned_task(
    session: AsyncSession, task_id: uuid.UUID, auth: AuthContext
) -> AgentTask:
    """归属校验：owner 或 admin；其余一律 404（不向越权者泄露任务存在性）。"""
    task = await session.get(AgentTask, task_id)
    if task is None or (task.created_by != auth.user_id and auth.role != "admin"):
        raise HTTPException(status_code=404, detail="task not found")
    return task


def serialize_task(task: AgentTask, hunks: dict | None = None) -> dict:
    data = {
        "id": str(task.id),
        "title": task.title,
        "goal": task.goal,
        "mode": task.mode,
        "status": task.status,
        "owns": json.loads(task.owns) if task.owns else [],
        "refs": json.loads(task.refs) if task.refs else [],
        "created_by": task.created_by,
        "created_at": task.created_at.isoformat() if task.created_at else None,
    }
    if hunks is not None:
        data["hunks"] = hunks
    return data


def serialize_hunk(hunk: AgentHunk) -> dict:
    return {
        "id": str(hunk.id),
        "idx": hunk.idx,
        "path": hunk.path,
        "header": hunk.header,
        "content": hunk.content,
        "additions": hunk.additions,
        "deletions": hunk.deletions,
        "status": hunk.status,
    }


def _sse(seq: int, event: str, payload: dict) -> str:
    """SSE 帧：id=seq（Last-Event-ID 续传游标）、event=事件类型、data=信封负载。"""
    return f"id: {seq}\nevent: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _background(graph_coro, *, task_id: uuid.UUID, what: str) -> None:
    """图执行后台化：runner._fail 已兜底转 partial，这里只补日志不丢异常。"""
    task = asyncio.create_task(graph_coro)

    def _log_done(future: asyncio.Future) -> None:
        if not future.cancelled() and future.exception() is not None:
            logger.warning(
                "background %s for task %s failed: %s", what, task_id, future.exception()
            )

    task.add_done_callback(_log_done)


# ---------- 任务 CRUD ----------


@router.post("/tasks", status_code=201)
async def create_task(
    payload: CreateTaskRequest,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建任务（§3 表）：落库 + 分配 workspace + 首条事件；入队后由 Worker 认领执行。"""
    if payload.mode not in AGENT_TASK_MODES:
        raise HTTPException(status_code=422, detail=f"unknown mode: {payload.mode}")
    task = await service.create_task(
        session,
        goal=payload.goal,
        owns=payload.owns,
        mode=payload.mode,
        refs=payload.refs or None,
        title=payload.title or payload.goal[:40],
        user_id=auth.user_id,
        workspace_manager=WorkspaceManager.from_settings(),
    )
    await session.commit()
    return serialize_task(task)


@router.get("/tasks")
async def list_tasks(
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """任务列表（§3 表）：状态点 + hunk 评审进度；非 admin 仅见自己的任务。"""
    stmt = select(AgentTask).order_by(AgentTask.created_at.desc()).limit(100)
    if auth.role != "admin":
        stmt = stmt.where(AgentTask.created_by == auth.user_id)
    rows = (await session.scalars(stmt)).all()
    result = []
    for task in rows:
        result.append(serialize_task(task, await service.hunks_summary(session, task.id)))
    return result


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """任务详情（§3 表）：含 owns/mode/hunks；review 态惰性生成 hunk 清单（幂等落库）。"""
    task = await _owned_task(session, task_id, auth)
    hunks: list[AgentHunk] = []
    if task.status == "review":
        hunks = await service.ensure_hunks(session, task, WorkspaceManager.from_settings())
        await session.commit()
    return serialize_task(task, await service.hunks_summary(session, task.id)) | {
        "hunk_list": [serialize_hunk(h) for h in hunks]
    }


# ---------- SSE 事件流（Q7：Last-Event-ID 回放 + 尾随直播） ----------


@router.get("/tasks/{task_id}/events")
async def stream_events(
    task_id: uuid.UUID,
    request: Request,
    auth: AuthContext = Depends(require_auth),
    last_event_id: int = 0,
) -> StreamingResponse:
    """SSE 事件流（§3 表）：连接即回放历史（Last-Event-ID header 优先于 query 游标），
    之后轮询尾随直播；任务终态且事件耗尽后发 done 帧关流。

    重连零丢失：seq 单调（(task_id, seq) 唯一约束），客户端以最后收到的 id 重连续传。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        await _owned_task(session, task_id, auth)

    header_cursor = request.headers.get("last-event-id")
    cursor = int(header_cursor) if header_cursor and header_cursor.isdigit() else last_event_id

    async def event_stream():
        # 客户端断开时 CancelledError 自然向外传播终止生成器，无需额外 handler
        nonlocal cursor
        while True:
            async with factory() as session:
                events = await service.list_events(session, task_id, after_seq=cursor)
                task = await session.get(AgentTask, task_id)
            for e in events:
                cursor = e.seq
                data = json.loads(e.data) if e.data else {}
                payload = {
                    "seq": e.seq,
                    "ts": e.created_at.isoformat() if e.created_at else None,
                    **data,
                }
                yield _sse(e.seq, e.type, payload)
            terminal_drained = (
                task is not None
                and task.status in AGENT_TASK_TERMINAL_STATUSES
                and not events
            )
            if terminal_drained:
                yield _sse(cursor, "done", {"seq": cursor})
                return
            await asyncio.sleep(SSE_POLL_INTERVAL_SECONDS)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- resume 入口（计划确认 / 审批决策） ----------


@router.post("/tasks/{task_id}/plan/confirm", status_code=202)
async def confirm_plan(
    task_id: uuid.UUID,
    payload: PlanConfirmRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """计划确认（§3 表）：approve 确认后切自动编辑继续执行 / cancel 取消任务。

    同步校验挂起点（kind=plan_confirm 存在）后 202；图执行后台跑。
    无挂起点（重复确认/任务已推进）409。
    """
    task = await _owned_task(session, task_id, auth)
    runner = request.app.state.agent_runner
    interrupt = await runner.pending_interrupt(task.id)
    if interrupt is None or interrupt.get("kind") != "plan_confirm":
        raise HTTPException(status_code=409, detail="no pending plan confirmation")
    _background(
        runner.confirm_plan(task.id, action=payload.action, username=auth.username),
        task_id=task.id,
        what="plan_confirm",
    )
    return {"accepted": True, "task_id": str(task.id), "action": payload.action}


@router.post("/approvals/{approval_id}/decide", status_code=202)
async def decide_approval(
    approval_id: uuid.UUID,
    payload: DecideRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """审批三选（§3 表）：once/always/deny → Run resume；always 同步写策略表带作用域。

    时序：先校验挂起点与审批单匹配 → resolve_approval 落库（事件+审计+always 授权）→
    后台 runner.decide resume。双击防：第二次 resolve 抛 LookupError → 409。
    """
    approval = await session.get(Approval, approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="approval not found")
    task = await _owned_task(session, approval.task_id, auth)
    runner = request.app.state.agent_runner
    interrupt = await runner.pending_interrupt(task.id)
    if interrupt is None or str(interrupt.get("approval_id")) != str(approval_id):
        raise HTTPException(status_code=409, detail="approval is not pending in a suspended run")
    try:
        await service.resolve_approval(session, approval_id, decision=payload.decision, decided_by=auth.username)
        await session.commit()
    except LookupError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _background(
        runner.decide(
            task.id, approval_id, decision=payload.decision, decided_by=auth.username
        ),
        task_id=task.id,
        what="approval_decide",
    )
    return {"accepted": True, "approval_id": str(approval_id), "decision": payload.decision}


# ---------- hunk 评审与门禁提交 ----------


@router.post("/tasks/{task_id}/hunks")
async def decide_hunk(
    task_id: uuid.UUID,
    payload: HunkActionRequest,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """hunk 接受/拒绝（§3 表）：pending → accepted/rejected；返回最新评审进度。"""
    task = await _owned_task(session, task_id, auth)
    if task.status != "review":
        raise HTTPException(status_code=409, detail=f"task status is {task.status}, not review")
    try:
        hunk_id = uuid.UUID(payload.hunk_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid hunk_id") from exc
    try:
        await service.decide_hunk(session, task, hunk_id, action=payload.action, decided_by=auth.username)
        await session.commit()
    except LookupError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"accepted": True, "hunks": await service.hunks_summary(session, task.id)}


@router.post("/tasks/{task_id}/commit")
async def commit_task(
    task_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """门禁提交（§3 表）：全部 hunk accepted 且 checks 全绿 → git commit；否则 409 带原因。"""
    task = await _owned_task(session, task_id, auth)
    try:
        result = await service.commit_task(
            session, task, WorkspaceManager.from_settings(), committed_by=auth.username
        )
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return result
