"""admin 自检端点 + 服务间 OpenAI 兼容代理（T03 验收入口，T09 控制台复用）。

代理端点（/api/model-gateway/v1/*）：harness sidecar（代码工程师）的模型出口经此
转发到真实上游，复用 langfuse 包裹的客户端，使 sidecar 流量与本平台自有链路
同口径自动上报 Langfuse。认证为服务间共享密钥（MODEL_GATEWAY_PROXY_KEY），
未配置时端点整体关闭。
"""

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from agent_platform.auth.deps import require_admin
from agent_platform.core.config import settings
from agent_platform.model_gateway.errors import ModelGatewayError
from agent_platform.model_gateway.gateway import (
    CAPABILITY_CHAT,
    CAPABILITY_EMBEDDING,
    ModelGateway,
    resolve_model_for,
)

router = APIRouter(prefix="/api/admin/model-gateway", tags=["model-gateway"])
proxy_router = APIRouter(prefix="/api/model-gateway", tags=["model-gateway-proxy"])


class SelfTestRequest(BaseModel):
    capability: str = Field(description="chat 或 embedding")
    prompt: str | None = Field(default=None, description="capability=chat 时的提问文本")
    texts: list[str] | None = Field(default=None, description="capability=embedding 时的文本列表")


async def require_proxy_key(request: Request) -> None:
    """服务间认证：共享密钥 constant-time 比较；未配置密钥 = 端点关闭（安全默认）。"""
    expected = settings.model_gateway_proxy_key
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="model gateway proxy disabled: MODEL_GATEWAY_PROXY_KEY is not set",
        )
    auth = request.headers.get("authorization", "")
    provided = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid model gateway proxy key")


def get_model_gateway(request: Request) -> ModelGateway:
    """从 lifespan 挂载的应用状态取网关单例。"""
    return request.app.state.model_gateway


@router.post("/self-test")
async def self_test(
    payload: SelfTestRequest,
    _admin: object = Depends(require_admin),
    gateway: ModelGateway = Depends(get_model_gateway),
) -> dict:
    """连通性自检：真实走一次网关调用并等其上报完成，返回结果摘要。

    验收口径：响应中的 model 字段即当前映射表生效值；改 .env 重启后该值随之变化。
    """
    try:
        if payload.capability == CAPABILITY_CHAT:
            result = await gateway.chat(
                [{"role": "user", "content": payload.prompt or "ping"}]
            )
            summary: dict = {
                "capability": CAPABILITY_CHAT,
                "model": result.model,
                "usage": result.usage,
                "latency_ms": result.latency_ms,
                "text_preview": result.text[:200],
            }
        elif payload.capability == CAPABILITY_EMBEDDING:
            texts = payload.texts or ["ping"]
            result = await gateway.embed(texts)
            summary = {
                "capability": CAPABILITY_EMBEDDING,
                "model": result.model,
                "usage": result.usage,
                "latency_ms": result.latency_ms,
                "vector_count": len(result.vectors),
                "vector_dim": len(result.vectors[0]) if result.vectors else 0,
            }
        else:
            raise HTTPException(
                status_code=422,
                detail=f"capability must be '{CAPABILITY_CHAT}' or '{CAPABILITY_EMBEDDING}'",
            )
    except ModelGatewayError as exc:
        # 明确错误类型而非裸抛供应商异常：错误类名 + 能力位 + 模型名一并返回
        raise HTTPException(
            status_code=502,
            detail={
                "error_type": type(exc).__name__,
                "capability": exc.capability,
                "model": exc.model,
                "message": str(exc),
            },
        ) from exc

    await gateway.flush()  # 演示场景立即上报，保证 Langfuse UI/API 即刻可查
    summary["current_mapping"] = {
        "chat": resolve_model_for(CAPABILITY_CHAT),
        "embedding": resolve_model_for(CAPABILITY_EMBEDDING),
    }
    return summary


# ---------- 服务间 OpenAI 兼容代理（harness sidecar → 平台 → 真实上游） ----------


@proxy_router.post("/v1/chat/completions")
async def proxy_chat_completions(
    request: Request,
    _key: None = Depends(require_proxy_key),
    gateway: ModelGateway = Depends(get_model_gateway),
) -> Response:
    """chat/completions 透传：请求体原样转发（model/messages/stream/temperature/...），

    流式请求回 SSE 帧、非流式回 JSON。调用方（sidecar）传入的 api_key 已在
    require_proxy_key 验毕，转发时不额外改写 body（上游凭证在网关客户端内）。
    """
    try:
        body = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="request body must be JSON") from exc
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        raise HTTPException(status_code=400, detail="OpenAI chat.completions payload required")

    try:
        if body.get("stream"):
            frames = await gateway.open_relay_stream(body)
            return StreamingResponse(
                frames,
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        result = await gateway.relay_chat_completions(body)
    except ModelGatewayError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "error_type": type(exc).__name__,
                "model": exc.model,
                "message": str(exc),
            },
        ) from exc
    return JSONResponse(result)
