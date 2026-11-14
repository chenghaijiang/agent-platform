"""AgentDesk 任务与事件服务（T11）：创建任务、分配工作区、写证据链事件。

T11 只交付数据层语义（无 API 面，路由归 T14）：
- create_task：意图落库 → 工作区分配装载演示仓 → 首条 task_status 事件；
- append_event：seq 单语句原子取号（task 内 max+1），(task_id, seq) 唯一约束兜底并发——
  并发写同一 task 时后到者触发唯一冲突，事件协议要求单写者（T13 执行会话顺序写入）；
- list_events：seq 游标查询（Last-Event-ID 断线回放的数据底座，SSE 归 T14）。
"""

import asyncio
import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.agentdesk.workspace import DEMO_REPO_NAME, WorkspaceManager
from agent_platform.db.models import (
    AGENT_TASK_MODES,
    AGENT_TASK_STATUSES,
    APPROVAL_DECISIONS,
    APPROVAL_STATUSES,
    AgentHunk,
    AgentTask,
    AlwaysAllowed,
    Approval,
    TaskEvent,
)
from agent_platform.guardrails.audit import record_event


async def append_event(
    session: AsyncSession,
    task_id: uuid.UUID,
    type: str,
    data: dict | None = None,
) -> TaskEvent:
    """写入任务事件：seq 由同语句子查询取号（task 内 COALESCE(MAX(seq),0)+1）。"""
    next_seq = (
        select(func.coalesce(func.max(TaskEvent.seq), 0) + 1)
        .where(TaskEvent.task_id == task_id)
        .scalar_subquery()
    )
    event = TaskEvent(
        task_id=task_id,
        seq=next_seq,
        type=type,
        data=json.dumps(data, ensure_ascii=False) if data is not None else None,
    )
    session.add(event)
    await session.flush()
    await session.refresh(event, ["seq"])  # 取号值在 INSERT 时才确定，回读落库后的 seq
    return event


async def create_task(
    session: AsyncSession,
    *,
    goal: str,
    owns: list[str],
    mode: str = "confirm",
    refs: list | None = None,
    title: str | None = None,
    user_id: str,
    workspace_manager: WorkspaceManager,
) -> AgentTask:
    """创建 Agent 任务（ADR-011 意图容器）：落库 + 工作区分配 + 首条事件，status=created。"""
    if mode not in AGENT_TASK_MODES:
        raise ValueError(f"unknown mode: {mode}")
    task_id = uuid.uuid4()
    task = AgentTask(
        id=task_id,
        title=title,
        goal=goal,
        owns=json.dumps(owns, ensure_ascii=False),
        mode=mode,
        refs=json.dumps(refs, ensure_ascii=False) if refs else None,
        workspace_dir=str(task_id),  # 工作区隔离目录 = workspaces/<task_id>/
        created_by=user_id,
    )
    session.add(task)
    await session.flush()
    workspace_manager.allocate(task_id)
    await append_event(
        session,
        task_id,
        "task_status",
        {"status": "created", "workspace": task.workspace_dir},
    )
    return task


async def list_events(
    session: AsyncSession,
    task_id: uuid.UUID,
    *,
    after_seq: int = 0,
    limit: int = 200,
) -> list[TaskEvent]:
    """按 seq 游标读取事件（after_seq 之后升序、至多 limit 条）。"""
    stmt = (
        select(TaskEvent)
        .where(TaskEvent.task_id == task_id, TaskEvent.seq > after_seq)
        .order_by(TaskEvent.seq)
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


async def set_task_status(
    session: AsyncSession,
    task: AgentTask,
    status: str,
    *,
    note: str | None = None,
) -> None:
    """状态机推进（T13）：写 task.status + task_status 事件（Graph 各节点推进用）。"""
    if status not in AGENT_TASK_STATUSES:
        raise ValueError(f"unknown status: {status}")
    task.status = status
    data: dict = {"status": status}
    if note:
        data["note"] = note
    await append_event(session, task.id, "task_status", data)


async def claim_next_task(session: AsyncSession, *, lease_seconds: int) -> AgentTask | None:
    """原子认领一个待执行任务（T14，ADR-005 模式复用）：写租约 + attempts+1。

    认领条件 status=created（队列 pending 语义）且租约空闲/过期；
    子查询 FOR UPDATE SKIP LOCKED 保证多 Worker 不取同一行；认领即提交释放行锁。
    认领不改状态——执行会话（runner.start）会先推进 planned/running，
    状态一旦离开 created 便不再可被重复认领，租约覆盖崩溃窗口。
    """
    now = datetime.now(UTC)
    candidate_ids = (
        select(AgentTask.id)
        .where(
            AgentTask.status == AGENT_TASK_STATUSES[0],  # created
            or_(AgentTask.lease_expires_at.is_(None), AgentTask.lease_expires_at <= now),
        )
        .order_by(AgentTask.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    result = await session.execute(
        update(AgentTask)
        .where(AgentTask.id.in_(candidate_ids))
        .values(
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            attempts=AgentTask.attempts + 1,
        )
        .returning(AgentTask)
    )
    task = result.scalar_one_or_none()
    await session.commit()
    return task


async def release_lease(session: AsyncSession, task_id: uuid.UUID) -> None:
    """执行完成（终态/挂起）后释放租约；worker 收尾用。"""
    await session.execute(
        update(AgentTask).where(AgentTask.id == task_id).values(lease_expires_at=None)
    )
    await session.commit()


# ---------- hunk 评审（T14，PRD 门禁） ----------


async def ensure_hunks(
    session: AsyncSession,
    task: AgentTask,
    workspace_manager: WorkspaceManager,
) -> list[AgentHunk]:
    """确保 review 态任务的 hunk 已落库：已有则直接返回，无则从 git diff 生成（按文件分块）。

    幂等：(task_id, idx) 唯一约束兜底；无 git 或无 diff 返回空列表（提交门禁会拒绝空 diff）。
    """
    existing = (
        await session.scalars(
            select(AgentHunk).where(AgentHunk.task_id == task.id).order_by(AgentHunk.idx)
        )
    ).all()
    if existing:
        return list(existing)

    blocks = _git_diff_blocks(workspace_manager.task_dir(task.id))
    hunks: list[AgentHunk] = []
    for idx, (path, header, content, additions, deletions) in enumerate(blocks):
        hunk = AgentHunk(
            task_id=task.id,
            idx=idx,
            path=path,
            header=header,
            content=content,
            additions=additions,
            deletions=deletions,
        )
        session.add(hunk)
        hunks.append(hunk)
    if hunks:
        await session.flush()
    return hunks


def _git_diff_blocks(task_dir) -> list[tuple[str, str, str, int, int]]:
    """读 workspace 演示仓 git diff（HEAD 对比），按文件切分 hunk 块。

    返回 (path, header, content, additions, deletions) 列表；git 缺失/无 diff 返回空。
    """
    repo_dir = task_dir / DEMO_REPO_NAME
    try:
        proc = subprocess.run(
            ["git", "diff", "-U3", "HEAD"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return []

    blocks: list[tuple[str, str, str, int, int]] = []
    for raw in proc.stdout.split("diff --git "):
        if not raw.strip():
            continue
        lines = raw.splitlines()
        first = lines[0]  # a/<path> b/<path>
        path = first.split(" b/")[-1]
        additions = sum(1 for line in lines if line.startswith("+") and not line.startswith("+++"))
        deletions = sum(1 for line in lines if line.startswith("-") and not line.startswith("---"))
        content = "diff --git " + "\n".join(lines)
        header = "\n".join(
            line for line in lines if line.startswith(("---", "+++", "@@"))
        )
        blocks.append((path, header, content[:4000], additions, deletions))
    return blocks


async def decide_hunk(
    session: AsyncSession,
    task: AgentTask,
    hunk_id: uuid.UUID,
    *,
    action: str,
    decided_by: str,
) -> AgentHunk:
    """hunk 接受/拒绝（PRD 门禁交互）：pending → accepted/rejected，重复决策 409 语义。"""
    if action not in ("accept", "reject"):
        raise ValueError(f"unknown hunk action: {action}")
    hunk = await session.get(AgentHunk, hunk_id)
    if hunk is None or hunk.task_id != task.id:
        raise LookupError(f"hunk {hunk_id} not found for task {task.id}")
    if hunk.status != "pending":
        raise LookupError(f"hunk {hunk_id} already decided ({hunk.status})")
    hunk.status = "accepted" if action == "accept" else "rejected"
    hunk.decided_by = decided_by
    hunk.decided_at = datetime.now(UTC)
    await session.flush()
    return hunk


async def hunks_summary(session: AsyncSession, task_id: uuid.UUID) -> dict:
    """hunk 统计（列表/详情/前端门禁联动）：{total, accepted, rejected, pending}。"""
    rows = await session.execute(
        select(AgentHunk.status, func.count())
        .where(AgentHunk.task_id == task_id)
        .group_by(AgentHunk.status)
    )
    counts = {status: count for status, count in rows.all()}
    total = sum(counts.values())
    return {
        "total": total,
        "accepted": counts.get("accepted", 0),
        "rejected": counts.get("rejected", 0),
        "pending": counts.get("pending", 0),
    }


async def commit_task(
    session: AsyncSession,
    task: AgentTask,
    workspace_manager: WorkspaceManager,
    *,
    committed_by: str,
) -> dict:
    """门禁提交（T14 票面验收 4）：全部 hunk accepted + checks 全绿 → workspace 内 git commit。

    门禁失败抛 ValueError（API 层转 409 并携带具体原因）；
    提交动作在演示仓内 git add -A + commit（message=goal 截断），推进 committed 并审计。
    """
    if task.status != "review":
        raise ValueError(f"task status is {task.status}, only review tasks can be committed")
    summary = await hunks_summary(session, task.id)
    if summary["total"] == 0:
        raise ValueError("no hunks to commit: workspace has no diff against baseline")
    if summary["accepted"] != summary["total"]:
        raise ValueError(
            f"hunks not fully accepted: {summary['accepted']}/{summary['total']} "
            f"(pending={summary['pending']}, rejected={summary['rejected']})"
        )

    check_results = run_checks(workspace_manager.task_dir(task.id))
    failed = [name for name, ok in check_results.items() if not ok]
    if failed:
        raise ValueError(f"checks not green: {', '.join(failed)}")

    # git 提交在演示仓内执行（与 T13 git_commit 工具同一基线仓）
    repo_dir = workspace_manager.task_dir(task.id) / DEMO_REPO_NAME
    message = f"agent: {task.goal[:60]}"
    try:
        # git 子进程经线程池避免阻塞事件循环（ASYNC221）
        await asyncio.to_thread(
            subprocess.run,
            ["git", "add", "-A"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
        )
        await asyncio.to_thread(
            subprocess.run,
            ["git", "-c", "user.name=agent-platform", "-c", "user.email=agent@platform.local",
             "commit", "-q", "-m", message],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        raise ValueError(f"git commit failed: {exc}") from exc

    await set_task_status(session, task, "committed", note="commit gate passed")
    await record_event(
        session,
        user_id=task.created_by,
        username=committed_by,
        action="agentdesk.task_committed",
        object_type="agent_task",
        object_id=str(task.id),
        outcome="allowed",
        detail={"domain": "agentdesk", "task_id": str(task.id), "hunks": summary["total"]},
    )
    await session.commit()
    return {"status": "committed", "checks": check_results, "hunks": summary}


# 提交门禁的 checks（与 graph.CHECK_COMMANDS 严格同组：不 import 以免环依赖，改动须同步）
COMMIT_CHECK_COMMANDS = ("cd payment-console && pytest -q", "cd payment-console && ruff check .")


def run_checks(task_dir) -> dict[str, bool]:
    """提交门禁的 checks 实跑（与 T13 check_node 同门禁：pytest -q + ruff check）。"""
    # 与 tools.ToolExecutor 同一 PATH 语义：子进程继承当前解释器 bin 目录
    # （宿主机裸跑 .venv/bin/python 时 PATH 不含 venv/bin，pytest/ruff 会 127；
    # 不能 resolve()：venv python 是指向基础解释器的符号链接，resolve 会退回 base bin）
    env = {
        **os.environ,
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
    }
    results: dict[str, bool] = {}
    for name, cmd in zip(("pytest", "ruff"), COMMIT_CHECK_COMMANDS, strict=True):
        try:
            proc = subprocess.run(  # check=False：返回码即门禁信号，非零不算异常
                cmd,
                cwd=task_dir,
                shell=True,
                capture_output=True,
                timeout=120,
                check=False,
                env=env,
            )
            results[name] = proc.returncode == 0
        except (FileNotFoundError, subprocess.SubprocessError):
            results[name] = False
    return results


async def resolve_approval(
    session: AsyncSession,
    approval_id: uuid.UUID,
    *,
    decision: str,
    decided_by: str,
) -> Approval:
    """审批三选决策（T13，ADR-013 L3）：pending → resolved + approval_resolved 事件 + 审计。

    always 同步写 always_allowed（仅 always 产生权限面，求值交 T12 match_grant；
    pattern 取审批单原命令，fnmatch/前缀语义下精确串即自匹配）。
    重复决策抛 LookupError（T14 API 层防双击依赖此校验）。
    """
    if decision not in APPROVAL_DECISIONS:
        raise ValueError(f"unknown decision: {decision}")
    approval = await session.get(Approval, approval_id)
    if approval is None:
        raise LookupError(f"approval {approval_id} not found")
    if approval.status == APPROVAL_STATUSES[1]:  # resolved
        if approval.decision == decision and approval.decided_by == decided_by:
            # 幂等重放（T14）：API decide 端点已同步落库，图内 approval_resolve 节点
            # resume 后重跑同一决策时跳过（不重复写事件/审计/always 授权）
            return approval
        raise LookupError(f"approval {approval_id} already resolved ({approval.decision})")
    task = await session.get(AgentTask, approval.task_id)
    approval.status = APPROVAL_STATUSES[1]  # resolved
    approval.decision = decision
    approval.decided_by = decided_by
    approval.decided_at = datetime.now(UTC)
    await append_event(
        session,
        approval.task_id,
        "approval_resolved",
        {
            "approval_id": str(approval.id),
            "decision": decision,
            "decided_by": decided_by,
            "command": approval.command,
        },
    )
    if decision == "always":
        tool = approval.scope.split(":")[0] if ":" in approval.scope else approval.scope
        session.add(
            AlwaysAllowed(
                user_id=task.created_by,
                tool=tool,
                pattern=approval.command,
                expires_at=None,
            )
        )
    await record_event(
        session,
        user_id=task.created_by,
        username=decided_by,
        action="agentdesk.approval_decided",
        object_type="agent_task",
        object_id=str(approval.task_id),
        outcome="allowed",
        detail={
            "domain": "agentdesk",
            "task_id": str(approval.task_id),
            "approval_id": str(approval.id),
            "decision": decision,
            "command": approval.command,
        },
    )
    await session.flush()
    return approval
