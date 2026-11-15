"""模型网关单测（T03 验收：映射表配置驱动零代码切换 / 错误类型明确 / 统一结果）。"""

from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from agent_platform.core.config import settings
from agent_platform.model_gateway.api import proxy_router
from agent_platform.model_gateway.errors import (
    ModelAuthError,
    ModelBadRequestError,
    ModelConfigError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelUnavailableError,
)
from agent_platform.model_gateway.gateway import (
    CAPABILITY_CHAT,
    ModelGateway,
    resolve_model_for,
)


def _gateway() -> ModelGateway:
    return ModelGateway(base_url="http://fake-openai.test/v1", api_key="test-key")


def _chat_response(model: str) -> SimpleNamespace:
    """模拟 openai chat completion 响应（只依赖网关实际访问的字段）。"""
    return SimpleNamespace(
        model=model,
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(role="assistant", content=f"echo:{model}"),
                finish_reason="stop",
            )
        ],
        usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7, total_tokens=18),
    )


def _embed_response(model: str, dim: int = 4) -> SimpleNamespace:
    return SimpleNamespace(
        model=model,
        data=[SimpleNamespace(embedding=[float(i) for i in range(dim)]) for _ in range(2)],
        usage=SimpleNamespace(prompt_tokens=5, total_tokens=5),
    )


def _status_error(cls: type[openai.APIStatusError], status: int) -> openai.APIStatusError:
    request = httpx.Request("POST", "http://provider.test/v1/chat/completions")
    response = httpx.Response(status, request=request)
    return cls("provider rejected", response=response, body=None)


def _connection_error() -> openai.APIConnectionError:
    request = httpx.Request("POST", "http://provider.test/v1/chat/completions")
    return openai.APIConnectionError(request=request)


# ---------------- 统一结果（调用方不接触供应商 SDK 类型） ----------------


async def test_chat_returns_unified_result(monkeypatch) -> None:
    # 显式固定模型名：不随 .env 切换真实/本地模型而漂移（测试自足）
    monkeypatch.setattr(settings, "model_chat_model", "demo-chat-1")
    gw = _gateway()

    async def fake_create(**kwargs):
        return _chat_response(kwargs["model"])

    gw._client.chat.completions.create = fake_create  # type: ignore[method-assign]
    result = await gw.chat([{"role": "user", "content": "hi"}])

    assert isinstance(result, object) and result.text == "echo:demo-chat-1"
    assert result.model == "demo-chat-1"
    assert result.usage == {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}
    assert result.latency_ms >= 0


async def test_embed_returns_unified_result(monkeypatch) -> None:
    monkeypatch.setattr(settings, "model_embedding_model", "demo-embedding-1")
    gw = _gateway()

    async def fake_create(**kwargs):
        return _embed_response(kwargs["model"])

    gw._client.embeddings.create = fake_create  # type: ignore[method-assign]
    result = await gw.embed(["a", "b"])

    assert len(result.vectors) == 2 and len(result.vectors[0]) == 4
    assert result.model == "demo-embedding-1"
    assert result.usage == {"prompt_tokens": 5, "total_tokens": 5}


# ---------------- 配置驱动映射表：改配置即切模型，零代码改动 ----------------


async def test_chat_model_follows_mapping_without_code_change(monkeypatch: pytest.MonkeyPatch) -> None:
    gw = _gateway()
    captured: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _chat_response(kwargs["model"])

    gw._client.chat.completions.create = fake_create  # type: ignore[method-assign]

    monkeypatch.setattr(settings, "model_chat_model", "another-chat-model")
    result = await gw.chat([{"role": "user", "content": "hi"}])

    assert captured["model"] == "another-chat-model"
    assert result.model == "another-chat-model"
    assert resolve_model_for(CAPABILITY_CHAT) == "another-chat-model"


async def test_embed_model_follows_mapping_without_code_change(monkeypatch: pytest.MonkeyPatch) -> None:
    gw = _gateway()
    captured: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _embed_response(kwargs["model"])

    gw._client.embeddings.create = fake_create  # type: ignore[method-assign]

    monkeypatch.setattr(settings, "model_embedding_model", "another-embedding-model")
    result = await gw.embed(["text"])

    assert captured["model"] == "another-embedding-model"
    assert result.model == "another-embedding-model"


async def test_explicit_model_overrides_mapping() -> None:
    """调用方显式传 model 时优先于映射表（映射表只是缺省值）。"""
    gw = _gateway()
    captured: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _chat_response(kwargs["model"])

    gw._client.chat.completions.create = fake_create  # type: ignore[method-assign]
    await gw.chat([{"role": "user", "content": "hi"}], model="explicit-model")
    assert captured["model"] == "explicit-model"


def test_unknown_capability_raises_config_error() -> None:
    with pytest.raises(ModelConfigError):
        resolve_model_for("audio")


def test_empty_base_url_rejected() -> None:
    with pytest.raises(ModelConfigError):
        ModelGateway(base_url="", api_key="k")


# ---------------- 错误翻译：不裸抛供应商异常 ----------------


async def test_auth_error_translated() -> None:
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.AuthenticationError, 401)

    gw._client.chat.completions.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelAuthError) as excinfo:
        await gw.chat([{"role": "user", "content": "hi"}])
    assert excinfo.value.capability == "chat"
    assert isinstance(excinfo.value.cause, openai.OpenAIError)


async def test_rate_limit_translated() -> None:
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.RateLimitError, 429)

    gw._client.embeddings.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelRateLimitError):
        await gw.embed(["text"])


async def test_connection_error_translated() -> None:
    gw = _gateway()

    async def fail(**kwargs):
        raise _connection_error()

    gw._client.chat.completions.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelUnavailableError):
        await gw.chat([{"role": "user", "content": "hi"}])


async def test_server_error_translated_as_unavailable() -> None:
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.InternalServerError, 500)

    gw._client.chat.completions.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelUnavailableError):
        await gw.chat([{"role": "user", "content": "hi"}])


async def test_bad_request_translated() -> None:
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.NotFoundError, 404)

    gw._client.embeddings.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelBadRequestError):
        await gw.embed(["text"])


async def test_errors_are_gateway_family_not_sdk() -> None:
    """所有供应商异常都被翻译为 ModelGatewayError 族，调用方无需 import openai。"""
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.PermissionDeniedError, 403)

    gw._client.chat.completions.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelGatewayError):
        await gw.chat([{"role": "user", "content": "hi"}])


# ---------------- 服务间 OpenAI 兼容代理（harness sidecar → Langfuse 同口径上报） ----------------


def _relay_response(model: str) -> SimpleNamespace:
    """带 model_dump 的响应对象（openai 响应是 pydantic 模型，代理按 dict 回传）。"""
    payload = {"id": "chatcmpl-1", "model": model, "choices": [{"message": {"role": "assistant", "content": "pong"}}]}
    return SimpleNamespace(model_dump=lambda: payload)


async def test_relay_passthrough_non_stream() -> None:
    """透传契约：请求体原样转发，响应按 dict 回传（Langfuse 上报由 drop-in 客户端承担）。"""
    gw = _gateway()
    captured = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _relay_response(kwargs["model"])

    gw._client.chat.completions.create = fake_create  # type: ignore[method-assign]
    body = {"model": "demo-chat-1", "messages": [{"role": "user", "content": "ping"}], "temperature": 0.3}
    result = await gw.relay_chat_completions(body)

    assert captured == body  # 不改写、不丢弃字段（messages/model/temperature 全透传）
    assert result["choices"][0]["message"]["content"] == "pong"


async def test_relay_stream_frames_and_done() -> None:
    """流式透传：逐 chunk 生成 SSE 帧，终结于 [DONE]。"""
    gw = _gateway()

    def chunk(text: str) -> SimpleNamespace:
        return SimpleNamespace(model_dump_json=lambda: f"{{\"delta\":\"{text}\"}}")

    async def fake_stream():
        yield chunk("你")
        yield chunk("好")

    async def fake_create(**kwargs):
        assert kwargs.get("stream") is True
        return fake_stream()

    gw._client.chat.completions.create = fake_create  # type: ignore[method-assign]
    frames = await gw.open_relay_stream({"model": "demo-chat-1", "messages": [], "stream": True})
    collected = [frame async for frame in frames]

    assert collected[0] == 'data: {"delta":"你"}\n\n'
    assert collected[1] == 'data: {"delta":"好"}\n\n'
    assert collected[-1] == "data: [DONE]\n\n"


async def test_relay_translates_upstream_error() -> None:
    """上游错误翻译为 ModelGatewayError 族，代理端点据此回 502。"""
    gw = _gateway()

    async def fail(**kwargs):
        raise _status_error(openai.AuthenticationError, 401)

    gw._client.chat.completions.create = fail  # type: ignore[method-assign]
    with pytest.raises(ModelAuthError):
        await gw.relay_chat_completions({"model": "m", "messages": []})


def _proxy_app(gateway: object) -> FastAPI:
    app = FastAPI()
    app.include_router(proxy_router)
    app.state.model_gateway = gateway
    return app


async def _post_proxy(app: FastAPI, body: dict, *, key: str | None) -> httpx.Response:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/api/model-gateway/v1/chat/completions", json=body, headers=headers)


async def test_proxy_endpoint_auth_matrix(monkeypatch) -> None:
    """认证矩阵：未配置密钥=端点关闭（503）/错 key=401/对 key=200。"""
    gateway = SimpleNamespace(
        relay_chat_completions=lambda body: _async(_relay_response(body["model"]).model_dump()),
    )
    app = _proxy_app(gateway)
    body = {"model": "demo-chat-1", "messages": [{"role": "user", "content": "ping"}]}

    monkeypatch.setattr(settings, "model_gateway_proxy_key", "")
    assert (await _post_proxy(app, body, key="whatever")).status_code == 503

    monkeypatch.setattr(settings, "model_gateway_proxy_key", "secret-key")
    assert (await _post_proxy(app, body, key="wrong")).status_code == 401
    ok = await _post_proxy(app, body, key="secret-key")
    assert ok.status_code == 200
    assert ok.json()["choices"][0]["message"]["content"] == "pong"


async def test_proxy_endpoint_stream_sse(monkeypatch) -> None:
    """stream=true → text/event-stream，帧序完整含 [DONE]。"""

    async def _frames(body):
        yield 'data: {"delta":"hi"}\n\n'
        yield "data: [DONE]\n\n"

    async def _open_stream(body):
        return _frames(body)  # 对齐真实 open_relay_stream：coroutine 返回 async generator

    gateway = SimpleNamespace(open_relay_stream=_open_stream)
    app = _proxy_app(gateway)
    monkeypatch.setattr(settings, "model_gateway_proxy_key", "secret-key")
    resp = await _post_proxy(app, {"model": "m", "messages": [], "stream": True}, key="secret-key")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.text.endswith("data: [DONE]\n\n")


async def test_proxy_endpoint_rejects_non_chat_payload(monkeypatch) -> None:
    """非 chat/completions 形状的 payload 拒绝（400），不做盲转发。"""
    monkeypatch.setattr(settings, "model_gateway_proxy_key", "secret-key")
    app = _proxy_app(SimpleNamespace())
    resp = await _post_proxy(app, {"input": "not-chat"}, key="secret-key")
    assert resp.status_code == 400


async def _async(value):
    return value
