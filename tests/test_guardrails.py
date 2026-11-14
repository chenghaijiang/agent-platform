"""治理中间件与审计单测（T08）：脱敏策略 / 输入输出处置 / 审计事件 / 查询 API。

沿用 test_chat 的假实现模式（MemorySaver + 假检索/假网关）；
审计写入与查询走真实 SQLite 表。
"""

import asyncio
import json

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import agent_platform.api.admin_audit as admin_audit_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat.graph import build_chat_graph
from agent_platform.db.models import AuditEvent, Base
from agent_platform.guardrails.masking import screen_text
from agent_platform.retrieval.service import (
    RetrievalPermissionError,
    RetrievalResult,
    RetrievedChunk,
)

ADMIN = AuthContext(user_id="u-admin", username="admin", role="admin", provider="test")
MEMBER = AuthContext(user_id="u-member", username="member", role="member", provider="test")

_CITATION = RetrievedChunk(
    chunk_id="c1", kb_id="kb1", kb_name="员工手册库", document="handbook.md",
    heading_path="报销制度", content="月度报销截止日为每月 25 日。", classification="internal",
    score=0.92, sources=("vector",),
)


class RecordingRetrieval:
    """假检索：捕获每次收到的 query（验证输入脱敏发生在检索之前）。"""

    def __init__(self) -> None:
        self.queries: list[str] = []

    async def search(self, _session, _auth, query, *, kb_ids=None, top_k=5):
        self.queries.append(query)
        return RetrievalResult(query=query, results=[_CITATION], latency_ms=1, embedding_model="fake", visible_kb_count=1)


class FakeStreamGateway:
    def __init__(self, pieces: list[str]) -> None:
        self.pieces = pieces
        self.calls: list[list[dict]] = []

    async def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None):
        self.calls.append(messages)
        for piece in self.pieces:
            yield piece


def _make_graph(retrieval, gateway, factory):
    return build_chat_graph(
        session_factory=factory, retrieval=retrieval, gateway=gateway, checkpointer=MemorySaver()
    )


async def _run_turn(graph, *, question, thread, auth=MEMBER, queue=None):
    """与真实链路一致：本轮提问以 HumanMessage 进 messages（由 API 层构造）。"""
    configurable = {"thread_id": thread, "auth_ctx": auth}
    if queue is not None:
        configurable["token_queue"] = queue
    return await graph.ainvoke(
        {"question": question, "messages": [HumanMessage(content=question)]},
        config={"configurable": configurable},
    )


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

    retrieval = RecordingRetrieval()
    gateway = FakeStreamGateway(["报销流程请联系 HR。"])
    graph = _make_graph(retrieval, gateway, factory)

    app = FastAPI()
    app.include_router(admin_audit_api.router)
    app.state.session_factory = factory

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: ADMIN

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, factory, retrieval, gateway, graph
    await engine.dispose()


async def _all_events(factory) -> list[AuditEvent]:
    async with factory() as session:
        rows = await session.scalars(select(AuditEvent).order_by(AuditEvent.created_at))
        return list(rows.all())


# ---------------- 脱敏策略（纯函数） ----------------


def test_screen_text_masks_phone():
    result = screen_text("有事拨打 13812345678 找我")
    assert result.text == "有事拨打 138****5678 找我"
    assert result.disposition == "masked"
    assert result.findings[0].type == "phone" and result.findings[0].count == 1


def test_screen_text_masks_idcard():
    result = screen_text("身份证号 11010119900307757X 请核对")
    assert result.text == "身份证号 110101********757X 请核对"
    assert result.findings[0].type == "idcard"


def test_screen_text_passthrough_clean_text():
    clean = "普通文本没有敏感信息，长订单号 20260101000101 不误伤"
    result = screen_text(clean)
    assert result.text == clean  # 无命中原文透传
    assert result.disposition == "passthrough"
    assert result.findings == []


# ---------------- 图层：输入/输出处置 ----------------


async def test_input_guard_masks_question_before_retrieve(env):
    _ac, _factory, retrieval, _gateway, graph = env
    await _run_turn(graph, question="帮我查员工 13812345678 的报销记录", thread="g1")
    # 进入检索的已是脱敏后文本（敏感信息不进检索与模型上下文）
    assert retrieval.queries == ["帮我查员工 138****5678 的报销记录"]


async def test_input_guard_masks_history_and_checkpoint(env):
    """历史中的敏感原文不进模型上下文、不落 checkpoint（同 ID 覆盖语义）。"""
    _ac, factory, retrieval, gateway, _graph = env
    graph = _make_graph(retrieval, gateway, factory)
    await _run_turn(graph, question="查 13812345678 的报销", thread="g-hist")
    await _run_turn(graph, question="那怎么查询进度？", thread="g-hist")
    # 第二轮 generate 收到的模型输入：历史 + 本轮均无原手机号，只有脱敏形态
    joined = json.dumps(gateway.calls[1], ensure_ascii=False)
    assert "13812345678" not in joined
    assert "138****5678" in joined
    # checkpoint 持久化的历史同样无原文
    tup = await graph.checkpointer.aget_tuple({"configurable": {"thread_id": "g-hist"}})
    persisted = json.dumps([m.content for m in tup.checkpoint["channel_values"]["messages"]], ensure_ascii=False)
    assert "13812345678" not in persisted


async def test_output_guard_masks_sensitive_answer(env):
    _ac, factory, retrieval, _gateway, _graph = env
    graph2 = _make_graph(retrieval, FakeStreamGateway(["该员工手机号是 13812345678。"]), factory)
    queue: asyncio.Queue = asyncio.Queue()
    final = await _run_turn(graph2, question="报销截止日？", thread="g2", queue=queue)
    assert final["answer"] == "该员工手机号是 138****5678。"
    chunks = []
    while True:
        item = await queue.get()
        if item is None:
            break
        chunks.append(item)
    assert "".join(chunks) == "该员工手机号是 138****5678。"  # SSE 流也只见脱敏后文本


# ---------------- 审计事件 ----------------


async def test_chat_ask_audit_recorded_with_kb_scope(env):
    _ac, factory, _retrieval, _gateway, graph = env
    await _run_turn(graph, question="报销截止日？", thread="g3")
    ask = [e for e in await _all_events(factory) if e.action == "chat.ask"]
    assert len(ask) == 1
    assert ask[0].username == "member" and ask[0].outcome == "allowed"
    detail = json.loads(ask[0].detail)
    assert detail["kb_ids"] == ["kb1"] and detail["citation_count"] == 1


async def test_input_masked_audit_recorded(env):
    _ac, factory, _retrieval, _gateway, graph = env
    await _run_turn(graph, question="查 13812345678 的报销", thread="g4")
    masked = [e for e in await _all_events(factory) if e.action == "guard.input_masked"]
    assert len(masked) == 1
    assert masked[0].outcome == "filtered"
    assert set(json.loads(masked[0].detail)["types"]) == {"phone"}  # question 与本轮 HumanMessage 各命中一次


async def test_clean_question_produces_no_guard_events(env):
    _ac, factory, _retrieval, _gateway, graph = env
    await _run_turn(graph, question="报销截止日？", thread="g5")
    actions = [e.action for e in await _all_events(factory)]
    assert actions == ["chat.ask"]  # 无敏感命中 → 只有业务动作，无 guard.* 事件


async def test_denied_retrieval_recorded_as_blocked():
    """越权检索（T06 拒绝行为）在审计中产生 blocked 拦截记录。"""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from agent_platform.retrieval.service import RetrievalService

    class _FakeGateway:
        async def embed(self, texts):
            raise AssertionError("越权拒绝不应触发向量化")

    service = RetrievalService(_FakeGateway())
    with pytest.raises(RetrievalPermissionError):
        async with factory() as session:
            await service.search(session, MEMBER, "q", kb_ids=["00000000-0000-0000-0000-000000000000"])

    async with factory() as session:
        rows = await session.scalars(select(AuditEvent).where(AuditEvent.action == "retrieval.denied"))
        denied = list(rows.all())
    assert len(denied) == 1
    assert denied[0].outcome == "blocked"
    assert denied[0].detail and "00000000" in denied[0].detail
    await engine.dispose()


# ---------------- 审计查询 API ----------------


async def test_audit_api_filters_by_user_action_outcome(env):
    ac, _factory, _retrieval, _gateway, graph = env
    await _run_turn(graph, question="报销截止日？", thread="g6")
    await _run_turn(graph, question="查 13812345678 的报销", thread="g7")

    resp = await ac.get("/api/admin/audit-events", params={"user_id": "u-member"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 3  # chat.ask + chat.ask + guard.input_masked
    assert all(e["user_id"] == "u-member" for e in body)

    resp = await ac.get("/api/admin/audit-events", params={"action": "chat.ask"})
    assert {e["action"] for e in resp.json()} == {"chat.ask"}

    resp = await ac.get("/api/admin/audit-events", params={"outcome": "filtered"})
    assert {e["outcome"] for e in resp.json()} == {"filtered"}


async def test_audit_api_requires_admin(env):
    ac, _factory, _retrieval, _gateway, _graph = env
    # 只切换认证身份为 member：require_admin 真实现按角色拒绝（403）
    ac._transport.app.dependency_overrides[require_auth] = lambda: MEMBER
    resp = await ac.get("/api/admin/audit-events")
    assert resp.status_code == 403
