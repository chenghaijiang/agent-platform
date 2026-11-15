"""迁移 0012（ADR-019）：chat_sessions.hw_trace_ids——harness turn 索引服务端化。

统一工作台 Agent 会话的回放映射（traceId ↔ 会话）原本仅存浏览器 localStorage
（zs_hw_traces），换浏览器/清站点数据后历史无法回放——sidecar transcript 仍在
（/root/.harness/sessions/*.jsonl），缺的只是归属索引。

本迁移把映射持久化到会话行：JSON 数组字符串（["<traceId>", ...]，保序去重），
经 GET/POST /api/workbench/sessions/{id}/hw-traces 读写（幂等追加）。
前端打开 Agent 会话时先合并服务端映射再连 events 流；sendAgentTurn 登记
traceId 后异步补报。null = 无 harness turn（QA 会话或旧数据）。
"""

import sqlalchemy as sa

from alembic import op

revision = "0012_hw_trace_ids"
down_revision = "0011_drop_agentdesk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("hw_trace_ids", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "hw_trace_ids")
