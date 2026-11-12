"""迁移 0003（T04）：知识库元数据表 + 补 kb_acls.kb_id 外键。

- 新建 knowledge_bases（名称唯一、密级、可见范围描述、索引版本预留）
- kb_acls.kb_id 从独立列升级为指向 knowledge_bases.id 的外键（KB 删除级联清理 ACL）
"""

from alembic import op
import sqlalchemy as sa

revision = "0003_kb_metadata"
down_revision = "0002_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_bases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False, unique=True),
        sa.Column("classification", sa.String(16), nullable=False, server_default="internal"),
        sa.Column("description", sa.String(512), nullable=True),
        sa.Column("index_version", sa.String(16), nullable=False, server_default="v1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    # T02 预留：kb_acls.kb_id 补外键（表为空，可直接加约束）；KB 删除时级联清理授权
    op.create_foreign_key(
        "fk_kb_acls_kb", "kb_acls", "knowledge_bases", ["kb_id"], ["id"], ondelete="CASCADE"
    )
    op.create_index("ix_kb_acls_kb_id", "kb_acls", ["kb_id"])


def downgrade() -> None:
    op.drop_index("ix_kb_acls_kb_id", table_name="kb_acls")
    op.drop_constraint("fk_kb_acls_kb", "kb_acls", type_="foreignkey")
    op.drop_table("knowledge_bases")
