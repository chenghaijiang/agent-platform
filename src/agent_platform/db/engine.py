"""异步数据库访问装配（T02 起）：engine 归应用 lifespan 持有，本模块提供工厂构建。"""

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, AsyncSession


def build_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """基于既有 engine 构建会话工厂；expire_on_commit=False 便于提交后直接返回数据。"""
    return async_sessionmaker(engine, expire_on_commit=False)
