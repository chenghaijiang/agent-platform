"""会话与问答单测（T07）：图执行 / 多轮上下文累积 / 无依据兜底 / SSE 帧 / Run 记录。

Checkpointer 用 MemorySaver（跨轮与 thread 隔离语义同 PG Saver）；
Postgres Checkpointer 的容器重启恢复由端到端验证（验收硬指标）。
"""

import json
import uuid

import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import agent_platform.chat.api as chat_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat.graph import NO_EVIDENCE_ANSWER, build_chat_graph
from agent_platform.db.models import Base
from agent_platform.retrieval.service import RetrievalResult, RetrievedChunk

MEMBER = AuthContext(user_id="u-member", username="member", role="member", provider="test")
OTHER = AuthContext(user_id="u-other", username="other", role="member", provider="test")

_CITATION = RetrievedChunk(
    chunk_id="c1", kb_id="kb1", kb_name="员工手册库", document="handbook.md",
    heading_path="报销制度", content="月度报销截止日为每月 25 日。", classification="internal",
    score=0.92, sources=("vector",),
)


class FakeRetrieval:
    """假检索：可配置本轮引用数量。"""

    def __init__(self, hits: list[RetrievedChunk]) -> None:
        self.hits = hits

    async def search(self, _session, _auth, _query, *, kb_ids=None, top_k=5):
        return RetrievalResult(
            query="q", results=self.hits[:top_k], latency_ms=1, embedding_model="fake", visible_kb_count=1
        )


class FakeStreamGateway:
    """假流式网关：按预设分片 yield，记录每次收到的 messages。"""

    def __init__(self, pieces: list[str]) -> None:
        self.pieces = pieces
        self.calls: list[list[dict]] = []

    async def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None):
        self.calls.append(messages)
        for piece in self.pieces:
            yield piece


class _NullSession:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *exc):
        return False


def _make_graph(retrieval, gateway, factory, *, checkpointer=None):
    return build_chat_graph(
        session_factory=factory,
        retrieval=retrieval,
        gateway=gateway,
        checkpointer=checkpointer or MemorySaver(),
    )


@pytest_asyncio.fixture()
async def sqlite_factory():
    """独立内存库：图层测试的审计写入落真实表（T08 后图节点会写审计）。"""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


def _sse_frames(text: str) -> list[tuple[str, dict]]:
    frames = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        event = None
        data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if event:
            frames.append((event, data))
    return frames


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

    gateway = FakeStreamGateway(["月度报销", "截止日为每月 25 日。"])
    graph = _make_graph(FakeRetrieval([_CITATION]), gateway, factory)

    app = FastAPI()
    app.include_router(chat_api.router)
    app.state.session_factory = factory
    app.state.chat_graph = graph

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: MEMBER

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, factory, gateway, graph
    await engine.dispose()


# ---------------- 图层 ----------------


async def test_graph_streams_deltas_and_accumulates_answer(sqlite_factory):
    import asyncio

    queue: asyncio.Queue = asyncio.Queue()
    graph = _make_graph(
        FakeRetrieval([_CITATION]),
        FakeStreamGateway(["月度报销", "截止日为每月 25 日。"]),
        sqlite_factory,
    )
    final = await graph.ainvoke(
        {"question": "报销截止日？", "messages": []},
        config={"configurable": {"thread_id": "t1", "auth_ctx": MEMBER, "token_queue": queue}},
    )
    deltas = []
    while True:
        item = await queue.get()
        if item is None:
            break
        deltas.append(item)
    assert "".join(deltas) == "月度报销截止日为每月 25 日。"  # T08 后流式粒度由 output_guard 切片
    assert final["answer"] == "月度报销截止日为每月 25 日。"
    assert final["citations"][0]["chunk_id"] == "c1"


async def test_graph_no_evidence_fallback_skips_llm(sqlite_factory):
    import asyncio

    gateway = FakeStreamGateway(["不应被调用"])
    queue: asyncio.Queue = asyncio.Queue()
    graph = _make_graph(FakeRetrieval([]), gateway, sqlite_factory)
    final = await graph.ainvoke(
        {"question": "无关问题", "messages": []},
        config={"configurable": {"thread_id": "t2", "auth_ctx": MEMBER, "token_queue": queue}},
    )
    assert final["answer"] == NO_EVIDENCE_ANSWER
    assert gateway.calls == []  # 0 条引用 → 不调用模型，不编造
    chunks = []
    while True:
        item = await queue.get()
        if item is None:
            break
        chunks.append(item)
    assert "".join(chunks) == NO_EVIDENCE_ANSWER


async def test_multi_turn_context_accumulates_across_invocations(sqlite_factory):
    gateway = FakeStreamGateway(["好的。"])
    graph = _make_graph(FakeRetrieval([_CITATION]), gateway, sqlite_factory)
    config = {"configurable": {"thread_id": "t-multi", "auth_ctx": MEMBER}}
    await graph.ainvoke(
        {"question": "报销截止日？", "messages": [HumanMessage(content="报销截止日？")]}, config
    )
    await graph.ainvoke(
        {"question": "那逾期怎么办？", "messages": [HumanMessage(content="那逾期怎么办？")]}, config
    )
    # 第二轮 generate 收到的输入包含第一轮的 user+assistant 消息（上下文连贯）
    second_call = gateway.calls[1]
    roles = [m["role"] for m in second_call]
    contents = [m["content"] for m in second_call]
    assert roles == ["system", "user", "assistant", "user"]
    assert "报销截止日？" in contents
    assert "好的。" in contents  # 第一轮回答（assistant）在历史中


async def test_thread_isolation(sqlite_factory):
    gateway = FakeStreamGateway(["答"])
    graph = _make_graph(FakeRetrieval([_CITATION]), gateway, sqlite_factory)
    thread_a = {"configurable": {"thread_id": "a", "auth_ctx": MEMBER}}
    thread_b = {"configurable": {"thread_id": "b", "auth_ctx": MEMBER}}
    await graph.ainvoke({"question": "A 线程问题", "messages": []}, thread_a)
    await graph.ainvoke({"question": "B 线程问题", "messages": []}, thread_b)
    second_call = gateway.calls[1]
    assert all("A 线程问题" not in m["content"] for m in second_call if m["role"] != "system")


# ---------------- API 层 ----------------


async def test_create_session_returns_thread_mapping(env):
    ac, _factory, _gateway, _graph = env
    resp = await ac.post("/api/sessions", json={"title": "报销咨询"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "报销咨询"
    assert body["thread_id"] and body["id"] != body["thread_id"]  # 两套 ID（ADR-008 映射）


async def test_chat_sse_streams_and_done_frame_carries_citations(env):
    ac, _factory, _gateway, _graph = env
    session_id = (await ac.post("/api/sessions", json={"title": None})).json()["id"]
    resp = await ac.post(f"/api/sessions/{session_id}/chat", json={"question": "报销截止日是什么时候？"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    frames = _sse_frames(resp.text)
    events = [e for e, _ in frames]
    assert events.count("delta") >= 1  # T08 后 delta 粒度由 output_guard 切片决定（短回答可能单帧）
    assert events[-1] == "done"
    done_payload = frames[-1][1]
    assert done_payload["run_id"]
    assert done_payload["citations"][0]["document"] == "handbook.md"
    joined = "".join(d["text"] for e, d in frames if e == "delta")
    assert joined == "月度报销截止日为每月 25 日。"


async def test_run_record_completed_with_citations(env):
    ac, factory, _gateway, _graph = env
    session_id = (await ac.post("/api/sessions", json={"title": "记录"})).json()["id"]
    await ac.post(f"/api/sessions/{session_id}/chat", json={"question": "报销截止日？"})
    runs = (await ac.get(f"/api/sessions/{session_id}/runs")).json()
    assert len(runs) == 1
    run = runs[0]
    assert run["status"] == "completed"
    assert run["question"] == "报销截止日？"
    assert run["answer"] == "月度报销截止日为每月 25 日。"
    assert run["citations"][0]["kb_name"] == "员工手册库"


async def test_session_ownership_404(env):
    ac, _factory, _gateway, _graph = env
    session_id = (await ac.post("/api/sessions", json={"title": "我的会话"})).json()["id"]
    # 切换为其它用户的凭证访问他人会话：404 不泄露存在性
    ac._transport.app.dependency_overrides[require_auth] = lambda: OTHER
    resp = await ac.post(f"/api/sessions/{session_id}/chat", json={"question": "hi"})
    assert resp.status_code == 404
    resp = await ac.get(f"/api/sessions/{session_id}/runs")
    assert resp.status_code == 404
