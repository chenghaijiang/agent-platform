"""Alembic 迁移环境（T01）：同步引擎连接；URL 复用应用配置，避免双份配置漂移。"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from agent_platform.core.config import settings
from agent_platform.db.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# T02 起接入 ORM 元数据（autogenerate 可用）；0001 空基线仍为手写 pass
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(settings.database_url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
