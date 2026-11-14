"""初始数据 seed（T02）：幂等创建基础角色与初始管理员，可重复执行。

用途：app 容器 entrypoint 在迁移后自动调用（`python -m agent_platform.db.seed`），
保证"一条命令拉起底座"后即可用初始管理员登录。
"""

import asyncio
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_platform.core.config import settings
from agent_platform.core.security import hash_password
from agent_platform.db.engine import build_session_factory
from agent_platform.db.models import Role, User

_BASE_ROLES: tuple[tuple[str, str], ...] = (
    ("admin", "管理员：管理用户/角色/知识库"),
    ("member", "成员：使用知识问答，可见被授权的知识库"),
)


async def run_seed(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """幂等 seed：角色 get-or-create；管理员不存在时才创建（不覆盖已有口令）。"""
    async with session_factory() as session:
        name_to_role: dict[str, Role] = {}
        for name, description in _BASE_ROLES:
            role = await session.scalar(select(Role).where(Role.name == name))
            if role is None:
                role = Role(name=name, description=description)
                session.add(role)
                await session.flush()
            name_to_role[name] = role

        admin = await session.scalar(
            select(User).where(User.username == settings.admin_username)
        )
        if admin is None:
            session.add(
                User(
                    id=uuid.uuid4(),
                    username=settings.admin_username,
                    password_hash=hash_password(settings.admin_initial_password),
                    display_name="初始管理员",
                    role_id=name_to_role["admin"].id,
                )
            )
        await session.commit()


def main() -> None:
    """模块入口：独立构建会话工厂执行 seed（容器 entrypoint 调用）。"""
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    try:
        asyncio.run(run_seed(build_session_factory(engine)))
    finally:
        asyncio.run(engine.dispose())


if __name__ == "__main__":
    main()
