"""agent-harness 网关（ADR-019）：统一认证收口 + 反向代理 Node sidecar。

harness 协议服务器是本地信任世界观（无认证、单实例、默认绑 127.0.0.1），平台集成后
由本网关把「平台登录态」转换为「可访问性」：

- 路由形态：/api/harness/{path} → {HARNESS_BASE_URL}/{path}（方法/查询串/请求体原样转发）；
- 认证：require_auth 依赖——未登录/失效一律 401；token 不透传上游（上游不校验，避免
  平台凭证扩散到 sidecar 日志）；
- SSE：text/event-stream 响应以 StreamingResponse 透传（前端用 fetch 流式消费并携带
  Bearer 头——EventSource 无法自定义 header，平台与 harness 前端同模式）；
- 上游不可达：统一 502，工作台连接状态条如实降级（harness 自身 degraded 状态由
  /api/health 快照表达，不在此处翻译）。

生命周期：httpx.AsyncClient 由 main.lifespan 创建挂 app.state.harness_client（连接池
复用；SSE 读超时置 None 防长连接被掐）。测试可注入 MockTransport/ASGITransport 替身。
"""

from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext

router = APIRouter(prefix="/api/harness", tags=["harness"])

# RFC 7230 §6.1：逐跳头不出现代理边界
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
# 响应侧额外剔除：httpx 自动解压后 content-encoding/content-length 与转发体不再匹配；
# authorization/cookie 属平台凭证，不到 sidecar（上游无认证）
_STRIP_REQUEST = _HOP_BY_HOP | {"host", "content-length", "authorization", "cookie"}
_STRIP_RESPONSE = _HOP_BY_HOP | {"content-length", "content-encoding"}


def get_upstream_client(request: Request) -> httpx.AsyncClient:
    """取 lifespan 预建的共享客户端；缺失即装配错误（fail fast，而非每次请求新建）。"""
    client = getattr(request.app.state, "harness_client", None)
    if client is None:  # pragma: no cover - lifespan 装配固定存在，防御性兜底
        raise RuntimeError("harness upstream client not initialised (main.lifespan)")
    return client


def _filter_headers(headers, strip: frozenset[str]) -> dict[str, str]:
    return {k: v for k, v in headers.items() if k.lower() not in strip}


async def _proxy(request: Request, path: str) -> Response:
    """透传单请求：stream 模式拿响应头后再决定流式（SSE）或整体回读，无双重请求。"""
    client = get_upstream_client(request)
    body = await request.body()
    upstream_req = client.build_request(
        request.method,
        f"/{path}",
        params=request.query_params,
        headers=_filter_headers(request.headers, _STRIP_REQUEST),
        content=body if body else None,
    )
    try:
        upstream_resp = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"harness 服务不可达：{exc}") from exc

    resp_headers = _filter_headers(upstream_resp.headers, _STRIP_RESPONSE)
    content_type = upstream_resp.headers.get("content-type", "")

    if "text/event-stream" in content_type:
        async def relay() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream_resp.aiter_raw():
                    yield chunk
            finally:
                # 客户端断开（CancelledError）或流尽：释放上游连接
                await upstream_resp.aclose()

        return StreamingResponse(
            relay(),
            status_code=upstream_resp.status_code,
            headers=resp_headers,
            media_type=content_type or None,
        )

    payload = await upstream_resp.aread()
    await upstream_resp.aclose()
    return Response(
        content=payload,
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        media_type=content_type or None,
    )


@router.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(
    path: str,
    request: Request,
    auth: AuthContext = Depends(require_auth),  # noqa: ARG001 - 认证即门禁，上下文本身不参与转发
) -> Response:
    """catch-all 反代：方法/查询串/请求体/响应头原样透传，认证在依赖层先行拦截。"""
    return await _proxy(request, path)
