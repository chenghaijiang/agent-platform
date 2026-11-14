"""统一工作台 API（ADR-014~017 一期）：Profile 可选 + 会话绑定 + 双引擎发消息 + SSE 续传。

- GET  /api/workbench/profiles：可选智能体列表（enabled）；
- POST /api/workbench/sessions：创建会话并绑定智能体（缺省 knowledge-assistant，
  Q3A：换智能体 = 开新会话）；GET 列表带 profile_key；
- GET  /api/workbench/sessions/{id}/messages?after_seq=：消息回放（重启重建聊天流）；
- POST /api/workbench/sessions/{id}/messages：双引擎路由——
  qa_graph → SSE 直播（delta/done 帧，消息信封落库 + Run 记录，复用现有 QA 图）；
  agentdesk_bridge → 创建 AgentTask（chat_session_id 归属 + 202），进度经流端点
  惰性桥接 task_events → chat_messages（service.bridge_task_events）；
- GET  /api/workbench/sessions/{id}/stream：会话级 SSE——连接即回放 Last-Event-ID
  之后的消息（含卡片），再轮询尾随直播；帧 id=seq 即续传游标。

审批卡片按钮直接调既有 agentdesk 端点（plan/confirm、approvals/{id}/decide，Q4A），
决策后的事件流经桥接自动回到聊天流——本模块不复制任何审批逻辑。
"""

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.agentdesk import service as agentdesk_service
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat import service as chat_service
from agent_platform.guardrails.audit import record_event
from agent_platform.guardrails.masking import screen_text
from agent_platform.model_gateway.errors import ModelGatewayError
from agent_platform.prompts import service as prompts_service
from agent_platform.workbench import service
from agent_platform.workbench.service import DEFAULT_PROFILE_KEY

router = APIRouter(prefix="/api/workbench", tags=["workbench"])

SSE_POLL_INTERVAL_SECONDS = 0.5


class CreateSessionRequest(BaseModel):
    profile_key: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=128)


class SendMessageRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=20)
    # 会话级模型覆盖（前端模型选择器）：None = 平台默认（settings.model_chat_model）
    model: str | None = Field(default=None, max_length=128)


def _sse(seq: int, event: str, payload: dict) -> str:
    """SSE 帧：id=seq（Last-Event-ID 续传游标）、event=消息信封类型。"""
    return f"id: {seq}\nevent: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _owned_session_with_profile(
    session: AsyncSession, session_id: uuid.UUID, auth: AuthContext
) -> tuple[object, object]:
    """取归属会话及其绑定 Profile（null → 默认智能体，ADR-014 决策 3）。"""
    chat_session = await chat_service.get_owned_session(session, session_id, auth.user_id)
    if chat_session is None:
        raise HTTPException(status_code=404, detail="session not found")
    profile_key = chat_session.profile_key or DEFAULT_PROFILE_KEY
    profile = await service.get_profile(session, profile_key)
    if profile is None:
        raise HTTPException(status_code=409, detail=f"profile '{profile_key}' is unavailable")
    return chat_session, profile


# ---------- 智能体可选 ----------


@router.get("/profiles")
async def list_profiles(
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    return [service.serialize_profile(p) for p in await service.list_profiles(session)]


# ---------- 会话（渠道层，绑定智能体） ----------


@router.post("/sessions", status_code=201)
async def create_session(
    payload: CreateSessionRequest,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建会话并绑定智能体；未指定或空 → 默认知识问答助手（Q3A）。"""
    profile_key = payload.profile_key or DEFAULT_PROFILE_KEY
    if await service.get_profile(session, profile_key) is None:
        raise HTTPException(status_code=422, detail=f"unknown or disabled profile: {profile_key}")
    chat_session = await chat_service.create_session(
        session, user_id=auth.user_id, title=payload.title
    )
    chat_session.profile_key = profile_key
    await session.commit()
    await session.refresh(chat_session)
    return _serialize_session(chat_session)


@router.get("/sessions")
async def list_sessions(
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    rows = await chat_service.list_user_sessions(session, auth.user_id)
    return [_serialize_session(s) for s in rows]


def _serialize_session(chat_session) -> dict:
    return {
        **chat_service.serialize_session(chat_session),
        "profile_key": chat_session.profile_key or DEFAULT_PROFILE_KEY,
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: uuid.UUID,
    request: Request,
    auth: AuthContext = Depends(require_auth),
) -> Response:
    """删除会话（硬删）：聊天流与 Run 记录一并清除。

    级联语义由 FK 预留（ADR-015 决策 4）：chat_messages / chat_runs ondelete=CASCADE，
    agent_tasks.chat_session_id ondelete=SET NULL（任务留档、脱离会话）；
    LangGraph checkpoint 按 thread_id 残留无归属引用，无业务影响。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session = await chat_service.get_owned_session(session, session_id, auth.user_id)
        if chat_session is None:
            raise HTTPException(status_code=404, detail="session not found")
        await session.delete(chat_session)
        await session.commit()
    return Response(status_code=204)


# ---------- 消息回放（重启重建聊天流，ADR-015 决策 5） ----------


@router.get("/sessions/{session_id}/messages")
async def replay_messages(
    session_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    after_seq: int = 0,
) -> dict:
    """按 seq 游标回放消息（text / agent_event / approval_card 信封）。"""
    chat_session = await chat_service.get_owned_session(session, session_id, auth.user_id)
    if chat_session is None:
        raise HTTPException(status_code=404, detail="session not found")
    messages = await service.list_messages(session, chat_session.id, after_seq=after_seq)
    return {
        "session_id": str(session_id),
        "after_seq": after_seq,
        "messages": [service.serialize_message(m) for m in messages],
    }


# ---------- 发消息：双引擎路由 ----------


@router.post("/sessions/{session_id}/messages", response_model=None)
async def send_message(
    session_id: uuid.UUID,
    payload: SendMessageRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth),
) -> StreamingResponse | JSONResponse:
    """发消息：按会话绑定智能体的 engine_kind 路由（Q9A 桥接，零改既有两域）。"""
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session, profile = await _owned_session_with_profile(session, session_id, auth)
        chat_session_id = chat_session.id
        thread_id = chat_session.thread_id
        # 用户消息落库前输入脱敏（ADR-007）：敏感原文不进聊天流/检索/模型上下文，
        # 命中即审计 guard.input_masked（图内 input_guard 对历史兜底，不重复计数）。
        # agentdesk goal 保持原文：执行域需要完整任务语义，域内自有 policy/红线审计
        screened = screen_text(payload.question)
        user_message = await service.append_message(
            session, chat_session_id, "text", {"role": "user", "text": screened.text}
        )
        if screened.findings:
            await record_event(
                session,
                user_id=auth.user_id,
                username=auth.username,
                action="guard.input_masked",
                object_type="chat",
                outcome="filtered",
                detail={
                    "types": [f.type for f in screened.findings],
                    "counts": [f.count for f in screened.findings],
                },
            )
        await session.commit()

    if profile.engine_kind == "qa_graph":
        return await _qa_stream(
            request,
            auth,
            chat_session_id,
            thread_id,
            screened.text,
            payload.top_k,
            profile,
            user_message.seq,
            payload.model,
        )
    if profile.engine_kind == "agentdesk_bridge":
        return await _bridge_dispatch(request, auth, chat_session_id, payload, profile)
    # runtime 引擎为二期自研内核预留位（ADR-015），一期如实 501
    raise HTTPException(status_code=501, detail=f"engine '{profile.engine_kind}' not available yet")


async def _qa_stream(
    request: Request,
    auth: AuthContext,
    chat_session_id: uuid.UUID,
    thread_id: uuid.UUID,
    question: str,
    top_k: int,
    profile,
    user_seq: int,
    model: str | None,
) -> StreamingResponse:
    """qa_graph 引擎：SSE 直播（text/delta/done/error），复用现有 QA 图与 Run 记录。

    与 chat/api.py 的差异：消息信封落库（user 先行、assistant 收尾）、
    model_chain 经 configurable 注入（ADR-016 fallback 链，含图内换模审计）。
    question 为输入脱敏后的文本：不进检索/模型/Run 记录。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        run = await chat_service.record_run_start(
            session, chat_session_id=chat_session_id, question=question
        )
        # Prompt 走发布体系（profile.prompt_key；无发布版本时图内代码默认兜底）
        current_prompt = await prompts_service.get_current(
            session, profile.prompt_key or "chat_qa"
        )
    run_id = run.id
    system_prompt = current_prompt.template if current_prompt else None
    model_chain = service.resolve_model_chain(profile)
    if model:
        # 会话级模型覆盖（前端选择器）：用户显式选择优先于 profile 策略链首，
        # fallback 链其余元素保留（Error Recovery 语义不变，ADR-016）
        model_chain = [model, *model_chain[1:]]

    async def event_stream():
        token_queue: asyncio.Queue = asyncio.Queue()
        # user 帧先行（帧格式对齐会话流信封）：前端以落库文本（脱敏后）替换乐观气泡，
        # 敏感原文不驻留聊天流；seq 记账后会话流重放不再渲染
        yield _sse(
            user_seq,
            "text",
            {"seq": user_seq, "type": "text", "data": {"role": "user", "text": question}},
        )
        try:
            graph_task = asyncio.create_task(
                request.app.state.chat_graph.ainvoke(
                    {"question": question, "messages": [HumanMessage(content=question)]},
                    config={
                        "configurable": {
                            "thread_id": str(thread_id),
                            "auth_ctx": auth,
                            "token_queue": token_queue,
                            "top_k": top_k,
                            "system_prompt": system_prompt,
                            "model_chain": model_chain,
                            "profile_key": profile.key,
                        }
                    },
                )
            )
            # 哨兵 None 由 output_guard 在生成成功后推送（与 chat/api.py 同机制）：
            # 图异常时哨兵不来，必须同时监视 graph_task，否则 SSE 挂死到客户端超时
            get_task = asyncio.create_task(token_queue.get())
            try:
                while True:
                    done, _ = await asyncio.wait(
                        {get_task, graph_task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if get_task in done:
                        delta = get_task.result()
                        if delta is None:
                            break
                        yield _sse(0, "delta", {"text": delta})
                        get_task = asyncio.create_task(token_queue.get())
                    elif graph_task in done:
                        await graph_task
                        break
            finally:
                if not get_task.done():
                    get_task.cancel()

            final = await graph_task
            citations = final.get("citations", [])
            async with factory() as session:
                await chat_service.record_run_end(
                    session, run_id, answer=final.get("answer", ""), citations=citations
                )
                assistant = await service.append_message(
                    session,
                    chat_session_id,
                    "text",
                    {"role": "assistant", "text": final.get("answer", ""), "citations": citations},
                )
                await session.commit()
            yield _sse(
                assistant.seq,
                "done",
                {"run_id": str(run_id), "seq": assistant.seq, "citations": citations},
            )
        except (ModelGatewayError, Exception) as exc:  # noqa: BLE001 - SSE 内不能抛裸异常
            async with factory() as session:
                await chat_service.record_run_end(session, run_id, error=f"{type(exc).__name__}: {exc}")
                await service.append_message(
                    session,
                    chat_session_id,
                    "agent_event",
                    {"event": "error", "error": f"{type(exc).__name__}: {exc}", "role": "assistant"},
                )
                await session.commit()
            yield _sse(0, "error", {"message": f"{type(exc).__name__}: {exc}", "user_seq": user_seq})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


async def _bridge_dispatch(
    request: Request,
    auth: AuthContext,
    chat_session_id: uuid.UUID,
    payload: SendMessageRequest,
    profile,
) -> JSONResponse:
    """agentdesk_bridge 引擎：一条驱动消息创建一个 AgentTask（会话 1↔N，ADR-015 决策 4）。

    执行归既有 Worker 认领（SKIP LOCKED）；进度/审批卡片经 stream 端点惰性桥接
    task_events → chat_messages。审批按钮调既有 agentdesk 端点（Q4A）。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session = await chat_service.get_owned_session(session, chat_session_id, auth.user_id)
        if chat_session is None:  # pragma: no cover - 调用方已校验，防御性兜底
            raise HTTPException(status_code=404, detail="session not found")
        task = await agentdesk_service.create_task(
            session,
            goal=payload.question,
            owns=[],
            mode=profile.default_mode or "confirm",
            title=payload.question[:40],
            user_id=auth.user_id,
            workspace_manager=WorkspaceManager.from_settings(),
        )
        task.chat_session_id = chat_session_id  # 统一工作台归属（ADR-015 决策 4）
        await service.append_message(
            session,
            chat_session_id,
            "agent_event",
            {"event": "task_created", "task_id": str(task.id), "status": task.status},
            task_id=task.id,
        )
        await session.commit()
    return JSONResponse(
        status_code=202,
        content={"task_id": str(task.id), "status": task.status, "profile_key": profile.key},
    )


# ---------- 会话级 SSE：回放 + 惰性桥接 + 尾随直播 ----------


@router.get("/sessions/{session_id}/stream")
async def stream_session(
    session_id: uuid.UUID,
    request: Request,
    auth: AuthContext = Depends(require_auth),
    last_event_id: int = 0,
) -> StreamingResponse:
    """会话消息流：连接即回放 Last-Event-ID 之后的消息，再轮询尾随直播。

    每轮先桥接会话名下各 AgentTask 的 task_events 增量（幂等高水位），
    再读 chat_messages 增量下发；帧 id=seq（续传游标）。流由客户端断开收尾
    （无终态 done 帧——会话生命周期长于单条任务）。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session = await chat_service.get_owned_session(session, session_id, auth.user_id)
        if chat_session is None:
            raise HTTPException(status_code=404, detail="session not found")
        chat_session_id = chat_session.id

    header_cursor = request.headers.get("last-event-id")
    cursor = int(header_cursor) if header_cursor and header_cursor.isdigit() else last_event_id

    async def event_stream():
        nonlocal cursor
        while True:
            async with factory() as session:
                for task in await service.session_tasks(session, chat_session_id):
                    await service.bridge_task_events(session, chat_session, task)
                messages = await service.list_messages(
                    session, chat_session_id, after_seq=cursor
                )
            for m in messages:
                cursor = m.seq
                data = json.loads(m.data) if m.data else {}
                payload = {
                    "seq": m.seq,
                    "ts": m.created_at.isoformat() if m.created_at else None,
                    "type": m.type,
                    "data": data,
                    "task_id": str(m.task_id) if m.task_id else None,
                }
                yield _sse(m.seq, m.type, payload)
            await asyncio.sleep(SSE_POLL_INTERVAL_SECONDS)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
