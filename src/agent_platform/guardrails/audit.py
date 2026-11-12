"""审计事件写入（T08，ADR-007）：审计 ≠ Trace（独立于 Langfuse），落业务库 audit_events 表。

治理动作（脱敏/拦截/允许）统一经本模块写入，调用方只传结构化字段。
"""

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.db.models import AuditEvent


async def record_event(
    session: AsyncSession,
    *,
    user_id: str,
    username: str,
    action: str,
    object_type: str,
    object_id: str | None = None,
    outcome: str,
    detail: dict[str, Any] | None = None,
) -> AuditEvent:
    """写一条审计事件并提交（治理动作与业务写入同事务语义）。"""
    event = AuditEvent(
        user_id=user_id,
        username=username,
        action=action,
        object_type=object_type,
        object_id=object_id,
        outcome=outcome,
        detail=json.dumps(detail, ensure_ascii=False) if detail else None,
    )
    session.add(event)
    await session.commit()
    await session.refresh(event)
    return event
