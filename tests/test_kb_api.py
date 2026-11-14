"""知识库元数据与 ACL API 单测（T04）：CRUD / 授权收回 / 可见性一致性 / 级联删除。"""

import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.api import admin_kbs
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import Base, KnowledgeBaseAcl, Role

ADMIN = AuthContext(user_id="u1", username="tester", role="admin", provider="test")


@pytest_asyncio.fixture()
async def client():
    engine = create_async_engine("sqlite+aiosqlite://")
    # SQLite 默认不启用外键；级联删除测试需要显式开启
    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        session.add(Role(name="member", description="普通员工"))
        session.add(Role(name="legal", description="法务"))
        await session.commit()

    app = FastAPI()
    app.include_router(admin_kbs.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_admin] = lambda: ADMIN

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._factory = factory  # 供级联断言直接查表
        yield ac
    await engine.dispose()


async def _create_kb(client: AsyncClient, name: str = "员工手册", classification: str = "internal") -> dict:
    resp = await client.post(
        "/api/admin/kbs",
        json={"name": name, "classification": classification, "description": "全司通用制度"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------- CRUD ----------------


async def test_create_kb_returns_metadata_with_defaults(client):
    kb = await _create_kb(client)
    assert kb["name"] == "员工手册"
    assert kb["classification"] == "internal"
    assert kb["classification_label"] == "内部"
    assert kb["index_version"] == "v1"  # 索引版本预留字段


async def test_create_kb_duplicate_name_409(client):
    await _create_kb(client, name="报销制度")
    resp = await client.post("/api/admin/kbs", json={"name": "报销制度", "classification": "public"})
    assert resp.status_code == 409


async def test_create_kb_invalid_classification_422(client):
    resp = await client.post("/api/admin/kbs", json={"name": "X", "classification": "top-secret"})
    assert resp.status_code == 422


async def test_get_kb_404(client):
    resp = await client.get("/api/admin/kbs/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


async def test_patch_kb_updates_classification(client):
    kb = await _create_kb(client, name="并购资料", classification="internal")
    resp = await client.patch(
        f"/api/admin/kbs/{kb['id']}", json={"classification": "confidential", "description": "仅并购组"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["classification"] == "confidential"
    assert body["classification_label"] == "机密"
    assert body["description"] == "仅并购组"


# ---------------- ACL 授权 / 收回 / 可见性严格一致 ----------------


async def test_grant_and_visibility_query_strict_acl(client):
    kb = await _create_kb(client, name="合同模板")
    resp = await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "member"})
    assert resp.status_code == 201
    assert resp.json()["permission"] == "read"

    visible = (await client.get("/api/admin/roles/member/kbs")).json()
    assert [item["name"] for item in visible] == ["合同模板"]
    # 未授权角色不可见：与 ACL 表严格一致
    legal_visible = (await client.get("/api/admin/roles/legal/kbs")).json()
    assert legal_visible == []


async def test_grant_acl_duplicate_409(client):
    kb = await _create_kb(client, name="制度库")
    await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "member"})
    resp = await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "member"})
    assert resp.status_code == 409


async def test_grant_acl_unknown_role_422(client):
    kb = await _create_kb(client, name="产品白皮书")
    resp = await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "ghost"})
    assert resp.status_code == 422


async def test_revoke_acl_makes_kb_invisible(client):
    kb = await _create_kb(client, name="财报数据")
    await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "legal"})

    resp = await client.delete(f"/api/admin/kbs/{kb['id']}/acls/legal")
    assert resp.status_code == 204
    assert (await client.get("/api/admin/roles/legal/kbs")).json() == []

    # 收回未授权的 ACL → 404
    resp = await client.delete(f"/api/admin/kbs/{kb['id']}/acls/legal")
    assert resp.status_code == 404


async def test_list_kb_acls(client):
    kb = await _create_kb(client, name="多角色库")
    await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "member"})
    await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "legal"})
    acls = (await client.get(f"/api/admin/kbs/{kb['id']}/acls")).json()
    assert [a["role"] for a in acls] == ["legal", "member"]


# ---------------- 级联删除 ----------------


async def test_delete_kb_cascades_acl(client):
    kb = await _create_kb(client, name="将删除的库")
    await client.post(f"/api/admin/kbs/{kb['id']}/acls", json={"role": "member"})

    resp = await client.delete(f"/api/admin/kbs/{kb['id']}")
    assert resp.status_code == 204
    assert (await client.get("/api/admin/kbs")).json() == []

    # 级联：ACL 表中该 kb 的授权也被清理（FK ondelete=CASCADE）
    from sqlalchemy import func, select

    factory = client._factory
    async with factory() as session:
        count = await session.scalar(select(func.count()).select_from(KnowledgeBaseAcl))
    assert count == 0
