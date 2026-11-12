"""baseline: 空基线迁移，验证迁移工具链（T01）

Revision ID: 0001_baseline
Revises:
Create Date: 2026-11-12

"""

from collections.abc import Sequence

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # T01 仅验证迁移链路；首个业务表结构（用户/角色/ACL）由 T02 引入
    pass


def downgrade() -> None:
    pass
