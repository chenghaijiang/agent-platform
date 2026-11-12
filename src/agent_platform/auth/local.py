"""本地口令认证实现（T02，ADR-006 默认实现）：查 users 表校验口令哈希，自签 JWT。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

from agent_platform.auth.provider import AuthContext, AuthResult, TokenPair
from agent_platform.auth.tokens import decode_access_token, issue_access_token
from agent_platform.core.security import verify_password
from agent_platform.db.models import Role, User


class LocalPasswordProvider:
    """内置账号体系：username + password → 自签 access token。"""

    name = "local-password"

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def login(self, username: str, password: str) -> AuthResult | None:
        # 单次 join 同时取用户与角色名；用户不存在与口令错误统一返回 None（路由转 401，防用户名枚举）
        stmt = (
            select(User, Role.name)
            .join(Role, User.role_id == Role.id)
            .where(User.username == username, User.is_active.is_(True))
        )
        async with self._session_factory() as session:
            row = (await session.execute(stmt)).first()
        if row is None:
            return None
        user, role_name = row

        if not verify_password(password, user.password_hash):
            return None

        token, expires_in = issue_access_token(
            user_id=str(user.id), username=user.username, role=role_name
        )
        return AuthResult(
            token=TokenPair(access_token=token, expires_in=expires_in),
            context=AuthContext(
                user_id=str(user.id), username=user.username, role=role_name, provider=self.name
            ),
        )

    async def verify(self, token: str) -> AuthContext | None:
        # token 自包含用户与角色，校验不触库
        payload = decode_access_token(token)
        if payload is None:
            return None
        return AuthContext(
            user_id=payload["sub"],
            username=payload["username"],
            role=payload["role"],
            provider=self.name,
        )
