"""统一工作台服务层（ADR-014/016）：Profile 查询 + 消息信封落库 + 模型策略解析。

- append_message：seq 单语句原子取号（会话内 MAX+1，(session_id, seq) 唯一约束兜底并发）；
- resolve_model_chain：解析 profile.model_policy → [primary, *fallbacks]，None = 全局映射
  （ADR-016 决策 2）；非法 JSON 诚实回落全局（不崩会话）。
"""

import json
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.db.models import AgentProfile, ChatMessage, ChatSession

# 默认智能体（ADR-014 决策 3）：存量会话 profile_key 为 null 时按此解释
DEFAULT_PROFILE_KEY = "knowledge-assistant"


async def list_profiles(session: AsyncSession) -> list[AgentProfile]:
    """可选智能体列表（仅 enabled；一期 seed 两个内置）。"""
    rows = await session.scalars(
        select(AgentProfile)
        .where(AgentProfile.enabled.is_(True))
        .order_by(AgentProfile.created_at)
    )
    return list(rows.all())


async def get_profile(session: AsyncSession, key: str) -> AgentProfile | None:
    """按键取可用 Profile；不存在或停用返回 None。"""
    profile = await session.scalar(select(AgentProfile).where(AgentProfile.key == key))
    if profile is None or not profile.enabled:
        return None
    return profile


def resolve_model_chain(profile: AgentProfile | None) -> list[str | None]:
    """model_policy → 模型链 [primary, *fallbacks]；空/非法 → [None]（网关读全局映射）。

    链元素去重保序；None 只允许出现在首位（primary 缺省 = 全局映射优先）。
    """
    if profile is None or not profile.model_policy:
        return [None]
    try:
        policy = json.loads(profile.model_policy)
    except (json.JSONDecodeError, TypeError):
        return [None]
    chain: list[str | None] = []
    primary = policy.get("primary")
    if primary:
        chain.append(primary)
    elif policy.get("fallbacks"):
        chain.append(None)  # primary 缺省但配了 fallback：全局映射先试，再沿链降级
    chain.extend(m for m in policy.get("fallbacks", []) or [] if m)
    if not chain:
        return [None]
    dedup: list[str | None] = []
    for m in chain:
        if m not in dedup:
            dedup.append(m)
    return dedup


async def append_message(
    session: AsyncSession,
    session_id: uuid.UUID,
    type: str,
    data: dict | None = None,
) -> ChatMessage:
    """写入会话消息：seq 由同语句子查询取号（会话内 COALESCE(MAX(seq),0)+1）。"""
    next_seq = (
        select(func.coalesce(func.max(ChatMessage.seq), 0) + 1)
        .where(ChatMessage.session_id == session_id)
        .scalar_subquery()
    )
    message = ChatMessage(
        session_id=session_id,
        seq=next_seq,
        type=type,
        data=json.dumps(data, ensure_ascii=False) if data is not None else None,
    )
    session.add(message)
    await session.flush()
    await session.refresh(message, ["seq"])  # 取号值在 INSERT 时才确定，回读落库后的 seq
    return message


async def list_messages(
    session: AsyncSession,
    session_id: uuid.UUID,
    *,
    after_seq: int = 0,
    limit: int = 200,
) -> list[ChatMessage]:
    """按 seq 游标读取消息（after_seq 之后升序、至多 limit 条）——回放/续传数据底座。"""
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id, ChatMessage.seq > after_seq)
        .order_by(ChatMessage.seq)
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


# ---------- harness turn 索引（ADR-019：traceId ↔ 会话映射服务端化） ----------


def parse_hw_traces(chat_session: ChatSession) -> list[str]:
    """hw_trace_ids（JSON 数组字符串）→ list；空/非法诚实回落空表（不阻塞回放兑底）。"""
    if not chat_session.hw_trace_ids:
        return []
    try:
        data = json.loads(chat_session.hw_trace_ids)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [t for t in data if isinstance(t, str)]


async def add_hw_traces(
    session: AsyncSession, chat_session: ChatSession, trace_ids: list[str]
) -> list[str]:
    """幂等追加 harness traceId（保序去重），返回合并后全集（前端回放 gate 集合的数据源）。"""
    merged = parse_hw_traces(chat_session)
    for tid in trace_ids:
        if tid not in merged:
            merged.append(tid)
    chat_session.hw_trace_ids = json.dumps(merged, ensure_ascii=False)
    await session.flush()
    return merged


def serialize_profile(profile: AgentProfile) -> dict:
    return {
        "key": profile.key,
        "display_name": profile.display_name,
        "description": profile.description,
        "prompt_key": profile.prompt_key,
        "engine_kind": profile.engine_kind,
        "default_mode": profile.default_mode,
    }


def serialize_message(message: ChatMessage) -> dict:
    return {
        "seq": message.seq,
        "type": message.type,
        "data": json.loads(message.data) if message.data else {},
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }
