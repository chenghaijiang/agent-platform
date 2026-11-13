"""管理员端点（T02）：创建用户并分配角色、查看用户与角色。"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.core.security import hash_password
from agent_platform.db.models import Role, User

router = APIRouter(prefix="/api/admin", tags=["admin"])


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=128)
    role: str = Field(min_length=1, max_length=32)


class UpdateUserRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)
    role: str | None = Field(default=None, min_length=1, max_length=32)
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)  # 重置密码


class UserOut(BaseModel):
    id: uuid.UUID
    username: str
    display_name: str | None
    role: str
    is_active: bool
    created_at: datetime


def _user_out(user: User, role_name: str) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=role_name,
        is_active=user.is_active,
        created_at=user.created_at,
    )


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: CreateUserRequest,
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """管理员创建用户并分配角色；用户名冲突 409，角色不存在 422。"""
    role = await session.scalar(select(Role).where(Role.name == payload.role))
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unknown role"
        )
    exists = await session.scalar(select(User).where(User.username == payload.username))
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="username already exists"
        )
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name,
        role_id=role.id,
    )
    session.add(user)
    await session.commit()
    return _user_out(user, role.name).model_dump(mode="json")


@router.patch("/users/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    payload: UpdateUserRequest,
    context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """管理员修改用户：显示名 / 角色 / 启停 / 重置密码，全字段可选（PATCH 语义）。

    不允许停用自己：防止唯一管理员停用自己后平台失去管理入口。
    """
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")
    # user.id 是 UUID、JWT sub 是字符串：统一转 str 比较，否则保护恒不生效
    if payload.is_active is False and str(user.id) == context.user_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="cannot deactivate yourself"
        )
    if payload.role is not None:
        role = await session.scalar(select(Role).where(Role.name == payload.role))
        if role is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unknown role"
            )
        user.role_id = role.id
    if payload.display_name is not None:
        user.display_name = payload.display_name
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
    await session.commit()
    role_name = await session.scalar(select(Role.name).where(Role.id == user.role_id))
    return _user_out(user, role_name or "").model_dump(mode="json")


@router.get("/users")
async def list_users(
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """管理员查看用户列表。"""
    stmt = select(User, Role.name).join(Role, User.role_id == Role.id).order_by(User.created_at)
    rows = (await session.execute(stmt)).all()
    return [_user_out(user, role_name).model_dump(mode="json") for user, role_name in rows]


@router.get("/roles")
async def list_roles(
    _context: AuthContext = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    """管理员查看角色列表。"""
    roles = (await session.execute(select(Role).order_by(Role.name))).scalars().all()
    return [{"id": str(r.id), "name": r.name, "description": r.description} for r in roles]
