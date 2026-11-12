"""迁移 0004（T05）：入库任务表 + 知识块向量表（pgvector）。

任务模型（ADR-005）：状态机五态（queued/running/succeeded/failed/dead）、
租约（lease_expires_at，到期未续约可被重新认领）、重试计数（attempt/max_attempts）、
幂等（kb_id + content_hash）。chunks.embedding 用无维度 vector 列：
MVP 数据量小不做 ivfflat 索引，且允许切换不同维度的 embedding 模型。
"""

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

revision = "0004_ingestion"
down_revision = "0003_kb_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ingest_tasks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kb_id", sa.Uuid(), sa.ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("source_filename", sa.String(256), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("object_key", sa.String(512), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ingest_tasks_status", "ingest_tasks", ["status"])
    op.create_index("ix_ingest_tasks_kb_id", "ingest_tasks", ["kb_id"])

    op.create_table(
        "kb_chunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kb_id", sa.Uuid(), sa.ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False),
        sa.Column("task_id", sa.Uuid(), sa.ForeignKey("ingest_tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("heading_path", sa.String(512), nullable=True),
        sa.Column("classification", sa.String(16), nullable=False, server_default="internal"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("embedding", Vector(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("kb_id", "task_id", "chunk_index", name="uq_kb_chunks_task_index"),
    )
    op.create_index("ix_kb_chunks_kb_id", "kb_chunks", ["kb_id"])


def downgrade() -> None:
    op.drop_index("ix_kb_chunks_kb_id", table_name="kb_chunks")
    op.drop_table("kb_chunks")
    op.drop_index("ix_ingest_tasks_kb_id", table_name="ingest_tasks")
    op.drop_index("ix_ingest_tasks_status", table_name="ingest_tasks")
    op.drop_table("ingest_tasks")
