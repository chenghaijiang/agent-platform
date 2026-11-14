"""迁移 0010（统一工作台一期，ADR-014/015/016/017）：智能体 Profile + 聊天消息流水 + 会话/任务归属。

- agent_profiles：智能体预设（ADR-014 决策 1 / ADR-016 决策 1）。prompt_key 软引用
  prompt_versions 发布体系（ADR-010），不内嵌模板；engine_kind 一期枚举
  qa_graph | agentdesk_bridge | runtime（runtime 为二期自研内核预留位）；
  model_policy 为 JSON（{primary, fallbacks: []}，null 回落全局 MODEL_CHAT_MODEL）；
  tool_whitelist 为 JSON 数组字符串（null = 该引擎注册的全部工具）；
- chat_messages：会话级消息流水（ADR-015 决策 5）：`{seq, type, data, task_id}` 信封落库，
  (session_id, seq) 唯一做 SSE Last-Event-ID 续传游标；卡片消息可查询、可回放，
  checkpointer 继续只管 QA 图执行态；
- agent_tasks.chat_session_id：统一工作台归属外键（ADR-015 决策 4：会话 1↔N Task，
  仅归属不改域分治；会话删除置空，任务留档）；
- chat_sessions.profile_key：会话级绑定智能体（ADR-014 决策 3）。软引用
  agent_profiles.key，null = knowledge-assistant（存量会话零迁移）。
"""

import sqlalchemy as sa

from alembic import op

revision = "0010_workbench"
down_revision = "0009_hunks_queue"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_profiles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("key", sa.String(64), nullable=False, unique=True),
        sa.Column("display_name", sa.String(64), nullable=False),
        sa.Column("description", sa.String(256), nullable=True),
        # 软引用 prompt_versions.template_key（发布体系唯一键），不建 FK：发布版本与 profile 生命周期独立
        sa.Column("prompt_key", sa.String(64), nullable=True),
        # JSON 数组字符串，如 ["read_files","run_command"]；null = 引擎注册的全部工具
        sa.Column("tool_whitelist", sa.Text(), nullable=True),
        # 一期引擎枚举：qa_graph（现有 RAG 图）| agentdesk_bridge（桥接 AgentDesk 图）| runtime（二期预留）
        sa.Column("engine_kind", sa.String(32), nullable=False, server_default="qa_graph"),
        # 缺省执行模式（AGENT_TASK_MODES 四档）；QA 类智能体无工具执行，null
        sa.Column("default_mode", sa.String(16), nullable=True),
        # JSON：{primary, fallbacks: []}；null 回落全局 MODEL_CHAT_MODEL 映射（ADR-016 决策 2）
        sa.Column("model_policy", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id", sa.Uuid(), sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("seq", sa.Integer(), nullable=False),  # 会话内单调递增，SSE Last-Event-ID 游标
        # 消息信封类型（ADR-014 决策 4）：text / agent_event / approval_card
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("data", sa.Text(), nullable=True),  # JSON 对象字符串
        # 归属 Agent 任务（会话 1↔N Task）；任务删除置空，消息流水留档
        sa.Column(
            "task_id",
            sa.Uuid(),
            sa.ForeignKey("agent_tasks.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("session_id", "seq", name="uq_chat_messages_session_seq"),
    )
    op.create_index("ix_chat_messages_session_id", "chat_messages", ["session_id"])
    op.create_index("ix_chat_messages_task_id", "chat_messages", ["task_id"])

    # 统一工作台归属（ADR-015 决策 4）：仅归属外键，Agent 域 / 渠道层分治不变
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

    # 会话级绑定智能体（ADR-014 决策 3）：软引用 agent_profiles.key；null = knowledge-assistant
    op.add_column("chat_sessions", sa.Column("profile_key", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "profile_key")
    op.drop_index("ix_agent_tasks_chat_session_id", table_name="agent_tasks")
    op.drop_column("agent_tasks", "chat_session_id")
    op.drop_index("ix_chat_messages_task_id", table_name="chat_messages")
    op.drop_index("ix_chat_messages_session_id", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_table("agent_profiles")
