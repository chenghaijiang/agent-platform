"""模型网关单测（T03 验收：映射表配置驱动零代码切换 / 错误类型明确 / 统一结果）。"""

from types import SimpleNamespace

import httpx
import openai
import pytest

from agent_platform.core.config import settings
from agent_platform.model_gateway.errors import (
    ModelAuthError,
    ModelBadRequestError,
    ModelConfigError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelUnavailableError,
)
from agent_platform.model_gateway.gateway import CAPABILITY_CHAT, ModelGateway, resolve_model_for


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
