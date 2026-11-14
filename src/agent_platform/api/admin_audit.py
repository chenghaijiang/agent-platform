"""审计事件查询 API（T08）：仅管理员可查，按用户 / 动作 / 时间窗过滤。"""

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import AuditEvent

router = APIRouter(prefix="/api/admin", tags=["audit"])


def _serialize(event: AuditEvent) -> dict:
    return {
        "id": str(event.id),
        "user_id": event.user_id,
        "username": event.username,
        "action": event.action,
        "object_type": event.object_type,
        "object_id": event.object_id,
        "outcome": event.outcome,
        "detail": json.loads(event.detail) if event.detail else None,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


@router.get("/audit-events")
async def list_audit_events(
    user_id: str | None = Query(default=None),
    action: str | None = Query(default=None),
    outcome: str | None = Query(default=None),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    _admin: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """审计事件查询：按用户、动作、处置结果与时间窗过滤，时间倒序。"""
    query = select(AuditEvent)
    if user_id:
        query = query.where(AuditEvent.user_id == user_id)
    if action:
        query = query.where(AuditEvent.action == action)
    if outcome:
        query = query.where(AuditEvent.outcome == outcome)
    if since:
        query = query.where(AuditEvent.created_at >= since)
    if until:
        query = query.where(AuditEvent.created_at <= until)
    rows = await session.scalars(query.order_by(AuditEvent.created_at.desc()).limit(limit))
    return [_serialize(e) for e in rows.all()]
