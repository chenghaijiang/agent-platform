"""AgentDesk 执行入口（T13）：runner 是 Graph 的唯一驱动层（T14 API 只调这里）。

- start / confirm_plan / decide 三入口；thread_id = task_id（执行会话映射，ADR-012），
  Postgres Checkpointer 持久化执行态——进程重启后同一 thread_id 从 checkpoint 恢复，
  审批等待态经 pending_interrupt 可查、decide 可续（票面验收 4）；
- 每次入口先 aget_state 校验挂起点（kind + approval_id 匹配），防重复 resume 与决策错配；
- 图执行异常兜底转 partial（如实降级，ADR-013），不阻塞在中间态。

调度归调用方：start/confirm/decide 都是普通 await（图跑到挂起或终态才返回），
T14 API 层用 asyncio.create_task 包装 start 即可实现后台执行。
"""

import uuid

from langgraph.types import Command

from agent_platform.agentdesk import service
from agent_platform.db.models import (
    AGENT_TASK_STATUSES,
    AGENT_TASK_TERMINAL_STATUSES,
    APPROVAL_DECISIONS,
    AgentTask,
)


class AgentDeskRunner:
    """Agent 执行图驱动器：三入口 + 挂起点查询 + 异常降级。"""

    def __init__(self, graph, session_factory) -> None:
        self._graph = graph
        self._sessions = session_factory

    @staticmethod
    def _config(task_id: uuid.UUID, username: str | None = None) -> dict:
        configurable: dict = {"thread_id": str(task_id)}
        if username is not None:
            configurable["username"] = username
        return {"configurable": configurable}

    async def pending_interrupt(self, task_id: uuid.UUID) -> dict | None:
        """当前挂起点的 interrupt payload（无挂起返回 None）。

        重启后恢复审批等待态的数据源（票面验收 4）：aget_state 读 Checkpoint，
        任一 PregelTask.interrupts 非空即挂起中。
        """
        snapshot = await self._graph.aget_state(self._config(task_id))
        for t in snapshot.tasks:
            for intr in t.interrupts:
                return dict(intr.value)
        return None

    async def start(self, task_id: uuid.UUID, *, username: str) -> dict:
        """启动执行（status 必为 created）：跑图至挂起或终态。重复启动抛 RuntimeError。"""
        async with self._sessions() as session:
            task = await session.get(AgentTask, task_id)
            if task is None:
                raise LookupError(f"task {task_id} not found")
            if task.status != AGENT_TASK_STATUSES[0]:  # created
                raise RuntimeError(f"task {task_id} status={task.status}, start expects created")
            initial = {"task_id": str(task_id), "goal": task.goal}
        return await self._drive(task_id, initial, username)

    async def confirm_plan(self, task_id: uuid.UUID, *, action: str, username: str) -> dict:
        """计划确认 resume：approve（确认后切 auto_edit）或 cancel（任务取消）。"""
        if action not in ("approve", "cancel"):
            raise ValueError(f"unknown action: {action}")
        return await self._resume(
            task_id, {"action": action}, username=username, expect_kind="plan_confirm"
        )

    async def decide(
        self, task_id: uuid.UUID, approval_id: uuid.UUID, *, decision: str, decided_by: str
    ) -> dict:
        """审批三选 resume：once / always（写 always_allowed）/ deny（回注 Agent 自纠）。"""
        if decision not in APPROVAL_DECISIONS:
            raise ValueError(f"unknown decision: {decision}")
        return await self._resume(
            task_id,
            {"decision": decision, "decided_by": decided_by},
            username=decided_by,
            expect_kind="approval",
            expect_approval_id=str(approval_id),
        )

    # ---------- 内部：挂起点校验与统一驱动 ----------

    async def _resume(
        self,
        task_id: uuid.UUID,
        payload: dict,
        *,
        username: str,
        expect_kind: str,
        expect_approval_id: str | None = None,
    ) -> dict:
        interrupt_payload = await self.pending_interrupt(task_id)
        if interrupt_payload is None:
            raise RuntimeError(f"task {task_id} has no pending interrupt")
        if interrupt_payload.get("kind") != expect_kind:
            raise RuntimeError(
                f"interrupt kind mismatch: expected {expect_kind}, got {interrupt_payload.get('kind')}"
            )
        if expect_approval_id and interrupt_payload.get("approval_id") != expect_approval_id:
            raise RuntimeError("approval_id does not match the pending interrupt")
        return await self._drive(task_id, Command(resume=payload), username)

    async def _drive(self, task_id: uuid.UUID, command, username: str) -> dict:
        """统一驱动：invoke 至挂起或终态；异常兜底转 partial 后原样抛出。"""
        try:
            result = await self._graph.ainvoke(command, self._config(task_id, username))
        except Exception as exc:
            await self._fail(task_id, exc)
            raise
        outcome = result.get("outcome") if isinstance(result, dict) else None
        if outcome:  # 终态：cancelled / partial / review
            return {"state": "finished", "outcome": outcome}
        return {"state": "suspended", "interrupt": await self.pending_interrupt(task_id)}

    async def _fail(self, task_id: uuid.UUID, exc: Exception) -> None:
        """图执行异常兜底：未达终态的任务如实转 partial（ADR-013 降级语义）并留 summary 事件。"""
        try:
            async with self._sessions() as session:
                task = await session.get(AgentTask, task_id)
                if task is not None and task.status not in AGENT_TASK_TERMINAL_STATUSES:
                    await service.set_task_status(
                        session, task, "partial", note=f"graph error: {type(exc).__name__}"
                    )
                    await service.append_event(
                        session, task_id, "summary", {"outcome": "partial", "error": type(exc).__name__}
                    )
                    await session.commit()
        except Exception:  # noqa: BLE001, S110 -- 兜底自身失败不掩盖原始异常，ruff 豁免为有意设计
            pass
