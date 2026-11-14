"""迁移 0008（T11，ADR-011/013）：AgentDesk 数据层三组表。

- agent_tasks：意图容器（goal/owns/mode/status 九态）。ADR-011 术语裁决——
  Task 仅指 Agent 执行域的意图容器，与知识问答域「任务=异步作业」分域闭合；
- task_events：证据链实体（SSE 直播 / Last-Event-ID 回放 / 审计证据链一表三用），
  (task_id, seq) 唯一保证 seq 按 task 单调递增，组合键即 seq 游标查询的索引；
- approvals + always_allowed：L2 命令审批单与「总是允许」策略（带有效期）。
"""

from alembic import op
import sqlalchemy as sa

revision = "0008_agentdesk"
down_revision = "0007_prompts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("title", sa.String(128), nullable=True),
        sa.Column("goal", sa.Text(), nullable=False),
        # owns：可改动路径集合 JSON 数组字符串；refs：@ 引用 JSON 数组字符串
        sa.Column("owns", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("mode", sa.String(16), nullable=False, server_default="confirm"),
        sa.Column("refs", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="created"),
        sa.Column("workspace_dir", sa.String(512), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_agent_tasks_status", "agent_tasks", ["status"])
    op.create_index("ix_agent_tasks_created_by", "agent_tasks", ["created_by"])

    op.create_table(
        "task_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "task_id", sa.Uuid(), sa.ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("data", sa.Text(), nullable=True),  # JSON 对象字符串
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        # seq 按 task 单调递增的硬约束；唯一索引 (task_id, seq) 同时服务游标查询
        sa.UniqueConstraint("task_id", "seq", name="uq_task_events_task_seq"),
    )

    op.create_table(
        "approvals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "task_id", sa.Uuid(), sa.ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("command", sa.Text(), nullable=False),
        sa.Column("scope", sa.String(128), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("decision", sa.String(16), nullable=True),  # once / always / deny
        sa.Column("decided_by", sa.String(64), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_approvals_task_id", "approvals", ["task_id"])
    op.create_index("ix_approvals_status", "approvals", ["status"])

    op.create_table(
        "always_allowed",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("tool", sa.String(32), nullable=False),
        sa.Column("pattern", sa.String(256), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_always_allowed_user_id", "always_allowed", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_always_allowed_user_id", table_name="always_allowed")
    op.drop_table("always_allowed")
    op.drop_index("ix_approvals_status", table_name="approvals")
    op.drop_index("ix_approvals_task_id", table_name="approvals")
    op.drop_table("approvals")
    op.drop_table("task_events")
    op.drop_index("ix_agent_tasks_created_by", table_name="agent_tasks")
    op.drop_index("ix_agent_tasks_status", table_name="agent_tasks")
    op.drop_table("agent_tasks")
