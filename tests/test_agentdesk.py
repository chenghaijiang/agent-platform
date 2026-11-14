"""AgentDesk 数据层与工作区底座单测（T11，ADR-011/013）。

三表语义（SQLite 内存库）：Task 九态常量 / 事件 seq 按 task 单调递增且游标可查 /
审批与策略表可落库；工作区底座（tmp_path 根）：分配即装载演示仓、git 基线、
pytest 预置缺陷可见失败、ruff 零告警——checks 以子进程实跑验证（与容器内同一形态）。
"""

import json
import subprocess
import sys

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.agentdesk import service
from agent_platform.agentdesk.workspace import DEMO_REPO_NAME, WorkspaceManager
from agent_platform.db.models import (
    AGENT_TASK_MODES,
    AGENT_TASK_STATUSES,
    APPROVAL_DECISIONS,
    TASK_EVENT_TYPES,
    AlwaysAllowed,
    Approval,
    Base,
    TaskEvent,
)


@pytest_asyncio.fixture()
async def env(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    workspaces = WorkspaceManager(tmp_path / "workspaces")
    yield factory, workspaces
    await engine.dispose()


# ---------------- 术语与状态机常量 ----------------


def test_status_constants_match_ticket_scope():
    """九态状态机与四档模式（ADR-013）与事件协议类型集与实施方案 §3 一致。"""
    assert AGENT_TASK_STATUSES == (
        "created",
        "planned",
        "running",
        "blocked",
        "verifying",
        "partial",
        "review",
        "committed",
        "cancelled",
    )
    assert AGENT_TASK_MODES == ("confirm", "auto_edit", "plan", "full_access")
    assert APPROVAL_DECISIONS == ("once", "always", "deny")
    assert TASK_EVENT_TYPES == (
        "task_status",
        "plan",
        "tool_start",
        "tool_result",
        "approval_required",
        "approval_resolved",
        "delta",
        "check_start",
        "check_result",
        "verify",
        "summary",
        "out_of_bounds",
        "redline_blocked",
    )


# ---------------- 创建任务：落库 + 工作区分配 + 首条事件 ----------------


async def test_create_task_allocates_workspace_and_writes_first_event(env):
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session,
            goal="修复计费模块的年付折扣缺陷",
            owns=["payment-console/**"],
            mode="confirm",
            user_id="u1",
            workspace_manager=workspaces,
        )
        await session.commit()
        assert task.status == "created"
        assert json.loads(task.owns) == ["payment-console/**"]
        assert task.workspace_dir == str(task.id)
        # 演示仓已复制进 Task 隔离目录
        repo_dir = workspaces.task_dir(task.id) / DEMO_REPO_NAME
        assert (repo_dir / "pricing.py").exists()
        assert (repo_dir / "test_pricing.py").exists()
        assert (repo_dir / "pyproject.toml").exists()
        # 首条 task_status 事件 seq=1
        events = await service.list_events(session, task.id)
        assert [(e.seq, e.type) for e in events] == [(1, "task_status")]
        assert json.loads(events[0].data)["status"] == "created"


async def test_create_task_rejects_unknown_mode(env):
    factory, workspaces = env
    async with factory() as session:
        with pytest.raises(ValueError):
            await service.create_task(
                session,
                goal="x",
                owns=["payment-console/**"],
                mode="yolo",
                user_id="u1",
                workspace_manager=workspaces,
            )


# ---------------- 事件 seq：按 task 单调递增 + 游标查询 ----------------


async def test_event_seq_monotonic_and_independent_per_task(env):
    factory, workspaces = env
    async with factory() as session:
        t1 = await service.create_task(
            session, goal="任务一", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        t2 = await service.create_task(
            session, goal="任务二", owns=["b/**"], user_id="u1", workspace_manager=workspaces
        )
        for i in range(3):
            await service.append_event(session, t1.id, "delta", {"text": f"step {i}"})
        await service.append_event(session, t2.id, "delta", {"text": "other task"})
        await session.commit()

        seqs1 = (
            await session.scalars(
                select(TaskEvent.seq).where(TaskEvent.task_id == t1.id).order_by(TaskEvent.seq)
            )
        ).all()
        seqs2 = (
            await session.scalars(
                select(TaskEvent.seq).where(TaskEvent.task_id == t2.id).order_by(TaskEvent.seq)
            )
        ).all()
        assert seqs1 == [1, 2, 3, 4]  # 首条 task_status + 3 条 delta
        assert seqs2 == [1, 2]  # task 间 seq 独立计数


async def test_list_events_supports_seq_cursor(env):
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session, goal="回放演示", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        for i in range(4):
            await service.append_event(session, task.id, "delta", {"text": f"msg {i}"})
        await session.commit()
        # Last-Event-ID 回放形态：after_seq 之后升序，data JSON 可还原
        page = await service.list_events(session, task.id, after_seq=2)
        assert [e.seq for e in page] == [3, 4, 5]
        assert [json.loads(e.data)["text"] for e in page] == ["msg 1", "msg 2", "msg 3"]
        # 无事件 data 的信封同样成立（data=None）
        empty = await service.append_event(session, task.id, "verify")
        assert empty.seq == 6 and empty.data is None
        await session.commit()


# ---------------- 工作区底座：git 基线 / 幂等 / 演示仓 checks 实跑 ----------------


def _git_log_oneline(repo_dir) -> str:
    return subprocess.run(
        ["git", "log", "--oneline"], cwd=repo_dir, capture_output=True, text=True, check=True
    ).stdout


def _git_status_porcelain(repo_dir) -> str:
    return subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo_dir, capture_output=True, text=True, check=True
    ).stdout


def _run_pytest(repo_dir) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,  # 预置缺陷导致非零退出是断言目标，非异常
    )


def _run_ruff(repo_dir) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "ruff", "check", "."],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


async def test_demo_repo_git_baseline_committed(env):
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session, goal="x", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        await session.commit()
    repo_dir = workspaces.task_dir(task.id) / DEMO_REPO_NAME
    assert "baseline: payment-console demo repo" in _git_log_oneline(repo_dir)
    assert _git_status_porcelain(repo_dir) == ""  # 预置缺陷态已全部入库，修复即产生可审阅 diff


async def test_allocate_is_idempotent_on_retry(env):
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session, goal="x", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        await session.commit()
    repo_dir = workspaces.task_dir(task.id) / DEMO_REPO_NAME
    (repo_dir / "pricing.py").write_text("# user edited\n", encoding="utf-8")
    workspaces.allocate(task.id)  # 重复分配（Worker 重试形态）不覆盖已有内容
    assert (repo_dir / "pricing.py").read_text(encoding="utf-8") == "# user edited\n"


async def test_demo_repo_checks_pytest_fails_and_ruff_passes(env):
    """验收（T11）：演示仓预置缺陷使 pytest -q 失败可见；ruff check 零告警。

    子进程实跑与容器内同一形态（python -m pytest / python -m ruff），
    依赖随平台主依赖安装（pyproject），零额外依赖。
    """
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session, goal="x", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        await session.commit()
    repo_dir = workspaces.task_dir(task.id) / DEMO_REPO_NAME

    pytest_run = _run_pytest(repo_dir)
    assert pytest_run.returncode != 0
    assert "2 failed" in pytest_run.stdout  # 年付促销两条用例失败
    assert "4 passed" in pytest_run.stdout

    ruff_run = _run_ruff(repo_dir)
    assert ruff_run.returncode == 0, ruff_run.stdout + ruff_run.stderr


# ---------------- 审批单与「总是允许」策略表 ----------------


async def test_approval_and_always_allowed_models_persist(env):
    factory, workspaces = env
    async with factory() as session:
        task = await service.create_task(
            session, goal="x", owns=["a/**"], user_id="u1", workspace_manager=workspaces
        )
        approval = Approval(
            task_id=task.id,
            command="git push --force origin main",
            scope="run_command",
            reason="触碰红线，需人工三选",
        )
        grant = AlwaysAllowed(user_id="u1", tool="run_command", pattern="pytest*", expires_at=None)
        session.add_all([approval, grant])
        await session.commit()

        loaded = await session.get(Approval, approval.id)
        assert loaded.status == "pending"
        assert loaded.decision is None
        assert loaded.command == "git push --force origin main"
        loaded_grant = await session.get(AlwaysAllowed, grant.id)
        assert loaded_grant.tool == "run_command"
        assert loaded_grant.pattern == "pytest*"
