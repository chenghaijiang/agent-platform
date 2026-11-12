"""受保护示例端点（T02）：验证 token 可解析出用户与角色。

业务路由只依赖 require_auth（背后是 AuthProvider 协议）——
这就是"替换认证实现无需改动业务代码"的落点。
"""

from fastapi import APIRouter, Depends

from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext

router = APIRouter(tags=["me"])


@router.get("/api/me")
async def me(context: AuthContext = Depends(require_auth)) -> dict:
    return {
        "user_id": context.user_id,
        "username": context.username,
        "role": context.role,
        "auth_provider": context.provider,
    }
