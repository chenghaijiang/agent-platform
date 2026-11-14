"""统一工作台渠道层单测（ADR-014~017 一期验收，Q17A：CI 覆盖最脆的面）。

覆盖：
- Profile 列表 / 会话绑定（默认、显式、未知 422）；
- qa_graph 引擎：SSE delta/done + 消息信封落库（user 先行、assistant 收尾）+ 回放游标；
- 非 QA 引擎（harness）不经本端点：send_message 如实 501（前端直连 /api/harness，ADR-019）；
- stream 端点：Last-Event-ID 回放 + 直播新落库消息；
- fallback 链：resolve_model_chain 解析 + stream_chat_with_fallback 首帧前换模/中途如实抛 +
  图内换模审计（workbench.model_fallback）。

模型层 mock（对齐 ADR-012 CI 口径）：FakeRetrieval / FakeStreamGateway / FlakyGateway。
"""

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.requests import Request

import agent_platform.workbench.api as workbench_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.chat.graph import build_chat_graph
from agent_platform.db.models import AuditEvent, Base, ChatMessage
from agent_platform.db.seed import run_seed
from agent_platform.model_gateway.errors import ModelUnavailableError
from agent_platform.model_gateway.resilience import stream_chat_with_fallback
from agent_platform.retrieval.service import RetrievalResult, RetrievedChunk
from agent_platform.workbench import service
from agent_platform.workbench.api import router as workbench_router

MEMBER = AuthContext(user_id="u-member", username="member", role="member", provider="test")
OTHER = AuthContext(user_id="u-other", username="other", role="member", provider="test")

_CITATION = RetrievedChunk(
    chunk_id="c1", kb_id="kb1", kb_name="员工手册库", document="handbook.md",
    heading_path="报销制度", content="月度报销截止日为每月 25 日。", classification="internal",
    score=0.92, sources=("vector",),
)


class FakeRetrieval:
    async def search(self, _session, _auth, _query, *, kb_ids=None, top_k=5):
        return RetrievalResult(
            query="q", results=[_CITATION], latency_ms=1, embedding_model="fake", visible_kb_count=1
        )


class FakeStreamGateway:
    """假流式网关：按预设分片 yield，记录 messages 与 model。"""

    def __init__(self, pieces: list[str]) -> None:
        self.pieces = pieces
        self.calls: list[dict] = []

    async def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None):
        self.calls.append({"messages": messages, "model": model})
        for piece in self.pieces:
            yield piece


class FlakyStreamGateway:
    """故障注入网关：指定模型在首帧前抛 ModelGatewayError，其余正常分片。"""

    def __init__(self, fail_models: set[str | None], pieces: list[str]) -> None:
        self.fail_models = fail_models
        self.pieces = pieces
        self.attempts: list[str | None] = []

    async def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None):
        self.attempts.append(model)
        if model in self.fail_models:
            raise ModelUnavailableError("boom", capability="chat", model=str(model))
        for piece in self.pieces:
            yield piece


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


async def _messages(factory, session_id: uuid.UUID) -> list[ChatMessage]:
    async with factory() as session:
        rows = await session.scalars(
            select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.seq)
        )
        return list(rows.all())


@pytest_asyncio.fixture()
async def env(tmp_path, monkeypatch):
    monkeypatch.setattr("agent_platform.workbench.api.SSE_POLL_INTERVAL_SECONDS", 0.05)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'wb.db'}")
    # SQLite 默认不启用外键；删除会话的级联测试需要显式开启（与 test_kb_api 同模式）

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    await run_seed(factory)  # 内置双 Profile（幂等 seed）

    gateway = FakeStreamGateway(["月度报销", "截止日为每月 25 日。"])
    graph = build_chat_graph(
        session_factory=factory,
        retrieval=FakeRetrieval(),
        gateway=gateway,
        checkpointer=MemorySaver(),
    )

    app = FastAPI()
    app.include_router(workbench_router)
    app.state.session_factory = factory
    app.state.chat_graph = graph

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: MEMBER

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._factory = factory
        ac._gateway = gateway
        yield ac
    await engine.dispose()


# ---------------- Profile 可选与会话绑定 ----------------


async def test_profiles_lists_builtin_two(env):
    profiles = (await env.get("/api/workbench/profiles")).json()
    keys = {p["key"] for p in profiles}
    assert keys == {"knowledge-assistant", "code-engineer"}


async def test_create_session_default_profile(env):
    body = (await env.post("/api/workbench/sessions", json={"title": "咨询"})).json()
    assert body["profile_key"] == "knowledge-assistant"  # 缺省（Q3A）


async def test_create_session_binds_requested_profile(env):
    body = (await env.post("/api/workbench/sessions", json={"profile_key": "code-engineer"})).json()
    assert body["profile_key"] == "code-engineer"


async def test_create_session_unknown_profile_422(env):
    resp = await env.post("/api/workbench/sessions", json={"profile_key": "ghost"})
    assert resp.status_code == 422


async def test_delete_session_cascades_messages(env):
    """删除会话（硬删）：聊天流级联清除，重复删除/访问 404。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    await env.post(
        f"/api/workbench/sessions/{session_id}/messages", json={"question": "报销截止日？"}
    )

    resp = await env.delete(f"/api/workbench/sessions/{session_id}")
    assert resp.status_code == 204
    sessions = (await env.get("/api/workbench/sessions")).json()
    assert str(session_id) not in [s["id"] for s in sessions]
    assert (await env.delete(f"/api/workbench/sessions/{session_id}")).status_code == 404
    assert (await env.get(f"/api/workbench/sessions/{session_id}/messages")).status_code == 404

    async with env._factory() as session:
        msgs = list(
            (
                await session.scalars(
                    select(ChatMessage).where(ChatMessage.session_id == session_id)
                )
            ).all()
        )
        assert msgs == []  # 聊天流级联清除


async def test_delete_session_ownership_404(env):
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    env._transport.app.dependency_overrides[require_auth] = lambda: OTHER
    try:
        resp = await env.delete(f"/api/workbench/sessions/{session_id}")
        assert resp.status_code == 404  # 归属校验不泄露存在性
    finally:
        env._transport.app.dependency_overrides[require_auth] = lambda: MEMBER


# ---------------- qa_graph 引擎：SSE + 信封落库 + 回放 ----------------


async def test_qa_message_streams_and_persists_envelope(env):
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    resp = await env.post(
        f"/api/workbench/sessions/{session_id}/messages", json={"question": "报销截止日？"}
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    frames = _sse_frames(resp.text)
    events = [e for e, _ in frames]
    assert events.count("delta") >= 1
    assert events[-1] == "done"
    done = frames[-1][1]
    assert done["seq"] > 1  # done 帧携带 assistant 消息游标
    assert done["citations"][0]["document"] == "handbook.md"

    # 信封落库：user 先行、assistant 收尾（重启重建聊天流的数据源）
    rows = await _messages(env._factory, session_id)
    assert [m.type for m in rows] == ["text", "text"]
    assert json.loads(rows[0].data)["role"] == "user"
    assistant = json.loads(rows[1].data)
    assert assistant["role"] == "assistant"
    assert assistant["text"] == "月度报销截止日为每月 25 日。"
    assert rows[1].seq == done["seq"]

    # 回放端点：seq 游标
    replay = (await env.get(f"/api/workbench/sessions/{session_id}/messages?after_seq=0")).json()
    assert [m["seq"] for m in replay["messages"]] == [1, 2]
    replay2 = (
        await env.get(f"/api/workbench/sessions/{session_id}/messages?after_seq=1")
    ).json()
    assert [m["seq"] for m in replay2["messages"]] == [2]


async def test_qa_message_ownership_404(env):
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    env._transport.app.dependency_overrides[require_auth] = lambda: OTHER
    resp = await env.post(
        f"/api/workbench/sessions/{session_id}/messages", json={"question": "hi"}
    )
    assert resp.status_code == 404  # 归属校验不泄露存在性


async def test_qa_input_idcard_masked_in_envelope_and_model(env):
    """输入脱敏（ADR-007）：身份证不落聊天流/不进模型上下文，命中即审计；
    SSE 首帧即 user 信封（携带脱敏后文本，前端以此替换乐观气泡）。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    question = "我的身份证号是 11010119900307861X，报销截止日是哪天？"
    resp = await env.post(
        f"/api/workbench/sessions/{session_id}/messages", json={"question": question}
    )
    assert resp.status_code == 200
    frames = _sse_frames(resp.text)
    assert frames[0][0] == "text"
    user_frame_text = frames[0][1]["data"]["text"]
    assert "11010119900307861X" not in user_frame_text
    assert "110101********861X" in user_frame_text
    assert frames[-1][0] == "done"

    # 落库信封：敏感原文不进 chat_messages
    rows = await _messages(env._factory, session_id)
    assert "11010119900307861X" not in json.loads(rows[0].data)["text"]
    # 模型上下文：检索与生成看到的都是脱敏文本
    model_input = json.dumps(env._gateway.calls[0]["messages"], ensure_ascii=False)
    assert "11010119900307861X" not in model_input
    assert "110101********861X" in model_input
    # 审计：guard.input_masked 恰一条（图内 input_guard 对已脱敏文本不重复计数）
    async with env._factory() as session:
        events = list(
            (
                await session.scalars(
                    select(AuditEvent).where(AuditEvent.action == "guard.input_masked")
                )
            ).all()
        )
    assert len(events) == 1
    assert json.loads(events[0].detail)["types"] == ["idcard"]


async def test_qa_model_override_reaches_gateway(env):
    """会话级模型切换（前端模型选择器）：send_message 带 model 时透传到网关；
    不带时保持 None（网关回退 settings 默认）。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    resp = await env.post(
        f"/api/workbench/sessions/{session_id}/messages",
        json={"question": "报销截止日？", "model": "qwen3.8:27b-test"},
    )
    assert resp.status_code == 200
    assert env._gateway.calls[0]["model"] == "qwen3.8:27b-test"

    session2 = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    resp2 = await env.post(
        f"/api/workbench/sessions/{session2}/messages", json={"question": " hi"}
    )
    assert resp2.status_code == 200
    assert env._gateway.calls[1]["model"] is None


# ---------------- 非 QA 引擎：不经本端点（ADR-019） ----------------


async def test_non_qa_engine_send_message_501(env):
    """harness 引擎不经本端点（前端直连 /api/harness）：如实 501，不产生 assistant 信封。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={"profile_key": "code-engineer"})).json()["id"]
    )
    resp = await env.post(
        f"/api/workbench/sessions/{session_id}/messages",
        json={"question": "修复 pricing.py 边界 bug"},
    )
    assert resp.status_code == 501
    # 用户消息本身落库（提问是事实），但无 assistant 回复信封
    rows = await _messages(env._factory, session_id)
    assert [m.type for m in rows] == ["text"]
    assert json.loads(rows[0].data)["role"] == "user"


async def _call_stream(
    client: AsyncClient,
    session_id: uuid.UUID,
    *,
    last_event_id: int = 0,
    header_last_event_id: int | None = None,
    max_frames: int = 4,
) -> list[tuple[int, str, dict]]:
    """直调 stream_session 端点并迭代 body_iterator 收集 SSE 帧。

    会话流无终态 done 帧（客户端断开收尾），经 httpx ASGITransport 会与
    StreamingResponse 的断连监听互相死锁（listen_for_disconnect 等 receive、
    ASGITransport 等 response_complete 互相等待），故绕过传输层直调端点函数。
    """
    headers: list[tuple[bytes, bytes]] = []
    if header_last_event_id is not None:
        headers.append((b"last-event-id", str(header_last_event_id).encode()))
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": headers,
            "query_string": b"",
            "app": client._transport.app,
        }
    )
    response = await workbench_api.stream_session(
        session_id, request, auth=MEMBER, last_event_id=last_event_id
    )
    frames: list[tuple[int, str, dict]] = []
    buf = ""
    iterator = response.body_iterator
    try:
        async for chunk in iterator:
            buf += chunk if isinstance(chunk, str) else chunk.decode()
            while "\n\n" in buf:
                block, buf = buf.split("\n\n", 1)
                frame_id = None
                event = None
                data = None
                for line in block.splitlines():
                    if line.startswith("id: "):
                        frame_id = int(line[4:])
                    elif line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: "):
                        data = json.loads(line[6:])
                if event:
                    frames.append((frame_id, event, data))
                if len(frames) >= max_frames:
                    return frames
    finally:
        await iterator.aclose()
    return frames


async def test_session_stream_replays_and_lives(env):
    """会话 SSE：连接即回放存量消息，尾随直播新落库消息。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    # 先落一对 QA 信封（user + assistant）
    await env.post(f"/api/workbench/sessions/{session_id}/messages", json={"question": "报销截止日？"})
    # 再直落一条消息（模拟其他写入方，不经本进程 POST 通道）
    async with env._factory() as session:
        await service.append_message(
            session, session_id, "text", {"role": "assistant", "text": "补充说明"}
        )
        await session.commit()

    frames = await _call_stream(env, session_id, max_frames=3)
    # 回放序：user 文本 / assistant 回答 / 追加消息
    assert [fid for fid, _, _ in frames] == [1, 2, 3]
    assert [e for _, e, _ in frames] == ["text", "text", "text"]
    assert frames[0][2]["data"]["role"] == "user"
    assert frames[1][2]["data"]["role"] == "assistant"
    assert frames[2][2]["data"]["text"] == "补充说明"


async def test_session_stream_resume_from_last_event_id(env):
    """断线续传：Last-Event-ID 之后只发增量。"""
    session_id = uuid.UUID(
        (await env.post("/api/workbench/sessions", json={})).json()["id"]
    )
    # 先落两条消息
    await env.post(f"/api/workbench/sessions/{session_id}/messages", json={"question": "报销截止日？"})
    rows = await _messages(env._factory, session_id)
    assert len(rows) == 2
    first_seq = rows[0].seq

    frames = await _call_stream(env, session_id, header_last_event_id=first_seq, max_frames=1)
    # 只回放 seq > first_seq 的 assistant 消息（不带 user 帧）
    assert len(frames) == 1
    frame_id, event, data = frames[0]
    assert frame_id == first_seq + 1
    assert event == "text"
    assert data["data"]["role"] == "assistant"


# ---------------- fallback 链（Q14A / ADR-016 决策 2） ----------------


async def test_resolve_model_chain_variants(env):
    from agent_platform.db.models import AgentProfile

    assert service.resolve_model_chain(None) == [None]
    profile = AgentProfile(key="x", display_name="x", model_policy="not-json")
    assert service.resolve_model_chain(profile) == [None]  # 非法 JSON 诚实回落全局
    profile = AgentProfile(
        key="y", display_name="y",
        model_policy=json.dumps({"primary": "m1", "fallbacks": ["m2", "m2", "m3"]}),
    )
    assert service.resolve_model_chain(profile) == ["m1", "m2", "m3"]  # 去重保序
    profile = AgentProfile(key="z", display_name="z", model_policy=json.dumps({"fallbacks": ["m2"]}))
    assert service.resolve_model_chain(profile) == [None, "m2"]  # primary 缺省 → 全局先试


async def test_stream_fallback_swaps_model_before_first_frame():
    """首帧前失败：限次重试耗尽 → 换下一模成功；on_fallback 回调被调用。"""
    gateway = FlakyStreamGateway(fail_models={None}, pieces=["成功回答"])
    swapped: list[tuple] = []

    async def on_fallback(from_model, to_model, error):
        swapped.append((from_model, to_model, error))

    deltas = [
        d
        async for d in stream_chat_with_fallback(
            gateway, [{"role": "user", "content": "q"}], [None, "m2"],
            max_attempts_per_model=2, on_fallback=on_fallback,
        )
    ]
    assert deltas == ["成功回答"]
    assert gateway.attempts == [None, None, "m2"]  # 全局位重试 2 次后换 m2
    assert len(swapped) == 1
    assert swapped[0][0] is None and swapped[0][1] == "m2"


async def test_stream_fallback_raises_midstream_failure():
    """中途失败：半截流不可换模回收，如实上抛。"""

    class MidStreamFailGateway:
        async def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None):
            yield "半截"
            raise ModelUnavailableError("boom", capability="chat", model=str(model))

    got: list[str] = []
    with pytest.raises(ModelUnavailableError):
        async for d in stream_chat_with_fallback(
            MidStreamFailGateway(), [{"role": "user", "content": "q"}], ["m1", "m2"]
        ):
            got.append(d)
    assert got == ["半截"]


async def test_stream_fallback_chain_exhausted_raises_last_error():
    gateway = FlakyStreamGateway(fail_models={"m1", "m2"}, pieces=["不应到达"])
    with pytest.raises(ModelUnavailableError):
        async for _d in stream_chat_with_fallback(
            gateway, [{"role": "user", "content": "q"}], ["m1", "m2"], max_attempts_per_model=1
        ):
            pass
    assert gateway.attempts == ["m1", "m2"]


async def test_graph_fallback_writes_audit(tmp_path):
    """图内换模审计：全局位失败 → fallback 模型成功 → audit_events 落 workbench.model_fallback。"""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    gateway = FlakyStreamGateway(fail_models={None}, pieces=["备胎模型回答"])
    graph = build_chat_graph(
        session_factory=factory, retrieval=FakeRetrieval(), gateway=gateway, checkpointer=MemorySaver()
    )
    queue: asyncio.Queue = asyncio.Queue()
    final = await graph.ainvoke(
        {"question": "报销截止日？", "messages": []},
        config={
            "configurable": {
                "thread_id": "t-fallback",
                "auth_ctx": MEMBER,
                "token_queue": queue,
                "model_chain": [None, "m2"],  # 全局位失败 → m2
                "profile_key": "knowledge-assistant",
            }
        },
    )
    assert final["answer"] == "备胎模型回答"
    async with factory() as session:
        rows = (await session.scalars(select(AuditEvent))).all()
    fallback_events = [r for r in rows if r.action == "workbench.model_fallback"]
    assert len(fallback_events) == 1
    detail = json.loads(fallback_events[0].detail)
    assert detail["from_model"] is None and detail["to_model"] == "m2"
    assert fallback_events[0].object_id == "knowledge-assistant"
    await engine.dispose()
