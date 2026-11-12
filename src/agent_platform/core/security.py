"""口令哈希原语（T02，ADR-006）：PBKDF2-SHA256 加盐哈希，存储格式不含明文。

存储格式：pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>（Django 风格，便于未来换算法平滑迁移）。
本模块只负责"哈希与校验"，不感知认证方式（本地口令 / OIDC）。
"""

import base64
import hashlib
import hmac
import secrets

_ALGORITHM = "pbkdf2_sha256"
_ITERATIONS = 260_000
_SALT_BYTES = 16


def hash_password(password: str) -> str:
    """生成加盐哈希：每次调用生成独立随机盐。"""
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return "$".join(
        (
            _ALGORITHM,
            str(_ITERATIONS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        )
    )


def verify_password(password: str, stored: str) -> bool:
    """校验口令；存储格式非法或算法不匹配一律返回 False（恒时比较防时序侧信道）。"""
    try:
        algorithm, iterations_s, salt_b64, digest_b64 = stored.split("$", 3)
        if algorithm != _ALGORITHM:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.b64decode(salt_b64),
            int(iterations_s),
        )
        return hmac.compare_digest(digest, base64.b64decode(digest_b64))
    except (ValueError, TypeError):
        return False
