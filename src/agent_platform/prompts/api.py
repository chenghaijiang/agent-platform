"""Prompt 版本 API（T10）：草稿创建 / 发布 / 版本列表 / 当前发布版查询（仅管理员）。"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.prompts import service

router = APIRouter(prefix="/api/admin/prompts", tags=["prompts"])


class CreateDraftRequest(BaseModel):
    template_key: str = Field(min_length=1, max_length=64)
    template: str = Field(min_length=1)
    change_note: str | None = Field(default=None, max_length=256)


@router.post("", status_code=201)
async def create_draft(
    payload: CreateDraftRequest,
    _admin: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    prompt = await service.create_draft(
        session, template_key=payload.template_key, template=payload.template, change_note=payload.change_note
    )
    return service.serialize(prompt)


@router.post("/{prompt_id}/publish")
async def publish_version(
    prompt_id: uuid.UUID,
    _admin: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    try:
        prompt = await service.publish(session, prompt_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except service.PromptPublishError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return service.serialize(prompt)


@router.get("")
async def list_versions(
    template_key: str | None = Query(default=None),
    _admin: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    rows = await service.list_versions(session, template_key)
    return [service.serialize(p) for p in rows]


@router.get("/current/{template_key}")
async def get_current_version(
    template_key: str,
    _admin: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    prompt = await service.get_current(session, template_key)
    if prompt is None:
        raise HTTPException(status_code=404, detail=f"no published version for {template_key}")
    return service.serialize(prompt)
