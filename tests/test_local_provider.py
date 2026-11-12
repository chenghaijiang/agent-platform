"""LocalPasswordProvider 单测（不依赖外部服务：SQLite 内存库建表 + 造数据）。"""

import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.auth.local import LocalPasswordProvider
from agent_platform.core.security import hash_password
from agent_platform.db.models import Base, Role, User


@pytest.fixture()
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        admin_role = Role(name="admin", description="管理员")
        member_role = Role(name="member", description="成员")
        session.add_all([admin_role, member_role])
        await session.flush()
        session.add(
            User(
                username="alice",
                password_hash=hash_password("alice-password"),
                role_id=admin_role.id,
            )
        )
        session.add(
            User(
                username="bob",
                password_hash=hash_password("bob-password"),
                role_id=member_role.id,
                is_active=False,  # 停用用户不可登录
            )
        )
        await session.commit()
    yield factory
    await engine.dispose()


async def test_login_ok_returns_token_with_user_and_role(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    result = await provider.login("alice", "alice-password")
    assert result is not None
    assert result.context.username == "alice"
    assert result.context.role == "admin"
    assert result.context.provider == "local-password"
    assert result.token.expires_in > 0


async def test_verify_roundtrip_parses_user_and_role(session_factory) -> None:
    """token 中可解析出用户与角色（ticket 验收项）。"""
    provider = LocalPasswordProvider(session_factory)
    result = await provider.login("alice", "alice-password")
    assert result is not None

    context = await provider.verify(result.token.access_token)
    assert context is not None
    assert context.username == "alice"
    assert context.role == "admin"


async def test_login_wrong_password_returns_none(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    assert await provider.login("alice", "wrong-password") is None


async def test_login_unknown_user_returns_none(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    assert await provider.login("nobody", "whatever") is None


async def test_login_inactive_user_returns_none(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    assert await provider.login("bob", "bob-password") is None


async def test_verify_rejects_tampered_token(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    result = await provider.login("alice", "alice-password")
    assert result is not None
    token = result.token.access_token
    tampered = token[:-6] + ("aaaaaa" if token[-6:] != "aaaaaa" else "bbbbbb")
    assert await provider.verify(tampered) is None


async def test_verify_rejects_expired_token(session_factory, monkeypatch) -> None:
    """TTL=0 → exp 立即过期，verify 返回 None。"""
    monkeypatch.setenv("ACCESS_TOKEN_TTL_MINUTES", "0")
    from agent_platform.core.config import Settings

    fresh = Settings(_env_file=None)
    monkeypatch.setattr("agent_platform.auth.tokens.settings", fresh)

    provider = LocalPasswordProvider(session_factory)
    result = await provider.login("alice", "alice-password")
    assert result is not None
    assert result.token.expires_in == 0
    assert await provider.verify(result.token.access_token) is None


async def test_verify_rejects_garbage(session_factory) -> None:
    provider = LocalPasswordProvider(session_factory)
    assert await provider.verify("garbage-token") is None
    assert await provider.verify(str(uuid.uuid4())) is None
