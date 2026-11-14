"""AgentDesk 工具层执行器单测（T12）：拦截与审计联动 / 执行成功路径 / 超时与截断 /
schema 注册可枚举。

SQLite 内存库 + tmp_path 工作区；subprocess 类工具实跑（与容器内同一形态）。
"""

import json
import subprocess

import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from agent_platform.agentdesk import service
from agent_platform.agentdesk.tools import ToolExecutor, list_tools
from agent_platform.agentdesk.workspace import WorkspaceManager
from agent_platform.db.models import (
    AlwaysAllowed,
    Approval,
    AuditEvent,
    Base,
    TaskEvent,
)


def _git_log_oneline(repo) -> str:
    """同步 helper（ASYNC221）：async 测试体内不直接跑阻塞子进程。"""
    return subprocess.run(
        ["git", "log", "--oneline"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


def _git_status_porcelain(repo) -> str:
    return subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


@pytest_asyncio.fixture()
async def env(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    workspaces = WorkspaceManager(tmp_path / "workspaces")
    executor = ToolExecutor(workspaces, timeout_seconds=5, output_max_chars=2000)
    yield factory, workspaces, executor
    await engine.dispose()


async def _make_task(factory, workspaces, *, mode="confirm", owns=("payment-console/**",)):
    async with factory() as session:
        task = await service.create_task(
            session,
            goal="T12 执行器验收",
            owns=list(owns),
            mode=mode,
            user_id="u1",
            workspace_manager=workspaces,
        )
        await session.commit()
        return task


async def _events(factory, task_id):
    async with factory() as session:
        rows = (
            await session.scalars(
                select(TaskEvent)
                .where(TaskEvent.task_id == task_id)
                .order_by(TaskEvent.seq)
            )
        ).all()
        return [(e.seq, e.type, json.loads(e.data) if e.data else None) for e in rows]


async def _audits(factory):
    async with factory() as session:
        rows = (await session.scalars(select(AuditEvent).order_by(AuditEvent.created_at))).all()
        return [(a.action, a.outcome, json.loads(a.detail) if a.detail else None) for a in rows]


# ---------------- schema 注册可枚举（Agent Graph 的数据源） ----------------


def test_tool_registry_enumerable():
    tools = {t.name: t for t in list_tools()}
    assert set(tools) == {"read_files", "apply_patch", "run_command", "git_commit"}
    assert tools["read_files"].risk_level == "L0" and tools["read_files"].approvable is False
    assert tools["apply_patch"].risk_level == "L1" and tools["apply_patch"].approvable is True
    assert tools["run_command"].risk_level == "L2" and tools["run_command"].approvable is True
    assert tools["git_commit"].risk_level == "L2" and tools["git_commit"].approvable is True
    for schema in tools.values():
        # Graph 直接喂给 LLM tool-calling 的形态：JSON Schema 对象 + 描述
        assert schema.parameters["type"] == "object" and schema.description


# ---------------- apply_patch：owns 内放行 / owns 外拦截并审计 ----------------


async def test_apply_patch_within_owns_writes_file(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    async with factory() as session:
        result = await executor.execute(
            session,
            task,
            "apply_patch",
            {"path": "payment-console/pricing.py", "content": "FIXED = True\n"},
            username="tester",
        )
    assert result.decision == "allow" and result.ok is True
    patched = workspaces.task_dir(task.id) / "payment-console" / "pricing.py"
    assert patched.read_text(encoding="utf-8") == "FIXED = True\n"
    # 证据链：tool_start(decided=allow, L1 徽标) + tool_result(ok=True)
    events = await _events(factory, task.id)
    start = next(e for e in events if e[1] == "tool_start")
    assert start[2]["decided"] == "allow" and start[2]["risk_level"] == "L1"
    result_ev = next(e for e in events if e[1] == "tool_result")
    assert result_ev[2]["ok"] is True


async def test_apply_patch_outside_owns_denied_and_audited(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    async with factory() as session:
        result = await executor.execute(
            session,
            task,
            "apply_patch",
            {"path": "other/x.py", "content": "x = 1\n"},
            username="tester",
        )
    assert result.decision == "deny"
    assert result.reason_kind == "out_of_bounds"
    assert "not in owns" in result.reason
    # 证据链：out_of_bounds 专属事件 + tool_start(decided=deny) + tool_result(reason)
    events = await _events(factory, task.id)
    kinds = [e[1] for e in events]
    assert "out_of_bounds" in kinds and "tool_start" in kinds and "tool_result" in kinds
    oob = next(e for e in events if e[1] == "out_of_bounds")
    assert oob[2]["tool"] == "apply_patch" and "other/x.py" in oob[2]["path"]
    start = next(e for e in events if e[1] == "tool_start")
    assert start[2]["decided"] == "deny"
    # 审计：blocked + 域标签
    audits = await _audits(factory)
    oob_audit = next(a for a in audits if a[0] == "agentdesk.out_of_bounds")
    assert oob_audit[1] == "blocked"
    assert oob_audit[2]["domain"] == "agentdesk" and oob_audit[2]["task_id"] == str(task.id)


async def test_apply_patch_escaping_workspace_denied(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="auto_edit")
    async with factory() as session:
        result = await executor.execute(
            session, task, "apply_patch", {"path": "../evil.py", "content": "x"}, username="tester"
        )
    assert result.decision == "deny" and result.reason_kind == "out_of_bounds"


# ---------------- run_command：红线拦截 / cwd 逃逸 / 工作区内执行 / 超时截断 ----------------


async def test_run_command_redline_denied_and_audited(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(session, task, "run_command", {"command": "rm -rf /"}, username="tester")
    assert result.decision == "deny" and result.reason_kind == "redline"
    events = await _events(factory, task.id)
    redline = next(e for e in events if e[1] == "redline_blocked")
    assert redline[2]["pattern"] and "rm" in redline[2]["command"]
    audits = await _audits(factory)
    redline_audit = next(a for a in audits if a[0] == "agentdesk.redline_blocked")
    assert redline_audit[1] == "blocked" and redline_audit[2]["domain"] == "agentdesk"


async def test_run_command_cwd_escape_denied(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(
            session, task, "run_command", {"command": "cd / && pwd"}, username="tester"
        )
    assert result.decision == "deny" and result.reason_kind == "out_of_bounds"
    assert "cwd escape" in result.reason


async def test_run_command_executes_in_task_dir(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(session, task, "run_command", {"command": "pwd"}, username="tester")
    assert result.decision == "allow" and result.ok is True
    assert result.output.strip() == str((workspaces.task_dir(task.id)).resolve())
    audits = await _audits(factory)
    call = next(a for a in audits if a[0] == "agentdesk.tool_call")
    assert call[1] == "allowed" and call[2]["decision"] == "allow"


async def test_run_command_timeout(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(
            session, task, "run_command", {"command": "sleep 10"}, username="tester"  # 超出 5s 上限
        )
    assert result.ok is False and result.exit_code == -1
    assert result.output.startswith("[timeout after")


async def test_run_command_output_truncated(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(
            session,
            task,
            "run_command",
            {"command": "python3 -c \"print('x' * 5000)\""},
            username="tester",
        )
    assert result.decision == "allow" and result.output is not None
    assert len(result.output) < 2200  # 截断上限 2000 + 标记
    assert "truncated" in result.output


# ---------------- read_files / git_commit ----------------


async def test_read_files_returns_content_and_missing(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(
            session,
            task,
            "read_files",
            {"paths": ["payment-console/pricing.py", "nope.py"]},
            username="tester",
        )
    assert result.ok is True
    assert "BASE_PRICES_CENTS" in result.output
    assert "===== nope.py =====" in result.output and "[missing]" in result.output


async def test_git_commit_commits_changes(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    repo = workspaces.task_dir(task.id) / "payment-console"
    (repo / "pricing.py").write_text("FIXED = True\n", encoding="utf-8")
    async with factory() as session:
        result = await executor.execute(
            session, task, "git_commit", {"message": "fix annual promo"}, username="tester"
        )
    assert result.decision == "allow" and result.ok is True
    log = _git_log_oneline(repo)
    assert "fix annual promo" in log
    status = _git_status_porcelain(repo)
    assert status == ""  # add -A 已随提交收口


# ---------------- require_approval：审批单落库 + approval_required 事件 ----------------


async def test_require_approval_creates_pending_approval(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="confirm")
    async with factory() as session:
        result = await executor.execute(
            session, task, "run_command", {"command": "pytest -q"}, username="tester"
        )
    assert result.decision == "require_approval"
    assert result.approval_id is not None
    async with factory() as session:
        approval = await session.get(Approval, result.approval_id)
        assert approval.status == "pending"
        assert approval.command == "pytest -q"
        assert approval.scope == "run_command:L2"
    events = await _events(factory, task.id)
    required = next(e for e in events if e[1] == "approval_required")
    assert required[2]["approval_id"] == str(result.approval_id)
    assert required[2]["command"] == "pytest -q"


async def test_always_allowed_grant_lets_command_through(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="confirm")
    async with factory() as session:
        session.add(
            AlwaysAllowed(user_id=task.created_by, tool="run_command", pattern="echo *", expires_at=None)
        )
        await session.commit()
    async with factory() as session:
        result = await executor.execute(
            session, task, "run_command", {"command": "echo granted"}, username="tester"
        )
    assert result.decision == "allow" and result.approval_id is None
    assert result.output.strip() == "granted"


async def test_unknown_tool_denied(env):
    factory, workspaces, executor = env
    task = await _make_task(factory, workspaces, mode="full_access")
    async with factory() as session:
        result = await executor.execute(session, task, "rm_file", {"path": "x"}, username="tester")
    assert result.decision == "deny" and result.reason_kind == "invalid_args"
