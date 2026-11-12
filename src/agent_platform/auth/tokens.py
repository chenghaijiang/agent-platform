"""Access token 签发与校验（T02）：HMAC-SHA256 签名的 JWT，自包含用户与角色。

这是 token 的通用机制层：认证实现（本地口令 / OIDC）决定"谁的身份可被签发"，
本模块只负责"签发与验证"这一可复用动作。
"""

import time
import uuid
from typing import Any

import jwt

from agent_platform.core.config import settings

_TOKEN_ISSUER = "agent-platform"


def issue_access_token(*, user_id: str, username: str, role: str, ttl_minutes: int | None = None) -> tuple[str, int]:
    """签发 access token，返回 (token, expires_in_seconds)。"""
    ttl = settings.access_token_ttl_minutes if ttl_minutes is None else ttl_minutes
    now = int(time.time())
    payload: dict[str, Any] = {
        "iss": _TOKEN_ISSUER,
        "sub": user_id,
        "username": username,
        "role": role,
        "iat": now,
        "exp": now + ttl * 60,
    }
    token = jwt.encode(payload, settings.auth_secret, algorithm="HS256")
    return token, ttl * 60


def decode_access_token(token: str) -> dict[str, Any] | None:
    """校验签名与有效期；任何失败（篡改/过期/格式错误）返回 None，不抛出。"""
    try:
        return jwt.decode(token, settings.auth_secret, algorithms=["HS256"], issuer=_TOKEN_ISSUER)
    except jwt.PyJWTError:
        return None


def new_user_id() -> str:
    """token 主体标识用 UUID 字符串，与 users.id 对齐。"""
    return str(uuid.uuid4())
