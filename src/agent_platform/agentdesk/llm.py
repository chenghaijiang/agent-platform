"""Agent 模型调用抽象（T13，ADR-012 面向接口）。

Agent Graph 不直接依赖 ModelGateway，只依赖 LLMInvoker 协议：
- GatewayInvoker：生产实现，经模型网关 chat_tools（真实 tool-calling key）；
- ScriptedInvoker：单测与容器冒烟实现，按脚本回放工具调用（验收硬指标「模型层 mock」），
  同时可加延迟/故障注入后续扩展。

两层协议中的模型协议在此收口：图内只见到 content/tool_calls/usage 三个解耦概念。
"""

from dataclasses import dataclass, field
from typing import Protocol

from agent_platform.model_gateway.gateway import ModelGateway


@dataclass(frozen=True)
class InvokerToolCall:
    """一次工具调用（Graph 状态里的通用形态，与网关 ToolCall 解耦）。"""

    id: str
    name: str
    args: dict


@dataclass(frozen=True)
class LLMResponse:
    """模型一轮输出：叙述文本（delta 事件源）+ 工具调用列表 + token 用量。"""

    content: str
    tool_calls: list[InvokerToolCall] = field(default_factory=list)
    total_tokens: int = 0


class LLMInvoker(Protocol):
    """Agent 工具循环的模型出口协议：生产走网关，测试走脚本回放。"""

    async def invoke(self, messages: list[dict], tools: list[dict]) -> LLMResponse: ...


class GatewayInvoker:
    """经模型网关的 tool-calling 实现（统一出口原则，Langfuse 自动上报）。"""

    def __init__(self, gateway: ModelGateway) -> None:
        self._gateway = gateway

    async def invoke(self, messages: list[dict], tools: list[dict]) -> LLMResponse:
        result = await self._gateway.chat_tools(messages, tools)
        return LLMResponse(
            content=result.content,
            tool_calls=[
                InvokerToolCall(id=c.id, name=c.name, args=c.args) for c in result.tool_calls
            ],
            total_tokens=result.usage.get("total_tokens", 0),
        )


class ScriptedInvoker:
    """脚本回放实现（T13 验收「模型层 mock」）：按序返回预置轮次，记录调用输入。

    脚本耗尽后再调用会抛 RuntimeError——防止测试脚本覆盖不到的路径静默通过。
    """

    def __init__(self, turns: list[LLMResponse]) -> None:
        self._turns = list(turns)
        self.calls: list[dict] = []

    async def invoke(self, messages: list[dict], tools: list[dict]) -> LLMResponse:
        self.calls.append({"messages": messages, "tools": tools})
        if not self._turns:
            raise RuntimeError("scripted invoker exhausted: test script has no more turns")
        return self._turns.pop(0)
