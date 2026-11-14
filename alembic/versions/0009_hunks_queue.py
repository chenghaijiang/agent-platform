"""迁移 0009（T14，ADR-011/005）：hunk 评审表 + Agent 任务队列字段。

- agent_hunks：diff 逐块评审载体（PRD 门禁——全部 accepted 且 checks 全绿才允许提交）。
  hunk 内容在任务进入 review 态时从 workspace 的 git diff 生成落库（按文件分块），
  状态机 pending → accepted / rejected，(task_id, idx) 唯一保证幂等生成；
- agent_tasks 加队列字段（ADR-005 PG 队列模式复用）：lease_expires_at 租约
  （Worker SKIP LOCKED 认领，崩溃未续约到期被重新认领）、attempts 重试计数。
"""

from alembic import op
import sqlalchemy as sa

revision = "0009_hunks_queue"
down_revision = "0008_agentdesk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_hunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "task_id", sa.Uuid(), sa.ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("idx", sa.Integer(), nullable=False),  # task 内 hunk 序号（0 起）
        sa.Column("path", sa.String(512), nullable=False),  # 相对 workspace 根
        sa.Column("header", sa.Text(), nullable=True),  # diff 头（---/+++/@@ 行）
        sa.Column("content", sa.Text(), nullable=True),  # diff 块内容（截断落库）
        sa.Column("additions", sa.Integer(), nullable=True),
        sa.Column("deletions", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("decided_by", sa.String(64), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("task_id", "idx", name="uq_agent_hunks_task_idx"),
    )
    op.create_index("ix_agent_hunks_task_id", "agent_hunks", ["task_id"])

    op.add_column(
        "agent_tasks",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_tasks", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0")
    )


def downgrade() -> None:
    op.drop_column("agent_tasks", "attempts")
    op.drop_column("agent_tasks", "lease_expires_at")
    op.drop_index("ix_agent_hunks_task_id", table_name="agent_hunks")
    op.drop_table("agent_hunks")
