"""模型调用错误恢复（ADR-016 决策 2）：限次重试 → fallback 链换模型。

一期实现范围（如实声明）：
- 仅流式生成（stream_chat）的**连接级**故障转移——首帧前失败可换模重试；
  首帧已流出后的中途失败不再换模（半截回答无法安全回收，如实抛给调用方）；
- 非流式 chat / chat_tools 的换模重试归二期自研内核（工具循环需要整轮重放语义，
  换模会改变 tool_calls 行为，不宜静默重放）。

on_fallback 回调由调用方接线审计（workbench 层记录 model 命中链，ADR-016：
审计与 usage 记录实际命中的模型——网关层本身已上报 usage/latency，这里补换模审计）。
"""

from collections.abc import AsyncIterator, Awaitable, Callable

from agent_platform.model_gateway.errors import ModelGatewayError
from agent_platform.model_gateway.gateway import ModelGateway

# 换模审计钩子：(from_model, to_model, error) —— None 表示全局映射位
FallbackHook = Callable[[str | None, str | None, str], Awaitable[None]]


async def stream_chat_with_fallback(
    gateway: ModelGateway,
    messages: list[dict],
    models: list[str | None],
    *,
    max_attempts_per_model: int = 2,
    on_fallback: FallbackHook | None = None,
) -> AsyncIterator[str]:
    """按模型链流式生成：每模限次重试 → 首帧前失败换下一模；链尽抛最后错误。

    models 为空按 [None]（全局映射）处理；None 元素只在首位有意义（primary 缺省）。
    """
    chain = list(models) or [None]
    last_error: ModelGatewayError | None = None
    for index, model in enumerate(chain):
        next_model = chain[index + 1] if index + 1 < len(chain) else None
        for _attempt in range(max_attempts_per_model):
            started = False
            try:
                async for delta in gateway.stream_chat(messages, model=model):
                    started = True
                    yield delta
                return
            except ModelGatewayError as exc:
                if started:
                    # 中途失败：半截流不可换模回收，如实上抛（SSE 层转 error 帧）
                    raise
                last_error = exc
        if next_model is not None and on_fallback is not None:
            await on_fallback(model, next_model, f"{type(last_error).__name__}: {last_error}")
    if last_error is not None:
        raise last_error
    raise ModelGatewayError(  # pragma: no cover - 空链已被 [None] 兜底，防御性分支
        "model chain exhausted without error", capability="chat", model=""
    )
