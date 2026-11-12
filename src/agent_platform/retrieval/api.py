"""检索 API（T06）：POST /api/search——普通登录用户可用，ACL 越权明确 403。"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.retrieval.service import (
    MAX_TOP_K,
    RetrievalPermissionError,
    RetrievalService,
)

router = APIRouter(tags=["retrieval"])


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=512)
    kb_ids: list[str] | None = Field(default=None, description="限定知识库范围；缺省=角色可见全部")
    top_k: int = Field(default=5, ge=1, le=MAX_TOP_K)


def get_retrieval_service(request: Request) -> RetrievalService:
    return request.app.state.retrieval_service


@router.post("/api/search")
async def search(
    payload: SearchRequest,
    auth: AuthContext = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
    service: RetrievalService = Depends(get_retrieval_service),
) -> dict:
    """在线检索：双路召回 + ACL 过滤，返回可直接渲染的引用结构。"""
    try:
        result = await service.search(session, auth, payload.query, kb_ids=payload.kb_ids, top_k=payload.top_k)
    except RetrievalPermissionError as exc:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "requested knowledge bases are not visible for your role",
                "denied_kb_ids": exc.denied_kb_ids,
            },
        ) from None

    return {
        "query": result.query,
        "latency_ms": result.latency_ms,
        "embedding_model": result.embedding_model,
        "visible_kb_count": result.visible_kb_count,
        "results": [
            {
                "chunk_id": r.chunk_id,
                "kb_id": r.kb_id,
                "kb_name": r.kb_name,
                "document": r.document,
                "heading_path": r.heading_path,
                "content": r.content,
                "classification": r.classification,
                "classification_label": _label(r.classification),
                "score": r.score,
                "sources": list(r.sources),
            }
            for r in result.results
        ],
    }


def _label(classification: str) -> str:
    from agent_platform.db.models import KB_CLASSIFICATION_LABELS

    return KB_CLASSIFICATION_LABELS.get(classification, classification)
