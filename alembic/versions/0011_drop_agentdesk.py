"""迁移 0011（AgentDesk 退役，ADR-019）：drop AgentDesk 数据层五表。

harness 自研内核（Node sidecar，前端直连 /api/harness）取代 agentdesk_bridge
引擎后，AgentDesk 执行域数据层整体退役：

- drop：agent_tasks / task_events / approvals / always_allowed / agent_hunks
  五表（0008/0009 建立的数据层）与 chat_messages.task_id 归属列（0010）；
- 存量矫正：agent_profiles.engine_kind 'agentdesk_bridge' → 'harness'（seed 幂等
  get-or-create 不覆盖已有行，旧库存量行由本迁移统一迁移到新枚举）；
- 保留：agent_profiles / chat_messages / chat_sessions.profile_key 等
  workbench 渠道层结构（统一工作台继续使用）；
- downgrade 按 0008/0009/0010 原定义重建五表与 task_id 列（结构可回滚，
  已删数据不可恢复）；存量审计事件中的 agentdesk.* 动作由
  guardrails.audit.AUDIT_ACTIONS 常量继续解释，不依赖本批表。
"""

from alembic import op
import sqlalchemy as sa

revision = "0011_drop_agentdesk"
down_revision = "0010_workbench"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 存量矫正：agentdesk_bridge 枚举值随引擎退役取消，存量 Profile 统一迁移到 harness
    op.execute(
        "UPDATE agent_profiles SET engine_kind = 'harness' WHERE engine_kind = 'agentdesk_bridge'"
    )

    # chat_messages.task_id：FK 指向 agent_tasks，先摘列再删主表
    op.drop_index("ix_chat_messages_task_id", table_name="chat_messages")
    op.drop_column("chat_messages", "task_id")

    # 依赖 agent_tasks 的四表先删（FK ondelete=CASCADE 指向主表）
    op.drop_index("ix_agent_hunks_task_id", table_name="agent_hunks")
    op.drop_table("agent_hunks")
    op.drop_table("task_events")
    op.drop_index("ix_approvals_status", table_name="approvals")
    op.drop_index("ix_approvals_task_id", table_name="approvals")
    op.drop_table("approvals")
    op.drop_index("ix_always_allowed_user_id", table_name="always_allowed")
    op.drop_table("always_allowed")

    # 主表最后（status / created_by / chat_session_id 索引显式摘除后再删表）
    op.drop_index("ix_agent_tasks_chat_session_id", table_name="agent_tasks")
    op.drop_index("ix_agent_tasks_created_by", table_name="agent_tasks")
    op.drop_index("ix_agent_tasks_status", table_name="agent_tasks")
    op.drop_table("agent_tasks")


def downgrade() -> None:
    # 枚举反向矫正：0010 时点不存在 engine_kind='harness' 的行，本迁移改出的行可精确还原
    op.execute(
        "UPDATE agent_profiles SET engine_kind = 'agentdesk_bridge' WHERE engine_kind = 'harness'"
    )

    # ---- agent_tasks（0008 原定义 + 0009 队列列 + 0010 归属列，逐字重建）----
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
    op.add_column(
        "agent_tasks",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_tasks", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "agent_tasks",
        sa.Column(
            "chat_session_id",
            sa.Uuid(),
            sa.ForeignKey("chat_sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_agent_tasks_chat_session_id", "agent_tasks", ["chat_session_id"])

    # ---- task_events / approvals / always_allowed（0008 原定义）----
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

    # ---- agent_hunks（0009 原定义）----
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

    # ---- chat_messages.task_id 加回（0010 原定义）----
    op.add_column(
        "chat_messages",
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey("agent_tasks.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_chat_messages_task_id", "chat_messages", ["task_id"])
