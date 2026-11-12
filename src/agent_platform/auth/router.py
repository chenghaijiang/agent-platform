"""认证端点（T02）：登录换 token。路由只调用 AuthProvider 协议，不感知实现。"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from agent_platform.auth.deps import get_auth_provider
from agent_platform.auth.provider import AuthProvider

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


@router.post("/login")
async def login(
    payload: LoginRequest,
    provider: AuthProvider = Depends(get_auth_provider),
) -> dict:
    """口令登录；失败统一 401（不区分"用户不存在/口令错误"，防枚举）。"""
    result = await provider.login(payload.username, payload.password)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid username or password"
        )
    return {
        "access_token": result.token.access_token,
        "token_type": result.token.token_type,
        "expires_in": result.token.expires_in,
        "user": {
            "user_id": result.context.user_id,
            "username": result.context.username,
            "role": result.context.role,
        },
    }
