"""问答执行图（T07）：LangGraph 检索节点 → 生成节点，Checkpointer 跨轮持久化。

- 多轮上下文：messages 经 add_messages reducer 累积，由 checkpointer 按 thread_id 持久化；
  重启后同 thread_id invoke 自动恢复历史（验收硬指标）
- 流式：流式出口收敛到治理中间件——生成节点只产出完整 answer，
  output_guard 审查后按片推入 configurable 传入的 asyncio.Queue（T08）
- 无依据兜底：本轮 0 条引用时不调用模型，返回固定话术，不编造（ADR-007）
- 治理（T08）：节点由 guardrails.input_guard / output_guard 包装，
  本文件不含脱敏/审计逻辑（治理代码集中在 guardrails 包）
- Prompt（T10）：system 模板经 config.configurable["system_prompt"] 注入
  （由 API 层读取 PG 当前已发布版本），无发布版本时用代码内默认兜底
"""

from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent_platform.auth.provider import AuthContext
from agent_platform.guardrails.audit import record_event
from agent_platform.guardrails.middleware import input_guard, output_guard
from agent_platform.model_gateway.resilience import stream_chat_with_fallback

# 无依据兜底话术（验收硬指标：不编造）
NO_EVIDENCE_ANSWER = "知识库中未找到与您问题相关的依据，暂时无法回答。请联系管理员确认相关文档是否已入库。"

SYSTEM_WITH_EVIDENCE = (
    "你是企业知识问答助手。请只依据下面提供的知识库引用回答用户问题，"
    "并在回答中用 [编号] 标注所引用的条目；若引用不足以回答，请明确说明依据不足。"
)


class ChatState(TypedDict):
    """问答执行态。messages 跨轮累积（checkpointer 持久化）；question/citations/answer 每轮覆盖。"""

    question: str
    messages: Annotated[list, add_messages]
    citations: list[dict]
    answer: str


def _llm_messages(history: list, citations: list[dict], system_prompt: str) -> list[dict]:
    """拼装模型输入：system（发布版模板填充 {context} 可变区）+ 历史对话（含本轮提问）。"""
    context = "\n\n".join(
        f"[{i + 1}] （来源文档 {c['document']} · 知识库 {c['kb_name']} · 密级 {c['classification']}）\n{c['content']}"
        for i, c in enumerate(citations)
    )
    if "{context}" in system_prompt:
        system = system_prompt.replace("{context}", context)
    else:  # 兜底模板无占位符（代码默认），按旧格式拼接
        system = f"{system_prompt}\n\n知识库引用：\n{context}"
    messages = [{"role": "system", "content": system}]
    for m in history:
        role = "user" if isinstance(m, HumanMessage) else "assistant"
        content = m.content if isinstance(m.content, str) else str(m.content)
        messages.append({"role": role, "content": content})
    return messages


def build_chat_graph(*, session_factory, retrieval, gateway, checkpointer):
    """构建问答执行图。

    重资源依赖（会话工厂/检索服务/模型网关）构建时闭包捕获；
    请求级数据（auth/流式队列/top_k）经 config.configurable 传递（不入 checkpoint）。
    """

    async def retrieve(state: ChatState, config) -> dict:
        auth: AuthContext = config["configurable"]["auth_ctx"]
        top_k = config["configurable"].get("top_k", 5)
        async with session_factory() as session:
            result = await retrieval.search(session, auth, state["question"], top_k=top_k)
        citations = [
            {
                "chunk_id": r.chunk_id,
                "kb_id": r.kb_id,
                "kb_name": r.kb_name,
                "document": r.document,
                "heading_path": r.heading_path,
                "content": r.content,
                "classification": r.classification,
                "score": r.score,
                "sources": list(r.sources),
            }
            for r in result.results
        ]
        return {"citations": citations}

    async def generate(state: ChatState, config) -> dict:
        """生成节点：纯产出完整回答；流式推帧由 output_guard 中间件统一负责。

        model_chain（统一工作台一期，ADR-016）：经 configurable 注入 [primary, *fallbacks]；
        未注入时与原行为严格一致（gateway 全局映射，存量链路零感知）。
        """

        # 无依据兜底：不调用模型（验收：0 条引用不编造）
        if not state["citations"]:
            return {"answer": NO_EVIDENCE_ANSWER, "messages": [AIMessage(content=NO_EVIDENCE_ANSWER)]}

        llm_input = _llm_messages(
            state["messages"],
            state["citations"],
            config["configurable"].get("system_prompt") or SYSTEM_WITH_EVIDENCE,
        )
        answer = ""
        model_chain = config["configurable"].get("model_chain")
        if model_chain:
            # Error Recovery（ADR-016 决策 2）：首帧前失败限次重试 → fallback 链换模；
            # 换模动作写审计（实际命中模型由网关 usage/latency 上报，此处补换模事件）
            fallback_auth: AuthContext | None = config["configurable"].get("auth_ctx")
            profile_key = config["configurable"].get("profile_key")

            async def _audit_fallback(from_model, to_model, error) -> None:
                if fallback_auth is None:  # 存量链路未带 auth（不应发生），降级不写审计
                    return
                async with session_factory() as audit_session:
                    await record_event(
                        audit_session,
                        user_id=fallback_auth.user_id,
                        username=fallback_auth.username,
                        action="workbench.model_fallback",
                        object_type="agent_profile",
                        object_id=profile_key,
                        outcome="allowed",
                        detail={"from_model": from_model, "to_model": to_model, "error": error},
                    )

            async for delta in stream_chat_with_fallback(
                gateway, llm_input, model_chain, on_fallback=_audit_fallback
            ):
                answer += delta
        else:
            async for delta in gateway.stream_chat(llm_input):
                answer += delta
        return {"answer": answer, "messages": [AIMessage(content=answer)]}

    builder = StateGraph(ChatState)
    # T08 治理中间件：input_guard（提问脱敏）与 output_guard（回答处置+审计+流式推帧）
    builder.add_node("retrieve", input_guard(retrieve, session_factory=session_factory))
    builder.add_node("generate", output_guard(generate, session_factory=session_factory))
    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "generate")
    builder.add_edge("generate", END)
    return builder.compile(checkpointer=checkpointer)


def serialize_citations(citations: list[dict]) -> str:
    import json

    return json.dumps(citations, ensure_ascii=False)
