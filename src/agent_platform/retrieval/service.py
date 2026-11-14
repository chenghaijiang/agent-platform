"""检索核心（T06）：双路召回合并去重，ACL 过滤进 SQL/查询层（ADR-007，MVP 三项 Guardrails 之一）。

可见性口径与 T04 的 GET /api/admin/roles/{role}/kbs 严格一致：均来自 kb_acls 表。
不可见知识库的 chunks 不进入候选（kb_id IN (visible) 在 SQL WHERE 层过滤）；
显式请求不可见知识库直接抛 RetrievalPermissionError（API 层 403），不静默降级。
"""

import logging
import time
import uuid
from dataclasses import dataclass

from langfuse import observe
from sqlalchemy import or_, select
from sqlalchemy.exc import DataError
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import (
    IngestTask,
    KbChunk,
    KnowledgeBase,
    KnowledgeBaseAcl,
    Role,
)

logger = logging.getLogger("agent_platform.retrieval")

DEFAULT_TOP_K = 5
MAX_TOP_K = 20


class RetrievalPermissionError(Exception):
    """请求了当前身份不可见的知识库：明确拒绝，不静默降级（ADR-007）。"""

    def __init__(self, denied_kb_ids: list[str]) -> None:
        self.denied_kb_ids = denied_kb_ids
        super().__init__(f"kb not visible for role: {denied_kb_ids}")


class EmbeddingDimensionMismatchError(Exception):
    """已入库向量与当前 embedding 模型维度不一致（切换模型后未清空重建）。"""

    def __init__(self) -> None:
        super().__init__(
            "已入库向量与当前 embedding 模型维度不一致："
            "切换模型后需清空向量重建（TRUNCATE kb_chunks, ingest_tasks 后重新上传文档）"
        )


@dataclass(frozen=True)
class RetrievedChunk:
    """可直接渲染为引用来源的结构化结果。"""

    chunk_id: str
    kb_id: str
    kb_name: str
    document: str  # 来源文档文件名（ingest_tasks.source_filename）
    heading_path: str | None
    content: str
    classification: str
    score: float  # 统一分值：向量路 = 1 - 余弦距离；关键词路 = 命中词占比
    sources: tuple[str, ...]  # ("vector",) / ("keyword",) / ("vector", "keyword")


@dataclass(frozen=True)
class RetrievalResult:
    query: str
    results: list[RetrievedChunk]
    latency_ms: int
    embedding_model: str
    visible_kb_count: int  # 本次实际参与召回的知识库数（ACL 范围）


class RetrievalService:
    """无状态服务：持有模型网关（query 向量化），其余全部依赖注入。"""

    def __init__(self, gateway) -> None:
        self._gateway = gateway  # duck type: embed(texts) -> EmbedResult

    async def visible_kb_ids(self, session: AsyncSession, auth_ctx: AuthContext) -> list[uuid.UUID]:
        """当前角色可见的知识库（与 T04 可见性查询同一数据源：kb_acls）。"""
        rows = await session.scalars(
            select(KnowledgeBaseAcl.kb_id)
            .join(Role, Role.id == KnowledgeBaseAcl.role_id)
            .where(Role.name == auth_ctx.role)
        )
        return list(rows.all())

    @observe(name="retrieval.search")
    async def search(
        self,
        session: AsyncSession,
        auth_ctx: AuthContext,
        query: str,
        *,
        kb_ids: list[str] | None = None,
        top_k: int = DEFAULT_TOP_K,
    ) -> RetrievalResult:
        """双路召回主入口：可见范围解析 → 向量路 + 关键词路 → 合并去重排序。"""
        started = time.perf_counter()
        top_k = max(1, min(top_k, MAX_TOP_K))
        visible = await self.visible_kb_ids(session, auth_ctx)

        scope = visible
        if kb_ids:
            requested = [uuid.UUID(kb) for kb in kb_ids]
            denied = [str(kb) for kb in requested if kb not in visible]
            if denied:
                # T08：越权检索的拦截记录（ADR-007：拒绝不静默，审计可查）
                from agent_platform.guardrails.audit import record_event

                await record_event(
                    session,
                    user_id=auth_ctx.user_id,
                    username=auth_ctx.username,
                    action="retrieval.denied",
                    object_type="knowledge_base",
                    object_id=",".join(denied),
                    outcome="blocked",
                    detail={"denied_kb_ids": denied},
                )
                raise RetrievalPermissionError(denied)
            scope = [kb for kb in requested if kb in visible]

        words = [w for w in query.split() if w.strip()] or [query.strip()]
        embed_result = await self._gateway.embed([query])

        vector_hits = await self._vector_candidates(session, scope, embed_result.vectors[0], top_k)
        keyword_hits = await self._keyword_candidates(session, scope, words, top_k)
        merged = self._merge(vector_hits, keyword_hits, top_k)

        latency_ms = int((time.perf_counter() - started) * 1000)
        logger.info(
            "retrieval role=%s query=%r scope=%d top_k=%d vector=%d keyword=%d returned=%d %dms",
            auth_ctx.role,
            query,
            len(scope),
            top_k,
            len(vector_hits),
            len(keyword_hits),
            len(merged),
            latency_ms,
        )
        return RetrievalResult(
            query=query,
            results=merged,
            latency_ms=latency_ms,
            embedding_model=embed_result.model,
            visible_kb_count=len(scope),
        )

    async def _vector_candidates(
        self, session: AsyncSession, kb_ids: list[uuid.UUID], vector: list[float], top_k: int
    ) -> list[tuple[str, KbChunk, str, str, float]]:
        """向量路：pgvector 余弦距离排序。kb_id IN 过滤即 ACL 查询层过滤。"""
        if not kb_ids:
            return []
        distance = KbChunk.embedding.cosine_distance(vector)
        try:
            rows = (
                await session.execute(
                    select(KbChunk, IngestTask.source_filename, KnowledgeBase.name, distance)
                    .join(IngestTask, IngestTask.id == KbChunk.task_id)
                    .join(KnowledgeBase, KnowledgeBase.id == KbChunk.kb_id)
                    .where(KbChunk.kb_id.in_(kb_ids))
                    .order_by(distance)
                    .limit(top_k)
                )
            ).all()
        except DataError as exc:
            # pgvector 对维度不匹配的向量距离计算直接报错（如 fake 1536 维与 Ollama 1024 维混存）：
            # 翻译成可操作的领域错误，而不是让 API 层裸 500
            if "different vector dimensions" in str(exc):
                raise EmbeddingDimensionMismatchError() from None
            raise
        return [
            ("vector", chunk, filename, kb_name, 1.0 - dist)
            for chunk, filename, kb_name, dist in rows
        ]

    async def _keyword_candidates(
        self, session: AsyncSession, kb_ids: list[uuid.UUID], words: list[str], top_k: int
    ) -> list[tuple[str, KbChunk, str, str, float]]:
        """关键词路：MVP 用 ILIKE（中文无分词器，ILIKE 对中文子串友好）。

        score = 命中词数 / 查询词数（0-1），多词全中优先。
        """
        if not kb_ids or not any(words):
            return []
        rows = (
            await session.execute(
                select(KbChunk, IngestTask.source_filename, KnowledgeBase.name)
                .join(IngestTask, IngestTask.id == KbChunk.task_id)
                .join(KnowledgeBase, KnowledgeBase.id == KbChunk.kb_id)
                .where(
                    KbChunk.kb_id.in_(kb_ids),
                    or_(*[KbChunk.content.ilike(f"%{w}%") for w in words if w]),
                )
                .order_by(KbChunk.created_at)
                .limit(top_k * 2)  # 候选放宽，命中计分后取 top_k
            )
        ).all()
        hits: list[tuple[str, KbChunk, str, str, float]] = []
        for chunk, filename, kb_name in rows:
            matched = sum(1 for w in words if w and w.lower() in chunk.content.lower())
            hits.append(("keyword", chunk, filename, kb_name, matched / len([w for w in words if w])))
        hits.sort(key=lambda h: h[4], reverse=True)
        return hits[:top_k]

    @staticmethod
    def _merge(
        vector_hits: list[tuple[str, KbChunk, str, str, float]],
        keyword_hits: list[tuple[str, KbChunk, str, str, float]],
        top_k: int,
    ) -> list[RetrievedChunk]:
        """按 chunk 去重合并：score 取两路最大值，sources 取并集；按 score 降序取 top_k。"""
        by_id: dict[uuid.UUID, dict] = {}
        for source, chunk, filename, kb_name, score in [*vector_hits, *keyword_hits]:
            entry = by_id.get(chunk.id)
            if entry is None:
                by_id[chunk.id] = {
                    "chunk": chunk,
                    "filename": filename,
                    "kb_name": kb_name,
                    "score": score,
                    "sources": {source},
                }
            else:
                entry["score"] = max(entry["score"], score)
                entry["sources"].add(source)

        ordered = sorted(by_id.values(), key=lambda e: e["score"], reverse=True)[:top_k]
        return [
            RetrievedChunk(
                chunk_id=str(e["chunk"].id),
                kb_id=str(e["chunk"].kb_id),
                kb_name=e["kb_name"],
                document=e["filename"],
                heading_path=e["chunk"].heading_path,
                content=e["chunk"].content,
                classification=e["chunk"].classification,
                score=round(e["score"], 4),
                sources=tuple(sorted(e["sources"])),
            )
            for e in ordered
        ]
