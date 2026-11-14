"""Agent 执行图（T13，ADR-012）：plan → await_confirm → act(工具循环) ↔ check → summarize。

**interrupt 与副作用分离**（LangGraph 语义：resume 后含 interrupt 的节点整体重跑）：
- interrupt 只出现在纯节点（await_confirm / approval_wait），无任何写库副作用，重跑无害；
- LLM 调用、事件写入、工具执行均在无 interrupt 的节点（plan/llm_act/policy_gate/tool_run/check/
  summarize），resume 只重跑挂起点之后的路径，不会重复消耗 token 或重复执行工具；
- 求值（policy_gate，纯读）与执行（tool_run）分离：deny/pending 的记录副作用在 policy_gate
  （无 interrupt 不重跑），执行在 tool_run；多 tool_calls 经 tool_queue 逐个处理。

每节点自行开 session 写事件与状态机推进（与 chat/graph.py 同构：重依赖闭包捕获、
请求级数据走 configurable）。事件协议 13 类全量覆盖（TASK_EVENT_TYPES）。
"""

import asyncio
import json
import re
import subprocess
import uuid
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import interrupt

from agent_platform.agentdesk import policy as _policy
from agent_platform.agentdesk import service
from agent_platform.agentdesk.llm import LLMInvoker
from agent_platform.agentdesk.tools import TOOL_REGISTRY, ToolExecutor, list_tools
from agent_platform.agentdesk.workspace import DEMO_REPO_NAME, WorkspaceManager
from agent_platform.db.models import AgentTask

PLAN_SYSTEM = (
    "你是企业内部 Agent 平台的规划助手。针对任务目标产出结构化执行计划，"
    "只输出 JSON（不要多余文本）：{\"steps\": [{\"idx\": 1, \"title\": \"…\", \"detail\": \"…\"}], "
    "\"risks\": [\"风险点…\"]}。计划必须限制在 owns 声明的路径内。"
)

ACT_SYSTEM = (
    "你是 AgentDesk 执行助手，在 Task 工作区内完成目标。工作区根即当前 cwd，演示仓在 payment-console/ 下。"
    "使用工具读取/修改文件与执行命令；遵守 owns 边界；被拒绝的操作请调整方案，不要原样重试。"
    "目标完成后不再调用工具，输出改动总结。"
)

# 门禁命令（T13 检查节点固定动作：演示仓 pytest + ruff；命令在演示仓 cwd 形态）
CHECK_COMMANDS = ("cd payment-console && pytest -q", "cd payment-console && ruff check .")

_DEFAULT_PLAN = {
    "steps": [
        {"idx": 1, "title": "阅读相关代码", "detail": "read_files 查看演示仓现状"},
        {"idx": 2, "title": "实施修改", "detail": "apply_patch 修复问题"},
        {"idx": 3, "title": "验证", "detail": "运行演示仓 checks 并修复直至通过"},
    ],
    "risks": ["修改范围必须落在 owns 声明内"],
}


class AgentState(TypedDict):
    """Agent 执行态（Checkpointer 按 thread_id=task_id 持久化，重启可恢复）。"""

    task_id: str
    goal: str
    messages: Annotated[list, add_messages]
    plan: dict
    needs_confirm: bool
    tool_queue: list[dict]  # 待处理 tool_calls [{"id","name","args"}]，逐个出队
    gate: str  # policy_gate / approval_resolve 的路由结论
    approval_ctx: dict
    approval_decision: str
    decided_by: str  # 审批决策人（未声明的 key 会被 LangGraph 静默丢弃，必须显式声明）
    check_rounds: int
    check_passed: bool
    steps: int
    total_tokens: int
    budget_exceeded: bool
    finished: bool
    outcome: str  # 空=进行中；review / partial / cancelled 为终态


def _parse_plan(content: str) -> dict:
    """解析计划 JSON（容忍 ```json 围栏），失败降级为默认计划。"""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.MULTILINE)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            plan = json.loads(match.group(0))
            if isinstance(plan.get("steps"), list) and plan["steps"]:
                plan.setdefault("risks", [])
                return plan
        except json.JSONDecodeError:
            pass
    return dict(_DEFAULT_PLAN)


def _tool_defs() -> list[dict]:
    """工具 schema → OpenAI tool-calling 定义（Graph 枚举 TOOL_REGISTRY 的数据源）。"""
    return [
        {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}
        for t in list_tools()
    ]


def _to_llm_messages(messages: list) -> list[dict]:
    """LangChain Message 列表 → OpenAI dict 格式（invoker 协议入口）。"""
    out: list[dict] = []
    for m in messages:
        if isinstance(m, dict):
            out.append(m)
        elif isinstance(m, SystemMessage):
            out.append({"role": "system", "content": m.content})
        elif isinstance(m, HumanMessage):
            out.append({"role": "user", "content": m.content})
        elif isinstance(m, AIMessage):
            entry: dict = {"role": "assistant", "content": m.content or ""}
            if m.tool_calls:
                entry["tool_calls"] = [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["args"], ensure_ascii=False)}}
                    for c in m.tool_calls
                ]
            out.append(entry)
        elif isinstance(m, ToolMessage):
            out.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
    return out


def _git_diff_stat(repo_dir) -> str:
    """演示仓相对基线的改动统计（同步子进程：经 to_thread 调用，git 缺失降级）。"""
    try:
        proc = subprocess.run(
            ["git", "diff", "--stat", "HEAD"], cwd=repo_dir, capture_output=True, text=True, check=False
        )
        return (proc.stdout or "").strip() or "(no diff)"
    except OSError:
        return "(git unavailable)"


def build_agent_graph(
    *,
    session_factory,
    workspace_manager: WorkspaceManager,
    executor: ToolExecutor,
    invoker: LLMInvoker,
    checkpointer,
    max_steps: int = 12,
    max_total_tokens: int = 120_000,
    max_check_rounds: int = 2,
):
    """构建 Agent 执行图（T13）：依赖闭包捕获，task_id 走 state，username 走 configurable。"""
    tool_defs = _tool_defs()

    async def plan_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            prompt = [
                {"role": "system", "content": PLAN_SYSTEM},
                {"role": "user", "content": f"任务目标：{task.goal}\nowns：{task.owns or '[]'}\n请输出 JSON 计划。"},
            ]
            resp = await invoker.invoke(prompt, tools=[])
            plan = _parse_plan(resp.content)
            needs_confirm = task.mode in ("confirm", "plan")  # 仅确认/计划模式需要 interrupt 确认
            if needs_confirm:
                await service.set_task_status(session, task, "planned")
            else:
                await service.set_task_status(session, task, "running", note="auto mode: skip plan confirm")
            await service.append_event(session, task_id, "plan", {
                "steps": plan["steps"], "risks": plan["risks"],
                "owns": json.loads(task.owns or "[]"),
            })
            await session.commit()
        return {
            "plan": plan,
            "needs_confirm": needs_confirm,
            "messages": [SystemMessage(content=ACT_SYSTEM), HumanMessage(content=state["goal"])],
        }

    async def await_confirm_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        answer = interrupt({"kind": "plan_confirm", "task_id": state["task_id"], "plan": state["plan"]})
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            if answer.get("action") == "cancel":
                await service.set_task_status(session, task, "cancelled", note="plan rejected")
                await session.commit()
                return {"outcome": "cancelled"}
            if task.mode == "confirm":
                task.mode = "auto_edit"  # 确认计划后切自动编辑（票面验收 1）
            await service.set_task_status(session, task, "running", note="plan confirmed, mode→auto_edit")
            await session.commit()
        return {}

    async def llm_act_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        steps = state.get("steps", 0) + 1
        total_tokens = state.get("total_tokens", 0)
        if steps > max_steps or total_tokens > max_total_tokens:
            return {"budget_exceeded": True}
        resp = await invoker.invoke(_to_llm_messages(state["messages"]), tool_defs)
        if resp.content:
            async with session_factory() as session:
                await service.append_event(session, task_id, "delta", {"text": resp.content})
                await session.commit()
        updates: dict = {"steps": steps, "total_tokens": total_tokens + resp.total_tokens}
        if resp.tool_calls:
            calls = [{"id": c.id, "name": c.name, "args": c.args} for c in resp.tool_calls]
            ai_msg = AIMessage(
                content=resp.content or "",
                tool_calls=[{"name": c["name"], "args": c["args"], "id": c["id"]} for c in calls],
            )
            return {**updates, "tool_queue": calls, "messages": [ai_msg], "finished": False}
        return {**updates, "tool_queue": [], "messages": [AIMessage(content=resp.content)], "finished": True}

    async def policy_gate_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        username = config["configurable"]["username"]
        call = state["tool_queue"][0]
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            decision = await executor.evaluate_only(session, task, call["name"], call["args"])
            if decision.decision == _policy.POLICY_ALLOW:
                await session.commit()
                return {"gate": "allow"}
            if decision.decision == _policy.POLICY_DENY:
                await executor.record_denied(session, task, call["name"], call["args"], decision, username=username)
                await session.commit()
                return {
                    "gate": "deny",
                    "messages": [ToolMessage(
                        content=f"[denied:{decision.kind}] {decision.detail or 'policy denied'}",
                        tool_call_id=call["id"],
                    )],
                }
            result = await executor.record_pending_approval(
                session, task, call["name"], call["args"], decision, username=username
            )
            await service.set_task_status(session, task, "blocked")
            await session.commit()
            return {
                "gate": "require",
                "approval_ctx": {
                    "approval_id": str(result.approval_id),
                    "command": call["args"].get("command", call["args"].get("path", "")),
                    "scope": f"{call['name']}:{TOOL_REGISTRY[call['name']].risk_level}",
                    "reason": decision.detail,
                },
            }

    async def approval_wait_node(state: AgentState, config) -> dict:
        """纯挂起（无副作用）：resume 后重跑本节点，interrupt() 直接返回决策值。"""
        answer = interrupt({"kind": "approval", **state["approval_ctx"]})
        return {"approval_decision": answer.get("decision", "deny"), "decided_by": answer.get("decided_by", "")}

    async def approval_resolve_node(state: AgentState, config) -> dict:
        ctx = state["approval_ctx"]
        decision = state["approval_decision"]
        decided_by = state.get("decided_by", "")
        task_id = uuid.UUID(state["task_id"])
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            await service.resolve_approval(
                session, uuid.UUID(ctx["approval_id"]), decision=decision, decided_by=decided_by
            )
            if decision != "deny":
                await service.set_task_status(session, task, "running", note="approval resolved, resume act")
            await session.commit()
        if decision == "deny":
            call = state["tool_queue"][0]
            return {
                "gate": "deny_after_approval",
                "messages": [ToolMessage(
                    content=f"[approval denied] 用户拒绝执行：{ctx.get('command', '')}",
                    tool_call_id=call["id"],
                )],
            }
        return {"gate": "approved"}

    async def tool_run_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        username = config["configurable"]["username"]
        call = state["tool_queue"][0]
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            result = await executor.execute_approved(session, task, call["name"], call["args"], username=username)
            await session.commit()
        output = result.output if result.output is not None else ""
        observation = f"[exit={result.exit_code}]\n{output}" if output else f"[exit={result.exit_code}]"
        return {
            "messages": [ToolMessage(content=observation, tool_call_id=call["id"])],
            "tool_queue": state["tool_queue"][1:],
        }

    async def check_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        task_dir = workspace_manager.task_dir(task_id)
        rounds = state.get("check_rounds", 0) + 1
        results: list[dict] = []
        all_ok = True
        for command in CHECK_COMMANDS:
            _, exit_code = await asyncio.to_thread(executor.run_check, task_dir, command)
            ok = exit_code == 0
            all_ok = all_ok and ok
            results.append({"command": command, "ok": ok, "exit_code": exit_code})
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            await service.set_task_status(session, task, "verifying")
            await service.append_event(session, task_id, "check_start", {"commands": list(CHECK_COMMANDS)})
            for item in results:
                await service.append_event(session, task_id, "check_result", item)
            if all_ok:
                await service.append_event(session, task_id, "verify", {
                    "criteria": ["pytest 全部通过", "ruff 零告警"],
                    "results": results,
                })
            await session.commit()
        if all_ok:
            return {"check_passed": True, "check_rounds": rounds}
        if rounds > max_check_rounds:
            return {"check_passed": False, "check_rounds": rounds, "outcome": "partial"}
        failed_tail = "\n".join(
            f"[{r['command']}] exit={r['exit_code']}" for r in results if not r["ok"]
        )
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            await service.set_task_status(session, task, "running", note=f"check round {rounds} failed, feedback to act")
            await session.commit()
        return {
            "check_passed": False,
            "check_rounds": rounds,
            "messages": [HumanMessage(
                content=f"[check] 检查失败（第 {rounds} 轮），请根据失败信息修复后重试：\n{failed_tail}"
            )],
        }

    async def summarize_node(state: AgentState, config) -> dict:
        task_id = uuid.UUID(state["task_id"])
        passed = bool(state.get("check_passed"))
        outcome = state.get("outcome") or ("review" if passed else "partial")
        repo_dir = workspace_manager.task_dir(task_id) / DEMO_REPO_NAME
        diff_stat = await asyncio.to_thread(_git_diff_stat, repo_dir)
        async with session_factory() as session:
            task = await session.get(AgentTask, task_id)
            await service.set_task_status(session, task, outcome)
            await service.append_event(session, task_id, "summary", {
                "outcome": outcome,
                "checks": "passed" if passed else "failed",
                "diff_stat": diff_stat,
                "steps": state.get("steps", 0),
                "total_tokens": state.get("total_tokens", 0),
            })
            await session.commit()
        return {"outcome": outcome}

    builder = StateGraph(AgentState)
    builder.add_node("plan", plan_node)
    builder.add_node("await_confirm", await_confirm_node)
    builder.add_node("llm_act", llm_act_node)
    builder.add_node("policy_gate", policy_gate_node)
    builder.add_node("approval_wait", approval_wait_node)
    builder.add_node("approval_resolve", approval_resolve_node)
    builder.add_node("tool_run", tool_run_node)
    builder.add_node("check", check_node)
    builder.add_node("summarize", summarize_node)

    builder.add_edge(START, "plan")
    # 仅确认/计划模式经 await_confirm（interrupt 纯节点）；auto_edit/full_access 直接进入执行
    builder.add_conditional_edges(
        "plan", lambda s: "await_confirm" if s.get("needs_confirm") else "llm_act"
    )
    builder.add_conditional_edges(
        "await_confirm", lambda s: END if s.get("outcome") == "cancelled" else "llm_act"
    )
    builder.add_conditional_edges(
        "llm_act",
        lambda s: "summarize" if s.get("budget_exceeded") else ("check" if s.get("finished") else "policy_gate"),
    )
    builder.add_conditional_edges(
        "policy_gate",
        lambda s: {"allow": "tool_run", "deny": "llm_act", "require": "approval_wait"}[s["gate"]],
    )
    builder.add_edge("approval_wait", "approval_resolve")  # resume 后：interrupt 返回决策 → 落库 → 执行/回注
    builder.add_conditional_edges(
        "approval_resolve", lambda s: "llm_act" if s["gate"] == "deny_after_approval" else "tool_run"
    )
    builder.add_conditional_edges(
        "tool_run", lambda s: "policy_gate" if s["tool_queue"] else "llm_act"
    )
    builder.add_conditional_edges(
        "check",
        lambda s: "summarize" if (s.get("check_passed") or s.get("outcome") == "partial") else "llm_act",
    )
    builder.add_edge("summarize", END)
    return builder.compile(checkpointer=checkpointer)
