"""应用内模型网关（T03，v0.2 §5.5 的 M1 形态）。

设计要点：
- 统一 OpenAI-compatible 出口：业务方只调用 ``ModelGateway.chat/embed``，不接触 openai SDK；
- 配置驱动映射表：chat/embedding 两个能力位的模型名每次调用动态读 settings，
  改 ``.env``（MODEL_CHAT_MODEL / MODEL_EMBEDDING_MODEL）即切换，零代码改动；
- Langfuse 自动上报：经 ``langfuse.openai`` drop-in 模块（import 即全局 instrument
  openai SDK，v5 SDK 机制）创建 client，每次调用自动产出 generation
  （模型名 / token 用量 / 延迟），方法级再叠加 @observe span 形成完整 Trace；
  无凭证环境（单测）SDK 静默降级为 disabled，不影响功能测试；
- 错误不裸抛：openai 异常族在网关内翻译为 ModelGatewayError 族（见 errors.py）。
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

import openai
from langfuse import get_client, observe
from langfuse.openai import openai as langfuse_openai

from agent_platform.core.config import settings
from agent_platform.model_gateway.errors import (
    ModelAuthError,
    ModelBadRequestError,
    ModelConfigError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelUnavailableError,
)

CAPABILITY_CHAT = "chat"
CAPABILITY_EMBEDDING = "embedding"


@dataclass(frozen=True)
class ChatResult:
    """统一生成结果：文本 + 模型名 + token 用量 + 耗时。"""

    text: str
    model: str
    usage: dict[str, int]
    latency_ms: int


@dataclass(frozen=True)
class ToolCall:
    """模型返回的一次工具调用（T13 工具循环用，与具体供应商格式解耦）。"""

    id: str
    name: str
    args: dict  # JSON 解析后的参数；解析失败降级为 {}


@dataclass(frozen=True)
class ChatToolsResult:
    """工具调用轮的生成结果：叙述文本 + 工具调用列表 + 用量。"""

    content: str
    tool_calls: list[ToolCall]
    model: str
    usage: dict[str, int]
    latency_ms: int


@dataclass(frozen=True)
class EmbedResult:
    """统一 Embedding 结果：向量列表 + 模型名 + token 用量 + 耗时。"""

    vectors: list[list[float]]
    model: str
    usage: dict[str, int]
    latency_ms: int


class ModelGateway:
    """应用内模型网关：所有模型调用必须经此模块发出（v0.2 §5.5 M1）。"""

    def __init__(self, *, base_url: str, api_key: str, timeout_s: float = 60.0) -> None:
        if not base_url:
            raise ModelConfigError(
                "model gateway base_url is empty", capability=CAPABILITY_CHAT, model=""
            )
        self._client = langfuse_openai.AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout_s,
            max_retries=1,
        )

    @classmethod
    def from_settings(cls) -> "ModelGateway":
        """按 settings 构建网关实例（base_url/api_key 来自环境变量，凭证不落代码仓库）。"""
        return cls(
            base_url=settings.model_gateway_base_url,
            api_key=settings.model_gateway_api_key,
        )

    # ---------- 能力位一：生成 ----------
    @observe(name="model_gateway.chat")
    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> ChatResult:
        """生成调用。model 缺省时读映射表（settings.model_chat_model），实现零代码切换。"""
        model = model or settings.model_chat_model
        if not model:
            raise ModelConfigError("chat model mapping is empty", capability=CAPABILITY_CHAT, model="")
        started = time.perf_counter()
        try:
            response = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except openai.OpenAIError as exc:
            raise self._translate(exc, CAPABILITY_CHAT, model) from exc
        latency_ms = int((time.perf_counter() - started) * 1000)
        choice = response.choices[0]
        usage = response.usage
        return ChatResult(
            text=choice.message.content or "",
            model=response.model or model,
            usage={
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "completion_tokens": usage.completion_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            },
            latency_ms=latency_ms,
        )

    # ---------- 能力位一：生成（流式，T07） ----------
    @observe(name="model_gateway.chat_stream")
    async def stream_chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        """流式生成：逐段 yield 增量文本；结束帧含 usage（自动经 langfuse 上报 generation）。"""
        model = model or settings.model_chat_model
        if not model:
            raise ModelConfigError("chat model mapping is empty", capability=CAPABILITY_CHAT, model="")
        try:
            stream = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except openai.OpenAIError as exc:
            raise self._translate(exc, CAPABILITY_CHAT, model) from exc

    # ---------- 能力位一：生成（工具调用，T13 Agent 工具循环） ----------
    @observe(name="model_gateway.chat_tools")
    async def chat_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        *,
        model: str | None = None,
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> ChatToolsResult:
        """tool-calling 调用：透传 tools 定义，解析 tool_calls（内容与参数结构化）。

        temperature 取低值：Agent 工具循环需要稳定而非发散。
        """
        model = model or settings.model_chat_model
        if not model:
            raise ModelConfigError("chat model mapping is empty", capability=CAPABILITY_CHAT, model="")
        started = time.perf_counter()
        try:
            response = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except openai.OpenAIError as exc:
            raise self._translate(exc, CAPABILITY_CHAT, model) from exc
        latency_ms = int((time.perf_counter() - started) * 1000)
        choice = response.choices[0]
        usage = response.usage
        calls: list[ToolCall] = []
        for call in choice.message.tool_calls or []:
            try:
                args = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:  # 供应商畸形参数：降级为空参，由策略层参数校验拦截
                args = {}
            calls.append(ToolCall(id=call.id, name=call.function.name, args=args))
        return ChatToolsResult(
            content=choice.message.content or "",
            tool_calls=calls,
            model=response.model or model,
            usage={
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "completion_tokens": usage.completion_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            },
            latency_ms=latency_ms,
        )

    # ---------- 能力位二：Embedding ----------
    @observe(name="model_gateway.embed")
    async def embed(self, texts: list[str], *, model: str | None = None) -> EmbedResult:
        """Embedding 调用。model 缺省时读映射表（settings.model_embedding_model）。"""
        model = model or settings.model_embedding_model
        if not model:
            raise ModelConfigError(
                "embedding model mapping is empty", capability=CAPABILITY_EMBEDDING, model=""
            )
        started = time.perf_counter()
        try:
            response = await self._client.embeddings.create(model=model, input=texts)
        except openai.OpenAIError as exc:
            raise self._translate(exc, CAPABILITY_EMBEDDING, model) from exc
        latency_ms = int((time.perf_counter() - started) * 1000)
        usage = response.usage
        return EmbedResult(
            vectors=[item.embedding for item in response.data],
            model=response.model or model,
            usage={
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            },
            latency_ms=latency_ms,
        )

    async def flush(self) -> None:
        """立即上报缓冲的观测数据（演示/验收用；高频业务路径依赖 SDK 批量上报即可）。"""
        try:
            client = get_client()
            if client is not None:
                # flush() 为同步阻塞实现，卸到线程避免阻塞事件循环
                await asyncio.to_thread(client.flush)
        except Exception:  # noqa: BLE001, S110 - 观测上报失败不影响业务链路
            pass

    @staticmethod
    def _translate(exc: openai.OpenAIError, capability: str, model: str) -> ModelGatewayError:
        """把供应商异常族翻译为网关错误族：调用方不感知 openai SDK 细节。"""
        if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
            return ModelAuthError(
                f"model provider rejected credentials: {exc}", capability=capability, model=model, cause=exc
            )
        if isinstance(exc, openai.RateLimitError):
            return ModelRateLimitError(
                f"model provider rate limited: {exc}", capability=capability, model=model, cause=exc
            )
        if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError)):
            return ModelUnavailableError(
                f"model provider unreachable or timed out: {exc}", capability=capability, model=model, cause=exc
            )
        if isinstance(exc, (openai.BadRequestError, openai.NotFoundError)):
            return ModelBadRequestError(
                f"model provider rejected request: {exc}", capability=capability, model=model, cause=exc
            )
        if isinstance(exc, openai.APIStatusError) and exc.status_code >= 500:
            return ModelUnavailableError(
                f"model provider server error ({exc.status_code}): {exc}",
                capability=capability,
                model=model,
                cause=exc,
            )
        return ModelGatewayError(
            f"model provider error: {exc}", capability=capability, model=model, cause=exc
        )


def resolve_model_for(capability: str) -> str:
    """读映射表：capability → model 名（配置驱动切换的唯一入口）。"""
    if capability == CAPABILITY_CHAT:
        return settings.model_chat_model
    if capability == CAPABILITY_EMBEDDING:
        return settings.model_embedding_model
    raise ModelConfigError(f"unknown capability: {capability}", capability=capability, model="")
