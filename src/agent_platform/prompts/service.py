"""Prompt 版本服务（T10，ADR-009）：草稿创建 / 发布（封版）/ 当前版本查询。

不可篡改语义：不提供任何模板修改路径——发布即封版，改内容只能创建新版本号。
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.db.models import PromptVersion

PROMPT_CHAT_QA = "chat_qa"


class PromptPublishError(Exception):
    """发布违规：重复发布已发布版本等。"""


async def create_draft(
    session: AsyncSession,
    *,
    template_key: str,
    template: str,
    change_note: str | None = None,
) -> PromptVersion:
    """创建草稿：版本号 = 同键当前最大版本 + 1（单调递增，含已归档版本）。"""
    max_version = await session.scalar(
        select(PromptVersion.version)
        .where(PromptVersion.template_key == template_key)
        .order_by(PromptVersion.version.desc())
        .limit(1)
    )
    prompt = PromptVersion(
        template_key=template_key,
        version=(max_version or 0) + 1,
        status="draft",
        template=template,
        change_note=change_note,
    )
    session.add(prompt)
    await session.commit()
    await session.refresh(prompt)
    return prompt


async def publish(session: AsyncSession, prompt_id: uuid.UUID) -> PromptVersion:
    """发布草稿：原子置 published 并把同键其它 published 归档（当前生效版本唯一）。"""
    prompt = await session.get(PromptVersion, prompt_id)
    if prompt is None:
        raise LookupError(f"prompt version {prompt_id} not found")
    if prompt.status != "draft":
        raise PromptPublishError(
            f"version {prompt.version} is {prompt.status}, only draft can be published"
        )
    # 同键当前发布版 → archived
    current = await session.scalars(
        select(PromptVersion).where(
            PromptVersion.template_key == prompt.template_key,
            PromptVersion.status == "published",
        )
    )
    for row in current.all():
        row.status = "archived"
    prompt.status = "published"
    prompt.published_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(prompt)
    return prompt


async def get_current(session: AsyncSession, template_key: str) -> PromptVersion | None:
    """当前已发布版本（同键唯一）；无发布版本返回 None（链路用代码默认兜底）。"""
    return await session.scalar(
        select(PromptVersion)
        .where(PromptVersion.template_key == template_key, PromptVersion.status == "published")
        .order_by(PromptVersion.version.desc())
        .limit(1)
    )


async def list_versions(session: AsyncSession, template_key: str | None = None) -> list[PromptVersion]:
    query = select(PromptVersion)
    if template_key:
        query = query.where(PromptVersion.template_key == template_key)
    rows = await session.scalars(query.order_by(PromptVersion.template_key, PromptVersion.version))
    return list(rows.all())


def serialize(prompt: PromptVersion) -> dict:
    return {
        "id": str(prompt.id),
        "template_key": prompt.template_key,
        "version": prompt.version,
        "status": prompt.status,
        "template": prompt.template,
        "change_note": prompt.change_note,
        "created_at": prompt.created_at.isoformat() if prompt.created_at else None,
        "published_at": prompt.published_at.isoformat() if prompt.published_at else None,
    }
