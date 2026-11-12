"""迁移 0007（T10，ADR-009）：Prompt 版本表。

模板结构存仓库 prompts/ 目录；可发布版本入 PG（版本号按 template_key 单调递增，
同键+版本唯一；状态 draft/published/archived，历史版本不可篡改——不提供任何
UPDATE 路径，发布即封版）。
"""

from alembic import op
import sqlalchemy as sa

revision = "0007_prompts"
down_revision = "0006_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "prompt_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("template_key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column(
            "status", sa.String(16), nullable=False, server_default="draft"
        ),  # draft / published / archived
        sa.Column("template", sa.Text(), nullable=False),
        sa.Column("change_note", sa.String(256), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("template_key", "version", name="uq_prompt_key_version"),
    )
    op.create_index("ix_prompt_versions_key", "prompt_versions", ["template_key"])
    op.create_index("ix_prompt_versions_status", "prompt_versions", ["status"])


def downgrade() -> None:
    op.drop_index("ix_prompt_versions_status", table_name="prompt_versions")
    op.drop_index("ix_prompt_versions_key", table_name="prompt_versions")
    op.drop_table("prompt_versions")
