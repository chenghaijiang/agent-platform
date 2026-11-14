"""Prompt 版本管理单测（T10）：版本号单调 / 发布封版 / 当前版本唯一 / 链路读发布版。"""


import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import agent_platform.prompts.api as prompts_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat.graph import SYSTEM_WITH_EVIDENCE, build_chat_graph
from agent_platform.db.models import Base, PromptVersion
from agent_platform.prompts import service
from agent_platform.prompts.service import PromptPublishError

ADMIN = AuthContext(user_id="u-admin", username="admin", role="admin", provider="test")
MEMBER = AuthContext(user_id="u-member", username="member", role="member", provider="test")


@pytest_asyncio.fixture()
async def factory():
    engine = create_async_engine("sqlite+aiosqlite://")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


# ---------------- 版本语义（service 层） ----------------


async def test_versions_monotonically_increase(factory):
    async with factory() as session:
        v1 = await service.create_draft(session, template_key="chat_qa", template="t1")
        v2 = await service.create_draft(session, template_key="chat_qa", template="t2")
        v3 = await service.create_draft(session, template_key="chat_qa", template="t3")
        assert [v1.version, v2.version, v3.version] == [1, 2, 3]  # 单调递增，含草稿与归档


async def test_publish_then_current(factory):
    async with factory() as session:
        draft = await service.create_draft(session, template_key="chat_qa", template="V1 模板")
        published = await service.publish(session, draft.id)
        assert published.status == "published" and published.published_at is not None
        current = await service.get_current(session, "chat_qa")
        assert current is not None and current.version == published.version


async def test_republish_archives_previous_current(factory):
    async with factory() as session:
        v1 = await service.publish(
            session, (await service.create_draft(session, template_key="chat_qa", template="V1")).id
        )
        v2 = await service.publish(
            session, (await service.create_draft(session, template_key="chat_qa", template="V2")).id
        )
        current = await service.get_current(session, "chat_qa")
        assert current.version == v2.version  # 当前生效版本唯一
        await session.refresh(v1)
        assert v1.status == "archived"  # 旧版本归档而非删除（历史可追溯）


async def test_republish_published_version_rejected(factory):
    async with factory() as session:
        draft = await service.create_draft(session, template_key="chat_qa", template="V1")
        published = await service.publish(session, draft.id)
        with pytest.raises(PromptPublishError):
            await service.publish(session, published.id)  # 同版本号不可重复发布


async def test_archived_version_cannot_be_republished(factory):
    async with factory() as session:
        v1 = await service.publish(
            session, (await service.create_draft(session, template_key="chat_qa", template="V1")).id
        )
        await service.publish(
            session, (await service.create_draft(session, template_key="chat_qa", template="V2")).id
        )
        with pytest.raises(PromptPublishError):
            await service.publish(session, v1.id)  # 历史版本封存，不可复活/篡改


# ---------------- API 层 ----------------


@pytest_asyncio.fixture()
async def app_env(factory):
    app = FastAPI()
    app.include_router(prompts_api.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: ADMIN
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac, factory


async def test_prompt_api_flow(app_env):
    ac, _factory = app_env
    created = await ac.post(
        "/api/admin/prompts",
        json={"template_key": "chat_qa", "template": "评测版模板 {context}", "change_note": "ut"},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["version"] == 1 and body["status"] == "draft"

    published = await ac.post(f"/api/admin/prompts/{body['id']}/publish")
    assert published.status_code == 200 and published.json()["status"] == "published"

    current = await ac.get("/api/admin/prompts/current/chat_qa")
    assert current.status_code == 200 and current.json()["template"] == "评测版模板 {context}"

    republish = await ac.post(f"/api/admin/prompts/{body['id']}/publish")
    assert republish.status_code == 409  # 重复发布 → 明确冲突


async def test_prompt_api_requires_admin(factory):
    app = FastAPI()
    app.include_router(prompts_api.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: MEMBER  # member → require_admin 403
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/admin/prompts")
        assert resp.status_code == 403


# ---------------- 链路读发布版 ----------------


class FakeRetrieval:
    async def search(self, _session, _auth, _query, *, kb_ids=None, top_k=5):
        from agent_platform.retrieval.service import RetrievalResult, RetrievedChunk

        return RetrievalResult(
            query="q",
            results=[
                RetrievedChunk(
                    chunk_id="c1", kb_id="kb1", kb_name="库", document="d.md",
                    heading_path="h", content="引用内容", classification="internal",
                    score=0.9, sources=("vector",),
                )
            ],
            latency_ms=1,
            embedding_model="fake",
            visible_kb_count=1,
        )


class FakeStreamGateway:
    def __init__(self, pieces):
        self.pieces = pieces
        self.calls = []

    async def stream_chat(self, messages, **kwargs):
        self.calls.append(messages)
        for piece in self.pieces:
            yield piece


def _make_graph(factory, gateway):
    return build_chat_graph(
        session_factory=factory, retrieval=FakeRetrieval(), gateway=gateway, checkpointer=MemorySaver()
    )


async def test_graph_uses_published_prompt_over_hardcoded(factory):
    gateway = FakeStreamGateway(["好"])
    graph = _make_graph(factory, gateway)
    await graph.ainvoke(
        {"question": "问", "messages": [HumanMessage(content="问")]},
        config={
            "configurable": {
                "thread_id": "p1",
                "auth_ctx": MEMBER,
                "system_prompt": "【发布版 v2】\n{context}",  # API 层注入的发布版模板
            }
        },
    )
    system = gateway.calls[0][0]["content"]
    assert system.startswith("【发布版 v2】")  # 发布版优先于代码内硬编码
    assert "引用内容" in system  # {context} 可变区已填充


async def test_graph_falls_back_to_default_without_published_prompt(factory):
    gateway = FakeStreamGateway(["好"])
    graph = _make_graph(factory, gateway)
    await graph.ainvoke(
        {"question": "问", "messages": [HumanMessage(content="问")]},
        config={"configurable": {"thread_id": "p2", "auth_ctx": MEMBER}},  # 无 system_prompt
    )
    assert gateway.calls[0][0]["content"].startswith(SYSTEM_WITH_EVIDENCE)


async def test_prompt_template_survives_json_roundtrip(factory):
    async with factory() as session:
        rows = await session.scalars(select(PromptVersion))
        assert list(rows.all()) == []  # 空表起步
