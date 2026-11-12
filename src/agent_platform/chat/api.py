"""会话与问答 API（T07）：会话 CRUD + SSE 流式问答 + Run 记录查询。

SSE 帧协议：
  event: delta   data: {"text": "<增量文本>"}      （若干帧）
  event: done    data: {"run_id", "citations": [...]}（结束帧，携带完整引用列表）
  event: error   data: {"message": "..."}
"""

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat import service
from agent_platform.model_gateway.errors import ModelGatewayError
from agent_platform.prompts import service as prompts_service
from agent_platform.prompts.service import PROMPT_CHAT_QA

router = APIRouter(prefix="/api", tags=["chat"])


class CreateSessionRequest(BaseModel):
    title: str | None = Field(default=None, max_length=128)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=5, ge=1, le=20)


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.post("/sessions")
async def create_session(
    payload: CreateSessionRequest,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建会话：返回会话 ID 与 thread 映射（执行态由 Checkpointer 按 thread_id 持久化）。"""
    chat_session = await service.create_session(session, user_id=auth.user_id, title=payload.title)
    return service.serialize_session(chat_session)


@router.get("/sessions")
async def list_sessions(
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    rows = await service.list_user_sessions(session, auth.user_id)
    return [service.serialize_session(s) for s in rows]


@router.post("/sessions/{session_id}/chat")
async def chat(
    session_id: uuid.UUID,
    payload: ChatRequest,
    request: Request,
    auth: AuthContext = Depends(require_auth),
) -> StreamingResponse:
    """提问 → SSE 流式回答（delta 帧）→ 结束帧携带完整引用列表。

    生成器内部使用独立短会话（依赖注入的请求级 session 在响应阶段已关闭）。
    """
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session = await service.get_owned_session(session, session_id, auth.user_id)
        if chat_session is None:
            raise HTTPException(status_code=404, detail="session not found")
        run = await service.record_run_start(session, chat_session_id=chat_session.id, question=payload.question)
        # T10：运行链路读取当前已发布版本的 Prompt（无发布版本时图内用代码默认兜底）
        current_prompt = await prompts_service.get_current(session, PROMPT_CHAT_QA)
    run_id = run.id
    system_prompt = current_prompt.template if current_prompt else None

    async def event_stream():
        token_queue: asyncio.Queue = asyncio.Queue()
        try:
            graph_task = asyncio.create_task(
                request.app.state.chat_graph.ainvoke(
                    {"question": payload.question, "messages": [HumanMessage(content=payload.question)]},
                    config={
                        "configurable": {
                            "thread_id": str(chat_session.thread_id),
                            "auth_ctx": auth,
                            "token_queue": token_queue,
                            "top_k": payload.top_k,
                            "system_prompt": system_prompt,
                        }
                    },
                )
            )
            # 消费生成节点推入的增量文本 → SSE delta 帧
            while True:
                delta = await token_queue.get()
                if delta is None:
                    break
                yield _sse("delta", {"text": delta})

            final = await graph_task
            citations = final.get("citations", [])
            async with factory() as session:
                await service.record_run_end(
                    session, run_id, answer=final.get("answer", ""), citations=citations
                )
            yield _sse("done", {"run_id": str(run_id), "citations": citations})
        except (ModelGatewayError, Exception) as exc:  # noqa: BLE001 - SSE 内不能抛裸异常
            async with factory() as session:
                await service.record_run_end(session, run_id, error=f"{type(exc).__name__}: {exc}")
            yield _sse("error", {"message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/sessions/{session_id}/runs")
async def list_runs(
    session_id: uuid.UUID,
    request: Request,
    auth: AuthContext = Depends(require_auth),
) -> list[dict]:
    """Run 执行记录查询：状态（running/completed/failed）+ 引用列表可见。"""
    factory = request.app.state.session_factory
    async with factory() as session:
        chat_session = await service.get_owned_session(session, session_id, auth.user_id)
        if chat_session is None:
            raise HTTPException(status_code=404, detail="session not found")
        rows = await service.list_session_runs(session, chat_session.id)
    return [service.serialize_run(r, with_citations=True) for r in rows]
