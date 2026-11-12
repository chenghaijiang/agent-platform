"""知识库元数据与 ACL 管理 API（T04）：企业知识隔离单元的管理入口。

可见性查询（GET /api/admin/roles/{role}/kbs）严格来自 ACL 表，
是 T06 检索权限过滤与 T08 审计的数据来源。
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import (
    KB_CLASSIFICATION_LABELS,
    KnowledgeBase,
    KnowledgeBaseAcl,
    Role,
)

router = APIRouter(prefix="/api/admin", tags=["knowledge-bases"])


class CreateKbRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    classification: str = Field(pattern="^(public|internal|confidential)$")
    description: str | None = Field(default=None, max_length=512)


class UpdateKbRequest(BaseModel):
    classification: str | None = Field(default=None, pattern="^(public|internal|confidential)$")
    description: str | None = Field(default=None, max_length=512)


class GrantAclRequest(BaseModel):
    role: str = Field(min_length=1, max_length=32)
    permission: str = Field(default="read", pattern="^read$")  # MVP 仅可读位


def _kb_out(kb: KnowledgeBase) -> dict:
    return {
        "id": str(kb.id),
        "name": kb.name,
        "classification": kb.classification,
        "classification_label": KB_CLASSIFICATION_LABELS.get(kb.classification),
        "description": kb.description,
        "index_version": kb.index_version,
        "created_at": kb.created_at.isoformat(),
    }


async def _get_kb_or_404(session: AsyncSession, kb_id: uuid.UUID) -> KnowledgeBase:
    kb = await session.get(KnowledgeBase, kb_id)
    if kb is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="knowledge base not found")
    return kb


async def _get_role_or_422(session: AsyncSession, role_name: str) -> Role:
    role = await session.scalar(select(Role).where(Role.name == role_name))
    if role is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unknown role")
    return role


# ---------------- 知识库 CRUD（admin） ----------------


@router.post("/kbs", status_code=status.HTTP_201_CREATED)
async def create_kb(
    payload: CreateKbRequest,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建知识库；名称冲突 409。密级取值 public/internal/confidential。"""
    exists = await session.scalar(select(KnowledgeBase).where(KnowledgeBase.name == payload.name))
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="kb name already exists")
    kb = KnowledgeBase(
        name=payload.name,
        classification=payload.classification,
        description=payload.description,
    )
    session.add(kb)
    await session.commit()
    return _kb_out(kb)


@router.get("/kbs")
async def list_kbs(
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    kbs = (await session.execute(select(KnowledgeBase).order_by(KnowledgeBase.created_at))).scalars().all()
    return [_kb_out(kb) for kb in kbs]


@router.get("/kbs/{kb_id}")
async def get_kb(
    kb_id: uuid.UUID,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    return _kb_out(await _get_kb_or_404(session, kb_id))


@router.patch("/kbs/{kb_id}")
async def update_kb(
    kb_id: uuid.UUID,
    payload: UpdateKbRequest,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    kb = await _get_kb_or_404(session, kb_id)
    if payload.classification is not None:
        kb.classification = payload.classification
    if payload.description is not None:
        kb.description = payload.description
    await session.commit()
    return _kb_out(kb)


@router.delete("/kbs/{kb_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_kb(
    kb_id: uuid.UUID,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    kb = await _get_kb_or_404(session, kb_id)
    await session.delete(kb)  # ACL 由 FK ondelete=CASCADE 级联清理
    await session.commit()


# ---------------- ACL 授权（admin） ----------------


@router.post("/kbs/{kb_id}/acls", status_code=status.HTTP_201_CREATED)
async def grant_acl(
    kb_id: uuid.UUID,
    payload: GrantAclRequest,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """为角色授予知识库可读权限；重复授权 409，未知角色/知识库 422/404。"""
    kb = await _get_kb_or_404(session, kb_id)
    role = await _get_role_or_422(session, payload.role)
    exists = await session.scalar(
        select(KnowledgeBaseAcl).where(
            KnowledgeBaseAcl.role_id == role.id, KnowledgeBaseAcl.kb_id == kb.id
        )
    )
    if exists is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="acl already granted")
    acl = KnowledgeBaseAcl(role_id=role.id, kb_id=kb.id, permission=payload.permission)
    session.add(acl)
    await session.commit()
    return {"kb_id": str(kb.id), "kb_name": kb.name, "role": role.name, "permission": acl.permission}


@router.get("/kbs/{kb_id}/acls")
async def list_kb_acls(
    kb_id: uuid.UUID,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    await _get_kb_or_404(session, kb_id)
    stmt = (
        select(Role.name, KnowledgeBaseAcl.permission)
        .join(Role, KnowledgeBaseAcl.role_id == Role.id)
        .where(KnowledgeBaseAcl.kb_id == kb_id)
        .order_by(Role.name)
    )
    rows = (await session.execute(stmt)).all()
    return [{"role": role_name, "permission": permission} for role_name, permission in rows]


@router.delete("/kbs/{kb_id}/acls/{role_name}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_acl(
    kb_id: uuid.UUID,
    role_name: str,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    """收回角色的知识库可读权限；未授权 404。"""
    kb = await _get_kb_or_404(session, kb_id)
    role = await session.scalar(select(Role).where(Role.name == role_name))
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="acl not granted")
    acl = await session.scalar(
        select(KnowledgeBaseAcl).where(
            KnowledgeBaseAcl.role_id == role.id, KnowledgeBaseAcl.kb_id == kb.id
        )
    )
    if acl is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="acl not granted")
    await session.delete(acl)
    await session.commit()


# ---------------- 可见性查询（admin；T06/T08 的数据来源） ----------------


@router.get("/roles/{role_name}/kbs")
async def list_visible_kbs(
    role_name: str,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """给定角色返回其可见知识库列表：与 ACL 表严格一致（join 权限位 read）。"""
    role = await _get_role_or_422(session, role_name)
    stmt = (
        select(KnowledgeBase)
        .join(KnowledgeBaseAcl, KnowledgeBaseAcl.kb_id == KnowledgeBase.id)
        .where(KnowledgeBaseAcl.role_id == role.id, KnowledgeBaseAcl.permission == "read")
        .order_by(KnowledgeBase.name)
    )
    kbs = (await session.execute(stmt)).scalars().all()
    return [_kb_out(kb) for kb in kbs]
