"""用户管理与切片预览单测：PATCH /api/admin/users/{id} 与 GET /api/admin/kbs/{kb}/tasks/{task}/chunks。

PATCH 覆盖：改角色 / 改显示名 / 启停 / 重置密码 / 未知角色 422 / 404 / 禁止停用自己。
chunks 覆盖：切片列表有序返回（含向量维度）/ task 不属于该 kb 404。
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.api import admin_users
from agent_platform.api.admin_users import UpdateUserRequest  # noqa: F401 - 模型导入校验
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.core.security import verify_password
from agent_platform.db.models import Base, IngestTask, KbChunk, KnowledgeBase, Role, User

ADMIN_UID = str(uuid.uuid4())
ADMIN = AuthContext(user_id=ADMIN_UID, username="tester", role="admin", provider="test")


@pytest_asyncio.fixture()
async def client():
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        member_role = Role(name="member", description="普通员工")
        admin_role = Role(name="admin", description="管理员")
        session.add_all([member_role, admin_role])
        await session.flush()
        # ADMIN 自身（user_id=ADMIN_UID），用于"不能停用自己"断言
        session.add(User(id=uuid.UUID(ADMIN_UID), username="tester", password_hash="x", role_id=admin_role.id))
        await session.commit()

    app = FastAPI()
    app.include_router(admin_users.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_admin] = lambda: ADMIN

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._factory = factory  # 供断言直接查表
        yield ac
    await engine.dispose()


async def _create_user(client: AsyncClient, username: str = "newbie", role: str = "member") -> dict:
    resp = await client.post(
        "/api/admin/users",
        json={"username": username, "password": "Password-123", "role": role, "display_name": "新人"},
    )
    assert resp.status_code == 201
    return resp.json()


async def test_patch_user_role(client):
    user = await _create_user(client)
    resp = await client.patch(f"/api/admin/users/{user['id']}", json={"role": "admin"})
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin"


async def test_patch_user_display_name_and_password(client):
    user = await _create_user(client)
    resp = await client.patch(
        f"/api/admin/users/{user['id']}",
        json={"display_name": "新名字", "password": "NewPass-456"},
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "新名字"
    async with client._factory() as session:
        row = await session.scalar(select(User).where(User.username == "newbie"))
        assert verify_password("NewPass-456", row.password_hash)


async def test_patch_user_deactivate_and_reactivate(client):
    user = await _create_user(client)
    off = await client.patch(f"/api/admin/users/{user['id']}", json={"is_active": False})
    assert off.status_code == 200 and off.json()["is_active"] is False
    on = await client.patch(f"/api/admin/users/{user['id']}", json={"is_active": True})
    assert on.status_code == 200 and on.json()["is_active"] is True


async def test_patch_user_unknown_role_422(client):
    user = await _create_user(client)
    resp = await client.patch(f"/api/admin/users/{user['id']}", json={"role": "ghost"})
    assert resp.status_code == 422


async def test_patch_user_not_found_404(client):
    resp = await client.patch(f"/api/admin/users/{uuid.uuid4()}", json={"display_name": "x"})
    assert resp.status_code == 404


async def test_patch_user_cannot_deactivate_self(client):
    # ADMIN.user_id 对应 fixture 中的同 id 用户 → 422
    resp = await client.patch(f"/api/admin/users/{ADMIN_UID}", json={"is_active": False})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "cannot deactivate yourself"


async def test_patch_user_no_fields_is_noop(client):
    user = await _create_user(client)
    resp = await client.patch(f"/api/admin/users/{user['id']}", json={})
    assert resp.status_code == 200
    assert resp.json()["username"] == "newbie"


# ---------------- 切片预览端点 ----------------


@pytest_asyncio.fixture()
async def chunk_client():
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    kb_id = uuid.uuid4()
    task_id = uuid.uuid4()
    async with factory() as session:
        session.add(KnowledgeBase(id=kb_id, name="员工手册"))
        await session.flush()
        session.add(
            IngestTask(
                id=task_id, kb_id=kb_id, status="succeeded",
                source_filename="handbook.md", content_hash="h1", object_key="k1",
            )
        )
        session.add(
            IngestTask(
                id=uuid.uuid4(), kb_id=kb_id, status="failed",
                source_filename="broken.pdf", content_hash="h2", object_key="k2",
            )
        )
        await session.flush()
        for i, text in enumerate(["第三段", "第一段", "第二段"]):
            session.add(
                KbChunk(
                    kb_id=kb_id, task_id=task_id, chunk_index=i,
                    content=text, heading_path=f"第一章/第{i + 1}节",
                    content_hash=f"c{i}", embedding=[0.1 * (i + 1)] * 1024,
                )
            )
        await session.commit()

    app = FastAPI()
    from agent_platform.api import admin_users
    from agent_platform.ingest import api as ingest_api

    app.include_router(ingest_api.router)
    app.include_router(admin_users.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_admin] = lambda: ADMIN

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._kb_id, ac._task_id = kb_id, task_id
        yield ac
    await engine.dispose()


async def test_chunks_returns_ordered_with_dim(chunk_client):
    resp = await chunk_client.get(
        f"/api/admin/kbs/{chunk_client._kb_id}/tasks/{chunk_client._task_id}/chunks"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert [c["chunk_index"] for c in body["chunks"]] == [0, 1, 2]
    assert [c["content"] for c in body["chunks"]] == ["第三段", "第一段", "第二段"]
    assert all(c["embedding_dim"] == 1024 for c in body["chunks"])
    assert body["chunks"][0]["heading_path"] == "第一章/第1节"


async def test_chunks_task_kb_mismatch_404(chunk_client):
    resp = await chunk_client.get(f"/api/admin/kbs/{uuid.uuid4()}/tasks/{chunk_client._task_id}/chunks")
    assert resp.status_code == 404


async def test_chunks_unknown_task_404(chunk_client):
    resp = await chunk_client.get(f"/api/admin/kbs/{chunk_client._kb_id}/tasks/{uuid.uuid4()}/chunks")
    assert resp.status_code == 404
