"""admin 自检端点：验证网关连通性与观测链路（T03 验收入口，T09 控制台复用）。"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from agent_platform.auth.deps import require_admin
from agent_platform.model_gateway.gateway import (
    CAPABILITY_CHAT,
    CAPABILITY_EMBEDDING,
    ModelGateway,
    resolve_model_for,
)
from agent_platform.model_gateway.errors import ModelGatewayError

router = APIRouter(prefix="/api/admin/model-gateway", tags=["model-gateway"])


class SelfTestRequest(BaseModel):
    capability: str = Field(description="chat 或 embedding")
    prompt: str | None = Field(default=None, description="capability=chat 时的提问文本")
    texts: list[str] | None = Field(default=None, description="capability=embedding 时的文本列表")


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
