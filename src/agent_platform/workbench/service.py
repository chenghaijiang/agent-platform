"""统一工作台服务层（ADR-014/015/016）：Profile 查询 + 消息信封落库 + 任务事件桥接。

- append_message：seq 单语句原子取号（会话内 MAX+1，(session_id, seq) 唯一约束兜底并发），
  与 agentdesk.append_event 同模式（ADR-015 决策 5）；
- bridge_task_events：把 task_events 未桥接增量转写为 chat_messages（幂等：按已桥接
  task_seq 高水位）。「SSE 桥接 task_events 到聊天流」（Q9A）的落库形态——转写发生在
  流端点拉取时（惰性桥接），重启后重放天然覆盖（task_events 本身持久）；
  已知边界：同一会话并发开两条流会双写（一期假设单流；二期内核改集中分发）；
- resolve_model_chain：解析 profile.model_policy → [primary, *fallbacks]，None = 全局映射
  （ADR-016 决策 2）；非法 JSON 诚实回落全局（不崩会话）。
"""

import json
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.agentdesk import service as agentdesk_service
from agent_platform.db.models import AgentProfile, AgentTask, ChatMessage, ChatSession

# 默认智能体（ADR-014 决策 3）：存量会话 profile_key 为 null 时按此解释
DEFAULT_PROFILE_KEY = "knowledge-assistant"

# 任务事件 → 消息信封类型映射（ADR-014 决策 4）：
# approval_required / plan 是两种审批卡片（工具审批 / 计划确认），其余为执行事件流
CARD_EVENT_TYPES = ("approval_required", "plan")


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
    *,
    task_id: uuid.UUID | None = None,
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
        task_id=task_id,
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


async def session_tasks(session: AsyncSession, chat_session_id: uuid.UUID) -> list[AgentTask]:
    """会话名下的 Agent 任务（会话 1↔N Task，ADR-015 决策 4）。"""
    rows = await session.scalars(
        select(AgentTask)
        .where(AgentTask.chat_session_id == chat_session_id)
        .order_by(AgentTask.created_at)
    )
    return list(rows.all())


async def bridge_task_events(
    session: AsyncSession,
    chat_session: ChatSession,
    task: AgentTask,
) -> int:
    """把 task_events 未桥接增量转写为 chat_messages；返回本次转写条数（幂等）。

    高水位 = 该任务已桥接消息中最大的 data.task_seq；转写映射见 CARD_EVENT_TYPES——
    plan 事件转审批卡片（kind=plan_confirm，按钮 → 既有 plan/confirm 端点）、
    approval_required 转审批卡片（按钮 → 既有 approvals/{id}/decide 端点，Q4A）。
    """
    high = 0
    rows = await session.scalars(select(ChatMessage).where(ChatMessage.task_id == task.id))
    for m in rows.all():
        if not m.data:
            continue
        try:
            bridged = int(json.loads(m.data).get("task_seq", 0))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        high = max(high, bridged)

    events = await agentdesk_service.list_events(session, task.id, after_seq=high)
    count = 0
    for e in events:
        payload = json.loads(e.data) if e.data else {}
        payload = {**payload, "task_id": str(task.id), "task_seq": e.seq}
        if e.type in CARD_EVENT_TYPES:
            msg_type = "approval_card"
            if e.type == "plan":
                payload = {**payload, "kind": "plan_confirm"}
        else:
            msg_type = "agent_event"
        await append_message(session, chat_session.id, msg_type, payload, task_id=task.id)
        count += 1
    if count:
        await session.commit()
    return count


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
        "task_id": str(message.task_id) if message.task_id else None,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }
