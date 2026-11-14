"""初始数据 seed（T02）：幂等创建基础角色与初始管理员，可重复执行。

用途：app 容器 entrypoint 在迁移后自动调用（`python -m agent_platform.db.seed`），
保证"一条命令拉起底座"后即可用初始管理员登录。
统一工作台一期（ADR-014/016）起增补：幂等 seed 两个内置智能体 Profile
（knowledge-assistant / code-engineer），不覆盖已有配置（同角色 seed 口径）。
"""

import asyncio
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from agent_platform.core.config import settings
from agent_platform.core.security import hash_password
from agent_platform.db.engine import build_session_factory
from agent_platform.db.models import AgentProfile, Role, User

_BASE_ROLES: tuple[tuple[str, str], ...] = (
    ("admin", "管理员：管理用户/角色/知识库"),
    ("member", "成员：使用知识问答，可见被授权的知识库"),
)

# 内置智能体（ADR-016 决策 1）：一期 seed 两个，均不内嵌 prompt 模板——
# knowledge-assistant 软引用现有 chat_qa 发布体系（零迁移）；
# code-engineer 一期用 agentdesk 图内置 PLAN/ACT 模板（prompt_key=None），
# tool_whitelist / model_policy 均为 null（= 全部注册工具 / 回落全局模型映射）。
_BASE_PROFILES: tuple[dict[str, str | None], ...] = (
    {
        "key": "knowledge-assistant",
        "display_name": "知识问答助手",
        "description": "基于你有权访问的知识库回答，每条结论标注引用来源",
        "prompt_key": "chat_qa",
        "tool_whitelist": None,
        "engine_kind": "qa_graph",
        "default_mode": None,
        "model_policy": None,
    },
    {
        "key": "code-engineer",
        "display_name": "代码工程师",
        "description": "计划确认后执行代码任务：工具调用、检查回灌、hunk 评审、门禁提交",
        "prompt_key": None,
        "tool_whitelist": None,
        "engine_kind": "agentdesk_bridge",
        "default_mode": "confirm",
        "model_policy": None,
    },
)


async def run_seed(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """幂等 seed：角色/Profile get-or-create；管理员不存在时才创建（不覆盖已有口令）。"""
    async with session_factory() as session:
        name_to_role: dict[str, Role] = {}
        for name, description in _BASE_ROLES:
            role = await session.scalar(select(Role).where(Role.name == name))
            if role is None:
                role = Role(name=name, description=description)
                session.add(role)
                await session.flush()
            name_to_role[name] = role

        for fields in _BASE_PROFILES:
            profile = await session.scalar(
                select(AgentProfile).where(AgentProfile.key == fields["key"])
            )
            if profile is None:
                profile = AgentProfile(**fields)  # type: ignore[arg-type]
                session.add(profile)
                await session.flush()

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
