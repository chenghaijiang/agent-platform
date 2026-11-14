"""统一工作台数据层单测（迁移 0010 对应）：Profile seed 幂等 + 新模型字段语义。

覆盖（ADR-014~017 落库层）：
- run_seed 幂等创建两个内置智能体 Profile，重复执行不重复、不覆盖已有改动；
- knowledge-assistant / code-engineer 的关键字段（engine_kind / prompt_key / default_mode）；
- ChatSession.profile_key 缺省 null（存量会话零迁移）；ChatMessage (session_id, seq) 游标。
"""

import uuid

import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.db.models import (
    AGENT_PROFILE_ENGINE_KINDS,
    AgentProfile,
    Base,
    ChatMessage,
    ChatSession,
)
from agent_platform.db.seed import run_seed


@pytest_asyncio.fixture()
async def factory():
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _profile(factory, key: str) -> AgentProfile:
    async with factory() as session:
        return await session.scalar(select(AgentProfile).where(AgentProfile.key == key))


async def test_seed_creates_both_builtin_profiles(factory):
    await run_seed(factory)

    qa = await _profile(factory, "knowledge-assistant")
    assert qa is not None
    assert qa.display_name == "知识问答助手"
    assert qa.prompt_key == "chat_qa"  # 软引用现有发布体系，零迁移（ADR-016）
    assert qa.engine_kind == "qa_graph"
    assert qa.default_mode is None  # QA 类无工具执行
    assert qa.enabled is True

    code = await _profile(factory, "code-engineer")
    assert code is not None
    assert code.prompt_key is None  # harness 内核模板内置，不走发布体系
    assert code.engine_kind == "harness"
    assert code.default_mode is None  # 预留字段，当前引擎不读取


async def test_seed_is_idempotent_and_keeps_modifications(factory):
    await run_seed(factory)
    # 管理员改过 description（模拟运营调整），再跑 seed 不得覆盖
    async with factory() as session:
        profile = await session.scalar(select(AgentProfile).where(AgentProfile.key == "code-engineer"))
        profile.description = "调整后的描述"
        await session.commit()

    await run_seed(factory)

    async with factory() as session:
        count = await session.scalar(select(func.count()).select_from(AgentProfile))
        assert count == 2  # 不重复
        qa = await session.scalar(select(AgentProfile).where(AgentProfile.key == "code-engineer"))
        assert qa.description == "调整后的描述"


async def test_engine_kinds_are_known_constants():
    assert AGENT_PROFILE_ENGINE_KINDS == ("qa_graph", "harness", "runtime")


async def test_session_profile_key_defaults_null_and_messages_cursored(factory):
    # 存量语义：不指定 profile_key 的会话 = knowledge-assistant（ADR-014 决策 3）
    session_id = uuid.uuid4()
    async with factory() as session:
        chat = ChatSession(id=session_id, user_id="u1")
        session.add(chat)
        await session.flush()
        assert chat.profile_key is None

        # 消息流水信封：(session_id, seq) 唯一，text 信封可回放（ADR-015 决策 5）
        session.add(
            ChatMessage(
                session_id=session_id,
                seq=1,
                type="text",
                data='{"role": "user", "text": "修复一下"}',
            )
        )
        session.add(
            ChatMessage(
                session_id=session_id,
                seq=2,
                type="text",
                data='{"role": "assistant", "text": "好的"}',
            )
        )
        await session.commit()

        rows = await session.scalars(
            select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.seq)
        )
        messages = list(rows)
        assert [m.seq for m in messages] == [1, 2]
        assert [m.type for m in messages] == ["text", "text"]
