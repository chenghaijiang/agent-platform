"""迁移 0005（T07）：会话元数据表 + 问答 Run 表。

ADR-008 分库分责：会话元数据归 chat_sessions（业务库），
LangGraph 执行态（checkpoints）由 PostgresSaver 在同库独立建表（setup 自动迁移），
两者以 session.thread_id ↔ graph thread_id 映射，互不越界。
"""

from alembic import op
import sqlalchemy as sa

revision = "0005_chat"
down_revision = "0004_ingestion"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chat_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("title", sa.String(128), nullable=True),
        # LangGraph thread 映射：同一 thread_id 的 checkpointer 状态即该会话的执行态
        sa.Column("thread_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_chat_sessions_user_id", "chat_sessions", ["user_id"])

    op.create_table(
        "chat_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id", sa.Uuid(), sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("question", sa.Text(), nullable=False),
        # Run 状态机（T07）：running / completed / failed
        sa.Column("status", sa.String(16), nullable=False, server_default="running"),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("citations", sa.Text(), nullable=True),  # JSON 数组字符串
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_chat_runs_session_id", "chat_runs", ["session_id"])
    op.create_index("ix_chat_runs_status", "chat_runs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_chat_runs_status", table_name="chat_runs")
    op.drop_index("ix_chat_runs_session_id", table_name="chat_runs")
    op.drop_table("chat_runs")
    op.drop_index("ix_chat_sessions_user_id", table_name="chat_sessions")
    op.drop_table("chat_sessions")
