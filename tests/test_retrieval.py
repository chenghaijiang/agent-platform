"""检索服务单测（T06）：双路来源区分 / ACL 查询层过滤 / 越权 403 / top-k 与排序。

SQLite 无 pgvector <=> 操作符：向量路以注入的假实现替代（合并/排序/ACL 语义
仍全链路覆盖）；pgvector 真实召回由容器端到端验证。
"""

import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import agent_platform.retrieval.api as retrieval_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import (
    Base,
    IngestTask,
    KbChunk,
    KnowledgeBase,
    KnowledgeBaseAcl,
    Role,
)
from agent_platform.model_gateway.gateway import EmbedResult
from agent_platform.retrieval.service import (
    RetrievalPermissionError,
    RetrievalService,
)

ADMIN = AuthContext(user_id="u1", username="admin", role="admin", provider="test")
MEMBER = AuthContext(user_id="u2", username="member", role="member", provider="test")
LEGAL = AuthContext(user_id="u3", username="legal", role="legal", provider="test")

# 测试库 id 固定，便于 ACL 断言
KB_A = uuid.UUID("11111111-1111-1111-1111-111111111111")
KB_B = uuid.UUID("22222222-2222-2222-2222-222222222222")


async def _fake_vector_candidates(session, kb_ids, vector, top_k):
    """替代 pgvector 向量路的假实现：每库取首条 chunk 当作“向量路”结果（固定分 0.9）。"""
    rows = (
        await session.execute(
            select(KbChunk, IngestTask.source_filename, KnowledgeBase.name)
            .join(IngestTask, IngestTask.id == KbChunk.task_id)
            .join(KnowledgeBase, KnowledgeBase.id == KbChunk.kb_id)
            .where(KbChunk.kb_id.in_(kb_ids), KbChunk.chunk_index == 0)
            .limit(top_k)
        )
    ).all()
    return [("vector", c, f, n, 0.9) for c, f, n in rows]


@pytest_asyncio.fixture()
async def env():
    engine = create_async_engine("sqlite+aiosqlite://")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with factory() as session:
        member_role = Role(id=uuid.UUID("aaaaaaa1-0000-0000-0000-000000000000"), name="member")
        legal_role = Role(id=uuid.UUID("aaaaaaa2-0000-0000-0000-000000000000"), name="legal")
        kb_a = KnowledgeBase(id=KB_A, name="员工手册库", classification="internal")
        kb_b = KnowledgeBase(id=KB_B, name="法务合同库", classification="confidential")
        session.add_all([member_role, legal_role, kb_a, kb_b])
        await session.flush()
        # ACL：member 只见 A；legal 只见 B（与 T04 可见性查询同源）
        session.add_all([
            KnowledgeBaseAcl(role_id=member_role.id, kb_id=KB_A),
            KnowledgeBaseAcl(role_id=legal_role.id, kb_id=KB_B),
        ])
        await session.flush()
        task_a = IngestTask(
            kb_id=KB_A, source_filename="handbook.md", content_hash="a" * 64, object_key="kb/a/h.md"
        )
        task_b = IngestTask(
            kb_id=KB_B, source_filename="contract.pdf", content_hash="b" * 64, object_key="kb/b/c.pdf"
        )
        session.add_all([task_a, task_b])
        await session.flush()
        session.add_all([
            KbChunk(
                kb_id=KB_A, task_id=task_a.id, chunk_index=0,
                content="入职流程：第一天报到地点一层前台，携带身份证原件。",
                heading_path="员工手册/入职流程", classification="internal",
                content_hash="c" * 64, embedding=[1.0, 0.0, 0.0],
            ),
            KbChunk(
                kb_id=KB_A, task_id=task_a.id, chunk_index=1,
                content="报销制度：月度报销截止日为每月 25 日，逾期顺延。",
                heading_path="员工手册/报销制度", classification="internal",
                content_hash="d" * 64, embedding=[0.0, 1.0, 0.0],
            ),
            KbChunk(
                kb_id=KB_B, task_id=task_b.id, chunk_index=0,
                content="保密协议条款：违反保密义务的违约金为人民币五百万元。",
                heading_path="第 1 页", classification="confidential",
                content_hash="e" * 64, embedding=[0.0, 0.0, 1.0],
            ),
        ])
        await session.commit()

    service = RetrievalService(_FakeGateway())

    app = FastAPI()
    app.include_router(retrieval_api.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[retrieval_api.get_retrieval_service] = lambda: service

    transport = ASGITransport(app=app)
    # 真实 require_auth 会经 get_auth_provider 访问 app.state.session_factory（无 token → 401 测试需要）
    app.state.session_factory = factory
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, factory, service, app
    await engine.dispose()


class _FakeGateway:
    async def embed(self, texts, *, model=None):
        return EmbedResult(vectors=[[1.0, 0.0, 0.0] for _ in texts], model="fake-embedding", usage={}, latency_ms=0)


def _enable_vector_path(service):
    service._vector_candidates = _fake_vector_candidates  # type: ignore[method-assign]


# ---------------- service 层 ----------------


async def test_both_sources_present_and_distinguishable(env):
    _ac, factory, service, _app = env
    _enable_vector_path(service)
    async with factory() as session:
        # 双词命中：chunk0 两路都中（合并），chunk1 仅关键词路
        result = await service.search(session, MEMBER, "报销 入职")
    sources = {r.sources for r in result.results}
    assert ("keyword",) in sources
    assert ("keyword", "vector") in sources
    assert result.results[0].sources == ("keyword", "vector")  # 两路均中者分高在前
    async with factory() as session:
        # 关键词无命中时，仅剩向量路结果（来源可区分）
        vector_only = await service.search(session, MEMBER, "完全不匹配的词xyz")
    assert {r.sources for r in vector_only.results} == {("vector",)}


async def test_merge_unifies_chunk_hit_by_both_routes(env):
    _ac, factory, service, _app = env
    _enable_vector_path(service)
    async with factory() as session:
        result = await service.search(session, MEMBER, "入职")
    hits = [r for r in result.results if "入职流程" in r.content]
    assert len(hits) == 1
    assert hits[0].sources == ("keyword", "vector")
    assert hits[0].score == 1.0  # max(0.9 vector, 1.0 keyword)


async def test_acl_filters_at_query_layer(env):
    """member 检索 B 库独有内容：B 的 chunk 绝不出现在候选中（SQL WHERE 层过滤）。"""
    _ac, factory, service, _app = env
    _enable_vector_path(service)
    async with factory() as session:
        result = await service.search(session, MEMBER, "保密协议 违约金")
        assert result.visible_kb_count == 1  # 仅 KB_A 参与召回
        assert all(r.kb_id == str(KB_A) for r in result.results)  # B 库 chunk 被查询层排除
        legal_result = await service.search(session, LEGAL, "保密协议 违约金")
        assert len(legal_result.results) == 1
        assert legal_result.results[0].kb_name == "法务合同库"
        assert legal_result.results[0].classification == "confidential"


async def test_result_structure_is_renderable_citation(env):
    _ac, factory, service, _app = env
    _enable_vector_path(service)
    async with factory() as session:
        result = await service.search(session, MEMBER, "入职")
    top = result.results[0]
    assert top.content.startswith("入职流程")
    assert top.document == "handbook.md"
    assert top.kb_name == "员工手册库"
    assert top.classification == "internal"
    assert top.heading_path == "员工手册/入职流程"
    assert isinstance(top.score, float)


async def test_top_k_limits_and_orders_by_score(env):
    _ac, factory, service, _app = env
    _enable_vector_path(service)
    async with factory() as session:
        result = await service.search(session, MEMBER, "入职", top_k=1)
        assert len(result.results) == 1
        scores = [r.score for r in result.results]
        assert scores == sorted(scores, reverse=True)
        full = await service.search(session, MEMBER, "入职 报销")
        assert len(full.results) >= 2
        assert full.results[0].score >= full.results[-1].score


async def test_cross_kb_request_denied_not_silent(env):
    _ac, factory, service, _app = env
    async with factory() as session:
        with pytest.raises(RetrievalPermissionError) as excinfo:
            await service.search(session, MEMBER, "保密协议", kb_ids=[str(KB_B)])
        assert str(KB_B) in excinfo.value.denied_kb_ids


async def test_role_without_any_acl_gets_empty_scope(env):
    _ac, factory, service, _app = env
    async with factory() as session:
        result = await service.search(session, ADMIN, "入职")  # admin 无任何 ACL 授权
        assert result.results == []
        assert result.visible_kb_count == 0


# ---------------- API 层 ----------------


async def test_api_search_returns_citations(env):
    ac, _factory, service, app = env
    _enable_vector_path(service)
    app.dependency_overrides[require_auth] = lambda: MEMBER
    resp = await ac.post("/api/search", json={"query": "报销 入职", "top_k": 3})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["visible_kb_count"] == 1
    assert body["embedding_model"] == "fake-embedding"
    first = body["results"][0]
    for field in ("chunk_id", "kb_id", "kb_name", "document", "content", "classification", "score", "sources"):
        assert field in first
    assert first["classification_label"] == "内部"


async def test_api_search_forbidden_kb_403_with_denied_ids(env):
    ac, _factory, _service, app = env
    app.dependency_overrides[require_auth] = lambda: MEMBER
    resp = await ac.post("/api/search", json={"query": "保密", "kb_ids": [str(KB_B)]})
    assert resp.status_code == 403
    assert resp.json()["detail"]["denied_kb_ids"] == [str(KB_B)]


async def test_api_search_requires_auth(env):
    ac, _factory, _service, _app = env
    resp = await ac.post("/api/search", json={"query": "入职"})
    assert resp.status_code == 401
