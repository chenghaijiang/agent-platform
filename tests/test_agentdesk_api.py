"""AgentDesk API 单测（T14，§3 全表）：CRUD 入队 / Worker 认领 / SSE 回放与续传 /
confirm-decide resume / hunk 评审 / commit 门禁。

模型层 mock（对齐 T13）：ScriptedInvoker 回放轮次；工具与 checks 在真实演示仓实跑。
SSE 以 httpx 流式消费解析帧；后台图执行以轮询任务状态等待收敛。
"""

import asyncio
import json
import uuid

import httpx
import pytest_asyncio
from fastapi import FastAPI
from langgraph.checkpoint.memory import MemorySaver
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.agentdesk import service as agentdesk_service
from agent_platform.agentdesk.api import router as agentdesk_router
from agent_platform.agentdesk.llm import ScriptedInvoker
from agent_platform.agentdesk.runner import AgentDeskRunner
from agent_platform.agentdesk.tools import ToolExecutor
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_auth
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import AgentTask, AlwaysAllowed, Approval, Base
from tests.test_agentdesk_graph import FIXED, _call, _done, _plan_turn

MEMBER = AuthContext(user_id="u1", username="tester", role="member", provider="test")


def _parse_sse(raw: str) -> list[tuple[str, str, dict]]:
    """SSE 文本 → [(id, event, data)] 帧（多帧以空行分隔）。"""
    frames = []
    for block in raw.split("\n\n"):
        if not block.strip():
            continue
        lines = dict(
            line.split(": ", 1) if ": " in line else (line.split(":", 1)[0], "")
            for line in block.strip().splitlines()
        )
        frames.append((lines.get("id", ""), lines.get("event", ""), json.loads(lines.get("data", "{}"))))
    return frames


@pytest_asyncio.fixture()
async def api_env(tmp_path, monkeypatch):
    monkeypatch.setattr("agent_platform.agentdesk.api.SSE_POLL_INTERVAL_SECONDS", 0.05)
    # API 端点与 runner 必须同一 workspaces 根（生产由同一 settings/卷保证，测试对齐到 tmp_path）
    monkeypatch.setattr("agent_platform.core.config.settings.agentdesk_workspaces_dir", str(tmp_path / "workspaces"))
    # 文件库而非内存库：后台图执行 task 与请求依赖 teardown 并发交错，
    # 内存库 StaticPool 单连接上交错事务会互相回滚丢写（文件库跨连接共享，SQLite 写锁串行）
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'api.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    workspaces = WorkspaceManager(tmp_path / "workspaces")
    executor = ToolExecutor(workspaces, timeout_seconds=10, output_max_chars=4000)

    def build(invoker) -> AgentDeskRunner:
        from agent_platform.agentdesk.graph import build_agent_graph

        graph = build_agent_graph(
            session_factory=factory,
            workspace_manager=workspaces,
            executor=executor,
            invoker=invoker,
            checkpointer=MemorySaver(),
            max_steps=12,
            max_total_tokens=120_000,
            max_check_rounds=2,
        )
        return AgentDeskRunner(graph, factory)

    app = FastAPI()
    app.include_router(agentdesk_router)
    app.state.session_factory = factory
    app.state.agent_runner = build(ScriptedInvoker([]))

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_auth] = lambda: MEMBER

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, factory, workspaces, build, app
    await engine.dispose()


async def _create_task(ac: httpx.AsyncClient, *, mode="auto_edit", goal="修复 payment-console 年付计价缺陷并通过 checks") -> dict:
    resp = await ac.post(
        "/api/agentdesk/tasks",
        json={"goal": goal, "owns": ["payment-console/**"], "mode": mode},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _task_row(factory, task_id):
    async with factory() as session:
        return await session.get(AgentTask, task_id)


async def _wait_status(factory, task_id, target: str, timeout: float = 15.0) -> None:
    """后台图执行收敛等待：轮询任务状态直至目标（超时断言失败）。"""
    for _ in range(int(timeout / 0.1)):
        row = await _task_row(factory, task_id)
        if row is not None and row.status == target:
            return
        await asyncio.sleep(0.1)
    row = await _task_row(factory, task_id)
    from sqlalchemy import select as _sel

    from agent_platform.db.models import TaskEvent as _TE
    async with factory() as session:
        rows = (await session.scalars(_sel(_TE).where(_TE.task_id == task_id).order_by(_TE.seq))).all()
    for e in rows:
        print("DBG", e.seq, e.type, e.data)
    async with factory() as session:
        approval = (await session.scalars(_sel(Approval))).all()
        print("DBG approvals:", [(str(a.id)[:8], a.status, a.decision) for a in approval])
    raise AssertionError(f"task status {row.status if row else None} != {target} after {timeout}s")


# ---------------- 鉴权与 CRUD（票面验收 1+5） ----------------


async def test_endpoints_require_bearer_401(tmp_path):
    """无 token 一律 401（票面验收 5）：真实 require_auth 依赖链，不 override。"""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    app = FastAPI()
    app.include_router(agentdesk_router)
    app.state.session_factory = factory

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        for method, url, kwargs in (
            ("get", "/api/agentdesk/tasks", {}),
            ("post", "/api/agentdesk/tasks", {"json": {"goal": "x"}}),
            ("post", f"/api/agentdesk/tasks/{uuid.uuid4()}/commit", {}),
        ):
            resp = await ac.request(method, url, **kwargs)
            assert resp.status_code == 401, f"{method} {url}"
    await engine.dispose()


async def test_create_task_enqueues_with_free_lease(api_env):
    ac, factory, _workspaces, _build, _app = api_env
    body = await _create_task(ac)
    assert body["status"] == "created" and body["title"]  # title 缺省由 goal 派生
    row = await _task_row(factory, uuid.UUID(body["id"]))
    # 入队语义：status=created + 租约空闲（Worker 可认领）
    assert row.lease_expires_at is None and row.attempts == 0


async def test_unknown_mode_422(api_env):
    ac, *_rest = api_env
    resp = await ac.post("/api/agentdesk/tasks", json={"goal": "x", "mode": "bogus"})
    assert resp.status_code == 422


async def test_list_tasks_only_mine(api_env):
    ac, factory, workspaces, _build, _app = api_env
    mine = await _create_task(ac)
    async with factory() as session:
        other = await agentdesk_service.create_task(
            session, goal="别人的任务", owns=[], mode="confirm", user_id="u-other",
            workspace_manager=workspaces,
        )
        await session.commit()
    rows = (await ac.get("/api/agentdesk/tasks")).json()
    ids = {r["id"] for r in rows}
    assert mine["id"] in ids and str(other.id) not in ids


# ---------------- Worker 认领执行（票面验收 1） ----------------


async def test_worker_claim_runs_graph_to_suspension(api_env):
    ac, factory, _workspaces, build, app = api_env
    body = await _create_task(ac, mode="confirm")
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(ScriptedInvoker([_plan_turn()]))

    async with factory() as session:
        claimed = await agentdesk_service.claim_next_task(session, lease_seconds=300)
    assert claimed is not None and claimed.id == task_id
    assert claimed.lease_expires_at is not None and claimed.attempts == 1

    result = await app.state.agent_runner.start(task_id, username="tester")
    assert result["state"] == "suspended" and result["interrupt"]["kind"] == "plan_confirm"
    row = await _task_row(factory, task_id)
    assert row.status == "planned"  # 状态机流转经 API 可查（GET 详情同源）

    # 状态已离开 created：不可被重复认领（租约/状态双重保护）
    async with factory() as session:
        assert await agentdesk_service.claim_next_task(session, lease_seconds=300) is None


# ---------------- SSE 事件流（票面验收 2：历史回放 + Last-Event-ID 续传） ----------------


async def test_sse_replays_history_then_resumes_from_last_event_id(api_env):
    """终态任务：SSE 连接即回放全部历史帧（id=seq 连续）后 done 关流；
    带 Last-Event-ID 重连只收游标之后的帧（无重复无丢失，票面验收 2）。"""
    ac, factory, _workspaces, build, app = api_env
    body = await _create_task(ac)  # auto_edit：直接跑到 review 终态
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("完成")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
    await app.state.agent_runner.start(task_id, username="tester")
    await _wait_status(factory, task_id, "review")
    async with factory() as session:
        total_seq = (await agentdesk_service.list_events(session, task_id))[-1].seq

    async def _read(**kwargs):
        async with ac.stream("GET", f"/api/agentdesk/tasks/{task_id}/events", **kwargs) as resp:
            buf = ""
            async for chunk in resp.aiter_text():
                buf += chunk
            return buf

    frames = _parse_sse(await asyncio.wait_for(_read(), timeout=15))
    assert frames[-1][1] == "done"  # 终态且事件耗尽 → done 帧关流
    seqs = [int(fid) for fid, _, _ in frames[:-1] if fid]
    assert seqs == list(range(1, total_seq + 1))  # 历史事件零丢失，id 即 seq 游标

    # Last-Event-ID 断点续传：只收游标之后的帧（无重复）
    tail = _parse_sse(await asyncio.wait_for(_read(headers={"Last-Event-ID": "2"}), timeout=15))
    tail_seqs = [int(fid) for fid, _, _ in tail[:-1] if fid]
    assert tail[-1][1] == "done"
    assert tail_seqs == list(range(3, total_seq + 1))


# ---------------- 计划确认与审批决策（票面验收 3） ----------------


async def test_plan_confirm_202_then_review_and_double_confirm_409(api_env):
    ac, factory, workspaces, build, app = api_env
    body = await _create_task(ac, mode="confirm")
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "read_files", paths=["payment-console/pricing.py"]),
                         _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("完成")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
    await app.state.agent_runner.start(task_id, username="tester")

    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/plan/confirm", json={"action": "approve"})
    assert resp.status_code == 202, resp.text
    await _wait_status(factory, task_id, "review")
    row = await _task_row(factory, task_id)
    assert row.mode == "auto_edit"  # 确认后切自动编辑
    pricing = workspaces.task_dir(task_id) / "payment-console" / "pricing.py"
    assert pricing.read_text(encoding="utf-8") == FIXED

    # 重复确认：挂起点已消费 → 409
    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/plan/confirm", json={"action": "approve"})
    assert resp.status_code == 409


async def test_approval_decide_once_resumes_and_409_on_double(api_env):
    ac, factory, _workspaces, build, app = api_env
    body = await _create_task(ac)  # auto_edit
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "run_command", command="cd payment-console && pytest -q"),
                         _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("已修复")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
        first = await app.state.agent_runner.start(task_id, username="tester")
    assert first["state"] == "suspended" and first["interrupt"]["kind"] == "approval"
    approval_id = first["interrupt"]["approval_id"]

    resp = await ac.post(f"/api/agentdesk/approvals/{approval_id}/decide", json={"decision": "once"})
    assert resp.status_code == 202, resp.text
    await _wait_status(factory, task_id, "review")

    # 双击防：审批单已 resolved → 409（T13 LookupError 语义上浮 API）
    resp = await ac.post(f"/api/agentdesk/approvals/{approval_id}/decide", json={"decision": "deny"})
    assert resp.status_code == 409

    async with factory() as session:
        approval = await session.get(Approval, uuid.UUID(approval_id))
        assert approval.decision == "once" and approval.decided_by == "tester"


async def test_approval_decide_always_persists_grant(api_env):
    """always 决策：resume 到 review 且 always_allowed 落表带作用域（票面验收 3）。"""
    ac, factory, _workspaces, build, app = api_env
    body = await _create_task(ac)
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "run_command", command="cd payment-console && pytest -q"),
                         _call("c2", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("已修复")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
        first = await app.state.agent_runner.start(task_id, username="tester")
    approval_id = first["interrupt"]["approval_id"]

    resp = await ac.post(f"/api/agentdesk/approvals/{approval_id}/decide", json={"decision": "always"})
    assert resp.status_code == 202
    await _wait_status(factory, task_id, "review")
    async with factory() as session:
        grants = (await session.scalars(select(AlwaysAllowed))).all()
        assert len(grants) == 1
        assert grants[0].tool == "run_command" and grants[0].pattern == "cd payment-console && pytest -q"
        assert grants[0].user_id == "u1"


# ---------------- hunk 评审与门禁提交（票面验收 4） ----------------


async def test_hunk_review_and_commit_gate(api_env):
    ac, factory, workspaces, build, app = api_env
    body = await _create_task(ac)
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("完成")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
    await app.state.agent_runner.start(task_id, username="tester")
    await _wait_status(factory, task_id, "review")

    detail = (await ac.get(f"/api/agentdesk/tasks/{task_id}")).json()
    assert detail["hunks"]["total"] >= 1  # review 态详情惰性生成 hunk 清单
    hunk_ids = [h["id"] for h in detail["hunk_list"]]

    # 未全部接受 → commit 409 带具体原因
    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/commit")
    assert resp.status_code == 409
    assert "hunks not fully accepted" in resp.json()["detail"]

    # 接受全部 → commit 通过门禁：checks 双绿 + git 提交
    for hunk_id in hunk_ids:
        resp = await ac.post(
            f"/api/agentdesk/tasks/{task_id}/hunks", json={"hunk_id": hunk_id, "action": "accept"}
        )
        assert resp.status_code == 200, resp.text
    assert detail["hunks"]["total"] == (await ac.get(f"/api/agentdesk/tasks/{task_id}")).json()["hunks"]["accepted"]

    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/commit")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "committed" and resp.json()["checks"] == {"pytest": True, "ruff": True}
    row = await _task_row(factory, task_id)
    assert row.status == "committed"
    # 提交真实落盘：演示仓 git log 含提交（to_thread 阻塞调用移出事件循环）
    import subprocess

    proc = await asyncio.to_thread(
        subprocess.run,
        ["git", "log", "--oneline", "-2"],
        cwd=workspaces.task_dir(task_id) / "payment-console",
        capture_output=True,
        text=True,
        check=True,
    )
    assert "agent:" in proc.stdout

    # 已提交任务不可再评审/再提交
    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/hunks", json={"hunk_id": hunk_ids[0], "action": "reject"})
    assert resp.status_code == 409
    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/commit")
    assert resp.status_code == 409


async def test_commit_409_when_checks_not_green(api_env):
    ac, factory, workspaces, build, app = api_env
    body = await _create_task(ac)
    task_id = uuid.UUID(body["id"])
    app.state.agent_runner = build(
        ScriptedInvoker([_plan_turn(), _call("c1", "apply_patch", path="payment-console/pricing.py", content=FIXED), _done("完成")])
    )
    async with factory() as session:
        await agentdesk_service.claim_next_task(session, lease_seconds=300)
    await app.state.agent_runner.start(task_id, username="tester")
    await _wait_status(factory, task_id, "review")

    # review 后人为破坏：checks 实跑红 → 门禁拒绝（验收 4 的 checks 全绿语义）
    pricing = workspaces.task_dir(task_id) / "payment-console" / "pricing.py"
    pricing.write_text(pricing.read_text(encoding="utf-8").replace("2900", "290O"), encoding="utf-8")
    detail = (await ac.get(f"/api/agentdesk/tasks/{task_id}")).json()
    for h in detail["hunk_list"]:
        await ac.post(f"/api/agentdesk/tasks/{task_id}/hunks", json={"hunk_id": h["id"], "action": "accept"})

    resp = await ac.post(f"/api/agentdesk/tasks/{task_id}/commit")
    assert resp.status_code == 409
    assert "checks not green" in resp.json()["detail"]
