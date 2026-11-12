"""LangGraph 治理中间件（T08，ADR-007）：以节点包装器形态挂在问答链路上。

- input_guard：提问进入检索与模型前脱敏（guard.input_masked 审计）
- output_guard：回答敏感处置（脱敏后返回）+ 每次问答 Run 的 chat.ask 审计
- 流式出口收敛：generate 节点只产出完整 answer，output_guard 审查后按片推送
  SSE delta 帧（治理作用于用户可见内容；整段审查的代价是流式起播延后，
  半缓冲滑动窗口审查留作后续优化）
"""

import asyncio
from typing import Callable

from langchain_core.messages import AIMessage, HumanMessage

from agent_platform.auth.provider import AuthContext
from agent_platform.guardrails.audit import record_event
from agent_platform.guardrails.masking import MaskFinding, ScreenResult, screen_text

_STREAM_CHUNK_SIZE = 24


def _stream_chunks(text: str, size: int = _STREAM_CHUNK_SIZE):
    """处置后的文本按固定长度切片，供 SSE delta 帧推送。"""
    for start in range(0, len(text), size):
        yield text[start : start + size]


def _screen_messages(messages: list) -> tuple[list, list[MaskFinding]]:
    """脱敏对话历史：命中敏感的消息以同 ID 新消息替换（add_messages reducer 覆盖语义），
    敏感原文不进模型上下文、也不落 checkpoint。"""
    cleaned: list = []
    findings: list[MaskFinding] = []
    for m in messages:
        screened = screen_text(str(m.content))
        if screened.findings:
            findings.extend(screened.findings)
            cls = HumanMessage if isinstance(m, HumanMessage) else AIMessage
            cleaned.append(cls(content=screened.text, id=m.id))
        else:
            cleaned.append(m)
    return cleaned, findings


def input_guard(node: Callable, *, session_factory) -> Callable:
    """包装检索节点：提问与对话历史先脱敏再进入检索与模型上下文。"""

    async def wrapper(state, config):
        auth: AuthContext = config["configurable"]["auth_ctx"]
        screened = screen_text(state["question"])
        cleaned, history_findings = _screen_messages(state["messages"])
        findings = [*screened.findings, *history_findings]
        if findings:
            async with session_factory() as session:
                await record_event(
                    session,
                    user_id=auth.user_id,
                    username=auth.username,
                    action="guard.input_masked",
                    object_type="chat",
                    outcome="filtered",
                    detail={"types": [f.type for f in findings], "counts": [f.count for f in findings]},
                )
        result = await node({**state, "question": screened.text, "messages": cleaned}, config)
        # 治理后的 question/messages 必须进入节点输出（经 reducer 合并进 channel/checkpoint），
        # 否则脱敏只作用于本轮节点内部，历史里仍是原文
        return {**result, "question": screened.text, "messages": cleaned}

    return wrapper


async def _record_output_events(
    session_factory, auth: AuthContext, screened: ScreenResult, kb_ids: list[str]
) -> None:
    """回答侧敏感命中审计：guard.output_masked（outcome=filtered，处置方式=脱敏后返回）。"""
    if not screened.findings:
        return
    async with session_factory() as session:
        await record_event(
            session,
            user_id=auth.user_id,
            username=auth.username,
            action="guard.output_masked",
            object_type="chat",
            outcome="filtered",
            detail={
                "types": [f.type for f in screened.findings],
                "counts": [f.count for f in screened.findings],
                "kb_ids": kb_ids,
            },
        )


def output_guard(node: Callable, *, session_factory) -> Callable:
    """包装生成节点：回答敏感处置 + chat.ask 审计 + 统一 SSE 流式推帧。"""
    async def wrapper(state, config):
        auth: AuthContext = config["configurable"]["auth_ctx"]
        result = await node(state, config)
        answer = result.get("answer", "")
        screened = screen_text(answer)
        citations = state.get("citations", [])
        kb_ids = sorted({c["kb_id"] for c in citations})
        async with session_factory() as session:
            # 每次问答 Run 一条 chat.ask 审计：谁、动作、对象（知识库范围）、结果
            await record_event(
                session,
                user_id=auth.user_id,
                username=auth.username,
                action="chat.ask",
                object_type="chat",
                outcome="allowed",
                detail={
                    "kb_ids": kb_ids,
                    "citation_count": len(citations),
                    "disposition": screened.disposition,
                },
            )
        await _record_output_events(session_factory, auth, screened, kb_ids)

        # 处置后的文本作为流式内容统一推送（delta 帧 + 结束哨兵）
        queue: asyncio.Queue | None = config["configurable"].get("token_queue")
        if queue is not None:
            for piece in _stream_chunks(screened.text):
                await queue.put(piece)
            await queue.put(None)
        return {**result, "answer": screened.text}

    return wrapper
