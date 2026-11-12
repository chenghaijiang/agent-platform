"""认证第二实现（T02）：模拟 OIDC，用于验证认证层可替换性（ticket 验收项）。

它不查库、不校验口令：任意用户名均可换取 member 身份的 token，verify 只接受
自己签发的 token（独立 secret）。业务路由不感知这一替换——这正是 ADR-006
"认证实现抽象为可替换接口"的验收证据。

阶段二接入真实 OIDC 时：将本类替换为真正与 IdP 交互的实现（校验授权码、
验证 IdP 签发的 RS256 token），装配点切换后业务代码零改动。
"""

import time
from typing import Any

import jwt

from agent_platform.auth.provider import AuthContext, AuthResult, TokenPair

# 仅演示用独立密钥：与本地实现的 auth_secret 隔离，证明 token 不跨实现互认
_DEMO_SECRET = "fake-oidc-demo-secret-not-for-prod"
_DEMO_ISSUER = "fake-idp"
_DEMO_TTL_SECONDS = 3600


class FakeOidcProvider:
    """模拟 OIDC 认证方式：login 模拟 IdP 授权成功，verify 模拟校验 IdP token。"""

    name = "fake-oidc"

    async def login(self, username: str, password: str) -> AuthResult | None:
        # 真实 OIDC 无口令概念（凭授权码换 id_token）；此处演示"任意身份可通过"
        now = int(time.time())
        payload: dict[str, Any] = {
            "iss": _DEMO_ISSUER,
            "sub": f"fake-{username}",
            "username": username,
            "role": "member",
            "iat": now,
            "exp": now + _DEMO_TTL_SECONDS,
        }
        token = jwt.encode(payload, _DEMO_SECRET, algorithm="HS256")
        return AuthResult(
            token=TokenPair(access_token=token, expires_in=_DEMO_TTL_SECONDS),
            context=AuthContext(
                user_id=payload["sub"], username=username, role="member", provider=self.name
            ),
        )

    async def verify(self, token: str) -> AuthContext | None:
        try:
            payload = jwt.decode(
                token, _DEMO_SECRET, algorithms=["HS256"], issuer=_DEMO_ISSUER
            )
        except jwt.PyJWTError:
            return None
        return AuthContext(
            user_id=payload["sub"],
            username=payload["username"],
            role=payload["role"],
            provider=self.name,
        )
