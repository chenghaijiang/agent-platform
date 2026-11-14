"""agent-harness 网关单测（ADR-019）：认证收口 / 透传保真 / SSE 流式 / 降级语义。

网关的核心契约：登录态（require_auth）是唯一门禁；方法/查询串/请求体/响应原样透传；
平台凭证（authorization/cookie）不扩散到 sidecar；上游不可达统一 502。
上游用 httpx.MockTransport 替身，不依赖真实 Node 进程。
"""

import json

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from agent_platform.auth.deps import get_auth_provider, require_auth
from agent_platform.auth.provider import AuthContext, AuthProvider
from agent_platform.harness.api import router as harness_router

USER = AuthContext(user_id="u1", username="tester", role="member", provider="test")

SSE_BODY = (
    ": ping\n\n"
    'event: state\ndata: {"phase":null}\n\n'
    'event: session\ndata: {"type":"user_message","text":"hi"}\n\n'
).encode()


class _SseStream(httpx.AsyncByteStream):
    """MockTransport 替身：content=bytes 构造的响应在 stream=True 下视为已读，
    流式 body 必须显式用 AsyncByteStream 携带（真实 httpcore 连接无此差异）。"""

    def __init__(self, body: bytes):
        self._body = body

    async def __aiter__(self):
        yield self._body


@pytest_asyncio.fixture()
async def client():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["query"] = str(request.url.params)
        seen["auth"] = request.headers.get("authorization")
        seen["cookie"] = request.headers.get("cookie")
        seen["body"] = request.content
        if request.url.path == "/api/events":
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=_SseStream(SSE_BODY)
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/json", "x-harness-node": "test-node"},
            json={"ok": True, "path": request.url.path},
        )

    app = FastAPI()
    app.include_router(harness_router)
    app.dependency_overrides[require_auth] = lambda: USER
    app.state.harness_client = httpx.AsyncClient(
        base_url="http://harness.test", transport=httpx.MockTransport(handler)
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        ac._seen = seen  # 供用例断言上游收到的请求
        yield ac
    await app.state.harness_client.aclose()


# ---------------- 认证门禁 ----------------


class _DenyAllProvider(AuthProvider):
    """认证替身：一律拒绝（验证 401 语义，不建真实依赖链）。"""

    async def verify(self, token: str):
        return None


async def test_missing_token_rejected_401():
    app = FastAPI()
    app.include_router(harness_router)
    app.dependency_overrides[get_auth_provider] = lambda: _DenyAllProvider()
    transport = ASGITransport(app=app)  # require_auth 走真实依赖链（HTTPBearer → verify）
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/harness/api/state")
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


async def test_bearer_forwarded_and_not_leaked_upstream(client):
    resp = await client.get(
        "/api/harness/api/state", headers={"Authorization": "Bearer platform-token"}
    )
    assert resp.status_code == 200
    # 平台凭证不透传 sidecar（上游无认证，凭证不扩散）
    assert client._seen["auth"] is None


# ---------------- 透传保真 ----------------


async def test_method_path_body_forwarded(client):
    payload = {"text": "列出工作区文件"}
    resp = await client.post("/api/harness/api/turn", json=payload)
    assert resp.status_code == 200
    assert client._seen["method"] == "POST"
    assert client._seen["path"] == "/api/turn"
    assert json.loads(client._seen["body"]) == payload
    assert resp.json()["path"] == "/api/turn"


async def test_query_string_forwarded(client):
    resp = await client.get("/api/harness/api/fs/list", params={"path": "/tmp/x"})
    assert resp.status_code == 200
    assert client._seen["query"] == "path=%2Ftmp%2Fx"


async def test_response_headers_passthrough_without_length(client):
    resp = await client.get("/api/harness/api/state")
    # 自定义头透传；content-length 重算为解压后 body 长度（上游值不透传）
    assert resp.headers["x-harness-node"] == "test-node"
    assert resp.headers["content-length"] == str(len(resp.content))


# ---------------- SSE 流式透传 ----------------


async def test_sse_streamed_verbatim(client):
    resp = await client.get("/api/harness/api/events", headers={"Accept": "text/event-stream"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.content == SSE_BODY  # 帧（含注释心跳行）逐字节保真


# ---------------- 降级语义 ----------------


async def test_upstream_unreachable_maps_to_502():
    def failing_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    app = FastAPI()
    app.include_router(harness_router)
    app.dependency_overrides[require_auth] = lambda: USER
    app.state.harness_client = httpx.AsyncClient(
        base_url="http://harness.test", transport=httpx.MockTransport(failing_handler)
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/harness/api/health")
    await app.state.harness_client.aclose()
    assert resp.status_code == 502
    assert "harness 服务不可达" in resp.json()["detail"]
