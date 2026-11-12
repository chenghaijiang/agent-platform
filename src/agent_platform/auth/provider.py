"""认证层接口抽象（T02，ADR-006）：业务代码只依赖 AuthProvider 协议与 AuthContext。

两段结构：
- 抽象（本文件）：AuthProvider 协议定义"登录换凭证 + 凭证换身份"两个动作；
- 实现：auth/local.py（本地口令，默认）与 auth/fake_oidc.py（演示第二实现）。
阶段二接入真实 OIDC 时新增实现并在装配点（auth/deps.get_auth_provider）切换，
业务路由 /api/me、/api/admin/* 等零改动。
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class AuthContext:
    """一次已验证的身份：受保护端点从 token 中解析出的最小事实。"""

    user_id: str
    username: str
    role: str
    provider: str  # 身份来源（local-password / fake-oidc / ...），便于审计与调试


@dataclass(frozen=True)
class TokenPair:
    """签发给客户端的访问凭证。"""

    access_token: str
    token_type: str = "bearer"
    expires_in: int = 0  # 秒


@dataclass(frozen=True)
class AuthResult:
    """登录成功产物：凭证 + 身份。"""

    token: TokenPair
    context: AuthContext


class AuthProvider(Protocol):
    """认证方式协议。

    login：以"用户标识 + 秘密"换取访问凭证。本地实现校验口令哈希；
    OIDC 实现校验授权码（阶段二将参数演进为 credentials 对象）。
    校验失败返回 None（由路由统一转 401，防止向调用方泄露实现细节）。

    verify：校验请求携带的 token，还原 AuthContext；无效返回 None。
    """

    name: str

    async def login(self, username: str, password: str) -> AuthResult | None: ...

    async def verify(self, token: str) -> AuthContext | None: ...
