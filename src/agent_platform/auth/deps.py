"""认证依赖装配（T02）：全应用唯一的"实现选择点"，业务路由只依赖协议。"""

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer

from agent_platform.auth.fake_oidc import FakeOidcProvider
from agent_platform.auth.local import LocalPasswordProvider
from agent_platform.auth.provider import AuthContext, AuthProvider
from agent_platform.core.config import settings

# auto_error=False：无凭证时返回 None，由 require_auth 统一给出 401 + WWW-Authenticate
_bearer_scheme = HTTPBearer(auto_error=False)


def get_auth_provider(request: Request) -> AuthProvider:
    """装配点：按配置选择认证实现。替换认证方式只改这里（或 auth_provider 配置）。"""
    if settings.auth_provider == "fake-oidc":
        return FakeOidcProvider()
    return LocalPasswordProvider(request.app.state.session_factory)


async def require_auth(
    credentials: object = Depends(_bearer_scheme),
    provider: AuthProvider = Depends(get_auth_provider),
) -> AuthContext:
    """受保护端点通用依赖：Bearer token → AuthContext；无效一律 401。"""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    context = await provider.verify(credentials.credentials)  # type: ignore[attr-defined]
    if context is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return context


async def require_admin(context: AuthContext = Depends(require_auth)) -> AuthContext:
    """管理员专属端点依赖：非 admin 角色 403（已认证但越权）。"""
    if context.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin role required")
    return context
