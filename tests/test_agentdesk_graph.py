"""AgentDesk 执行图单测（T13，ADR-012）：计划确认 interrupt / 工具循环 / 审批 resume /
check 回灌 / 预算降级 / 事件协议 13 类全齐。

模型层 mock（票面验收 6）：ScriptedInvoker 按脚本回放轮次；工具执行、check 门禁
（pytest/ruff）与容器内同一形态实跑。SQLite 内存库 + MemorySaver Checkpointer；
「重启恢复」以同 Checkpointer 的新 Runner 实例模拟（容器端到端再验真重启）。
"""

import json
import uuid

import pytest
import pytest_asyncio
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.agentdesk import service
from agent_platform.agentdesk.graph import build_agent_graph
from agent_platform.agentdesk.llm import InvokerToolCall, LLMResponse, ScriptedInvoker
from agent_platform.agentdesk.runner import AgentDeskRunner
from agent_platform.agentdesk.tools import ToolExecutor
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.db.models import (
    TASK_EVENT_TYPES,
    AgentTask,
    AlwaysAllowed,
    Approval,
    AuditEvent,
    Base,
    TaskEvent,
)

# 修复后形态：逐字对齐原始 pricing.py（仅 annual 由硬编码 12 改为 ANNUAL_PROMO_MONTHS）
FIXED = '''"""payment-console 计价模块：套餐月费、席位加购与年付。

金额单位统一为「分」，避免浮点误差；三档套餐价格与席位/年付规则见产品需求。
"""

BASE_PRICES_CENTS = {"starter": 2900, "team": 8900, "enterprise": 29900}
INCLUDED_SEATS = 5
EXTRA_SEAT_RATE_PERCENT = 10  # 超出基础席位的加购席位：按基础价的 10%/席 计费
ANNUAL_PROMO_MONTHS = 10  # 年付促销：按 10 个月计费（赠 2 个月）


def monthly_price_cents(plan: str, seats: int = 1) -> int:
    """月费（分）：基础价 + 超出 INCLUDED_SEATS 的席位按基础价 10%/席 加收。"""
    if plan not in BASE_PRICES_CENTS:
        raise ValueError(f"unknown plan: {plan}")
    if seats < 1:
        raise ValueError("seats must be positive")
    base = BASE_PRICES_CENTS[plan]
    extra_seats = max(seats - INCLUDED_SEATS, 0)
    return base + extra_seats * base * EXTRA_SEAT_RATE_PERCENT // 100


def annual_price_cents(plan: str, seats: int = 1) -> int:
    """年付价格（分）：按 ANNUAL_PROMO_MONTHS 个月计费（赠 2 个月）。"""
    return monthly_price_cents(plan, seats) * ANNUAL_PROMO_MONTHS
'''


def _plan_turn() -> LLMResponse:
    plan = {
        "steps": [{"idx": 1, "title": "修复年付计价", "detail": "apply_patch payment-console/pricing.py"}],
        "risks": ["改动仅限演示仓"],
    }
    return LLMResponse(content=f"```json\n{json.dumps(plan, ensure_ascii=False)}\n```")


def _call(call_id: str, name: str, **args) -> LLMResponse:
    return LLMResponse(content="", tool_calls=[InvokerToolCall(id=call_id, name=name, args=args)])


def _done(text: str) -> LLMResponse:
    return LLMResponse(content=text)


@pytest_asyncio.fixture()
async def graph_env(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    workspaces = WorkspaceManager(tmp_path / "workspaces")
    executor = ToolExecutor(workspaces, timeout_seconds=10, output_max_chars=4000)

    def build(invoker, *, checkpointer=None, max_steps=12, max_check_rounds=2) -> AgentDeskRunner:
        graph = build_agent_graph(
            session_factory=factory,
            workspace_manager=workspaces,
            executor=executor,
            invoker=invoker,
            checkpointer=checkpointer or MemorySaver(),
            max_steps=max_steps,
            max_total_tokens=120_000,
            max_check_rounds=max_check_rounds,
        )
        return AgentDeskRunner(graph, factory)

    yield build, factory, workspaces
    await engine.dispose()


async def _make_task(factory, workspaces, *, mode="auto_edit", owns=("payment-console/**",)):
    async with factory() as session:
        task = await service.create_task(
            session,
            goal="修复 payment-console 年付计价缺陷并通过 checks",
            owns=list(owns),
            mode=mode,
            user_id="u1",
            workspace_manager=workspaces,
        )
        await session.commit()
        return task


async def _task_row(factory, task_id):
    async with factory() as session:
        return await session.get(AgentTask, task_id)


async def _events(factory, task_id):
    async with factory() as session:
        rows = (
            await session.scalars(
                select(TaskEvent).where(TaskEvent.task_id == task_id).order_by(TaskEvent.seq)
            )
        ).all()
        return [(e.seq, e.type, json.loads(e.data) if e.data else None) for e in rows]


async def _audits(factory):
    async with factory() as session:
        rows = (await session.scalars(select(AuditEvent).order_by(AuditEvent.created_at))).all()
        return [(a.action, a.outcome, json.loads(a.detail) if a.detail else None) for a in rows]


# ---------------- 场景 A：confirm 模式——计划 interrupt → 确认切 auto_edit → 修复 → review ----------------


async def test_confirm_mode_full_pipeline_to_review(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="confirm")
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "read_files", paths=["payment-console/pricing.py"]),
                _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED),
                _done("修复完成"),
            ]
        )
    )
    first = await runner.start(task.id, username="tester")
    # 计划 interrupt：结构化计划（步骤清单 + 风险点）随挂起点抛出（票面验收 1）
    assert first["state"] == "suspended"
    assert first["interrupt"]["kind"] == "plan_confirm"
    assert first["interrupt"]["plan"]["steps"] and first["interrupt"]["plan"]["risks"]
    row = await _task_row(factory, task.id)
    assert row.status == "planned"
    second = await runner.confirm_plan(task.id, action="approve", username="tester")
    # 确认后切自动编辑，工具循环跑通 check 门禁（票面验收 1+2）
    assert second == {"state": "finished", "outcome": "review"}
    row = await _task_row(factory, task.id)
    assert row.mode == "auto_edit" and row.status == "review"
    pricing = workspaces.task_dir(task.id) / "payment-console" / "pricing.py"
    assert pricing.read_text(encoding="utf-8") == FIXED
    types = {t for _, t, _ in await _events(factory, task.id)}
    assert {
        "task_status", "plan", "delta", "tool_start", "tool_result",
        "check_start", "check_result", "verify", "summary",
    } <= types


# ---------------- 场景 B：审批 once + Checkpoint 恢复（票面验收 3+4） ----------------


async def test_approval_once_resume_and_checkpoint_recovery(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    checkpointer = MemorySaver()
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "run_command", command="cd payment-console && pytest -q"),  # L2 → 审批挂起
            ]
        ),
        checkpointer=checkpointer,
    )
    first = await runner.start(task.id, username="tester")
    assert first["state"] == "suspended" and first["interrupt"]["kind"] == "approval"
    approval_id = first["interrupt"]["approval_id"]
    assert "pytest" in first["interrupt"]["command"]
    row = await _task_row(factory, task.id)
    assert row.status == "blocked"
    events = await _events(factory, task.id)
    required = next(e for e in events if e[1] == "approval_required")
    assert required[2]["approval_id"] == approval_id and required[2]["scope"] == "run_command:L2"

    # 「重启恢复」：新 Runner 实例 + 同一 Checkpointer，审批等待态可查可续（票面验收 4）
    recovered = build(
        ScriptedInvoker(
            [
                _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED),
                _done("已修复"),
            ]
        ),
        checkpointer=checkpointer,
    )
    pending = await recovered.pending_interrupt(task.id)
    assert pending["kind"] == "approval" and pending["approval_id"] == approval_id
    second = await recovered.decide(
        task.id, uuid.UUID(approval_id), decision="once", decided_by="approver"
    )
    assert second == {"state": "finished", "outcome": "review"}
    row = await _task_row(factory, task.id)
    assert row.status == "review"
    events = await _events(factory, task.id)
    resolved = next(e for e in events if e[1] == "approval_resolved")
    assert resolved[2]["decision"] == "once" and resolved[2]["decided_by"] == "approver"
    # 审批的 pytest 实跑结果进入证据链（exit=1：预置缺陷 2 failed）
    pytest_result = next(
        e for e in events if e[1] == "tool_result" and e[2].get("tool") == "run_command"
    )
    assert pytest_result[2]["exit_code"] == 1 and pytest_result[2]["ok"] is False
    # once 不产生 always_allowed 授权；事件 seq 全程连续（证据链不丢）
    async with factory() as session:
        assert list((await session.scalars(select(AlwaysAllowed))).all()) == []
    seqs = [s for s, _, _ in events]
    assert seqs == list(range(1, len(seqs) + 1))
    audits = await _audits(factory)
    assert any(a[0] == "agentdesk.approval_decided" and a[2]["decision"] == "once" for a in audits)


# ---------------- 场景 C：计划取消（confirm cancel） ----------------


async def test_confirm_cancel_marks_task_cancelled(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="confirm")
    runner = build(ScriptedInvoker([_plan_turn()]))
    first = await runner.start(task.id, username="tester")
    assert first["interrupt"]["kind"] == "plan_confirm"
    second = await runner.confirm_plan(task.id, action="cancel", username="tester")
    assert second == {"state": "finished", "outcome": "cancelled"}
    row = await _task_row(factory, task.id)
    assert row.status == "cancelled"
    with pytest.raises(RuntimeError, match="no pending interrupt"):
        await runner.decide(task.id, uuid.uuid4(), decision="once", decided_by="tester")


# ---------------- 场景 D：步数预算超限转 partial（票面「超限转 partial」） ----------------


async def test_budget_exceeded_degrades_to_partial(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "read_files", paths=["payment-console/pricing.py"]),
                _call("c2", "read_files", paths=["payment-console/test_pricing.py"]),
            ]
        ),
        max_steps=2,
    )
    result = await runner.start(task.id, username="tester")
    assert result == {"state": "finished", "outcome": "partial"}
    row = await _task_row(factory, task.id)
    assert row.status == "partial"
    events = await _events(factory, task.id)
    summary = next(e for e in events if e[1] == "summary")
    assert summary[2]["outcome"] == "partial"
    assert "verify" not in {t for _, t, _ in events}  # 未达门禁验收


# ---------------- 场景 E：check 失败自动回灌修复（≤2 轮内成功，票面验收 2） ----------------


async def test_check_failure_feedback_loop_repairs_and_passes(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "read_files", paths=["payment-console/pricing.py"]),  # 先看现状（缺陷未修）
                _done("第一轮结束，未做修改"),
                _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED),
                _done("已修复年付计价"),
            ]
        )
    )
    result = await runner.start(task.id, username="tester")
    # 第 1 轮 check 失败回灌，第 2 轮修复后通过
    assert result == {"state": "finished", "outcome": "review"}
    row = await _task_row(factory, task.id)
    assert row.status == "review"
    assert (workspaces.task_dir(task.id) / "payment-console" / "pricing.py").read_text(
        encoding="utf-8"
    ) == FIXED
    events = await _events(factory, task.id)
    check_starts = [e for e in events if e[1] == "check_start"]
    assert len(check_starts) == 2  # 两轮门禁
    feedback = next(e for e in events if e[1] == "task_status" and "check round" in (e[2].get("note") or ""))
    assert feedback[2]["status"] == "running"


# ---------------- 场景 F：审批 deny——回注 Agent 自纠后如实降级 partial ----------------


async def test_approval_deny_feeds_back_and_degrades(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    checkpointer = MemorySaver()
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "run_command", command="cd payment-console && pytest -q"),
            ]
        ),
        checkpointer=checkpointer,
        max_check_rounds=0,  # deny 后不再给修复机会：check 失败即 partial
    )
    first = await runner.start(task.id, username="tester")
    approval_id = first["interrupt"]["approval_id"]
    # 恢复实例的预算参数必须与原实例一致（同一任务同一预算；生产由同一 settings 保证）
    recovered = build(
        ScriptedInvoker([_done("无法继续，放弃修复")]),
        checkpointer=checkpointer,
        max_check_rounds=0,
    )
    second = await recovered.decide(
        task.id, uuid.UUID(approval_id), decision="deny", decided_by="approver"
    )
    assert second == {"state": "finished", "outcome": "partial"}
    row = await _task_row(factory, task.id)
    assert row.status == "partial"
    events = await _events(factory, task.id)
    resolved = next(e for e in events if e[1] == "approval_resolved")
    assert resolved[2]["decision"] == "deny"
    # deny 不执行工具：该 approval 后无新的 tool_result
    tool_results = [e for e in events if e[1] == "tool_result"]
    assert all(e[2].get("tool") != "run_command" for e in tool_results)


# ---------------- 场景 G：13 类事件协议全齐（票面验收 5） ----------------


async def test_all_event_types_emitted_in_single_task(graph_env):
    build, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    checkpointer = MemorySaver()
    runner = build(
        ScriptedInvoker(
            [
                _plan_turn(),
                _call("c1", "apply_patch", path="other/x.py", content="x = 1\n"),  # owns 外 → out_of_bounds
                _call("c2", "run_command", command="rm -rf /"),  # 红线 → redline_blocked
                _call("c3", "run_command", command="cd payment-console && pytest -q"),  # L2 → 审批挂起
            ]
        ),
        checkpointer=checkpointer,
    )
    first = await runner.start(task.id, username="tester")
    assert first["state"] == "suspended" and first["interrupt"]["kind"] == "approval"
    approval_id = first["interrupt"]["approval_id"]
    recovered = build(
        ScriptedInvoker(
            [
                _call("c4", "apply_patch", path="payment-console/pricing.py", content=FIXED),
                _done("绕过拦截后完成修复"),
            ]
        ),
        checkpointer=checkpointer,
    )
    second = await recovered.decide(
        task.id, uuid.UUID(approval_id), decision="once", decided_by="approver"
    )
    assert second == {"state": "finished", "outcome": "review"}
    events = await _events(factory, task.id)
    types = {t for _, t, _ in events}
    assert types == set(TASK_EVENT_TYPES)  # 13 类全齐（含 out_of_bounds 与 redline_blocked）
    oob = next(e for e in events if e[1] == "out_of_bounds")
    assert oob[2]["tool"] == "apply_patch" and "other/x.py" in oob[2]["path"]
    redline = next(e for e in events if e[1] == "redline_blocked")
    assert "rm" in redline[2]["command"]
    seqs = [s for s, _, _ in events]
    assert seqs == list(range(1, len(seqs) + 1))


# ---------------- service.resolve_approval：三选决策 / always 授权 / 防双击 ----------------


async def test_resolve_approval_three_decisions_and_replay_guard(graph_env):
    _, factory, workspaces = graph_env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    ids = []
    async with factory() as session:
        for i in range(3):
            approval = Approval(
                task_id=task.id, command=f"cmd-{i}", scope="run_command:L2", reason=None
            )
            session.add(approval)
            await session.flush()
            ids.append(approval.id)
        await session.commit()
    async with factory() as session:
        await service.resolve_approval(session, ids[0], decision="once", decided_by="u1")
        await service.resolve_approval(session, ids[1], decision="always", decided_by="u1")
        await service.resolve_approval(session, ids[2], decision="deny", decided_by="u1")
        await session.commit()
    async with factory() as session:
        grants = list((await session.scalars(select(AlwaysAllowed))).all())
        assert len(grants) == 1  # 仅 always 产生授权面
        assert grants[0].tool == "run_command" and grants[0].pattern == "cmd-1"
        rows = list((await session.scalars(select(Approval))).all())
        assert all(a.status == "resolved" for a in rows)
        decisions = {a.id: a.decision for a in rows}
        assert decisions[ids[0]] == "once" and decisions[ids[1]] == "always" and decisions[ids[2]] == "deny"
    # 防双击（T14 API 层依赖此校验）：同参数重放幂等（不重复写事件/审计）；异参数拒绝
    async with factory() as session:
        replayed = await service.resolve_approval(session, ids[0], decision="once", decided_by="u1")
        assert replayed.decision == "once"  # T14 幂等：API 已落库，图内节点重放时静默跳过
    with pytest.raises(LookupError):
        async with factory() as session:
            await service.resolve_approval(session, ids[0], decision="deny", decided_by="u1")
    events = await _events(factory, task.id)
    assert len([e for e in events if e[1] == "approval_resolved"]) == 3
    audits = await _audits(factory)
    assert sum(1 for a in audits if a[0] == "agentdesk.approval_decided") == 3
