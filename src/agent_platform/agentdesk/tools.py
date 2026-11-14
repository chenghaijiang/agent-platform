"""AgentDesk 工具层（T12，ADR-012 工具协议）：四工具 schema 注册 + 统一执行器。

面向接口编程：Agent Graph（T13）只依赖 TOOL_REGISTRY 枚举与 ToolExecutor.execute，
阶段三可整体替换为 ACP 适配器（三层协议之工具协议）。执行器统一落实 ADR-013 分层拦截：
红线/边界/模式经 policy.evaluate 求值（L2/L1/L3），每次调用（含被拦截的）写 task_events
证据链与 audit_events 审计（L4，payload 带 domain: agentdesk 域标签，ADR-011）；
subprocess 类执行带超时与输出截断。
"""

import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agent_platform.agentdesk import policy
from agent_platform.agentdesk.policy import (
    KIND_REDLINE,
    POLICY_ALLOW,
    POLICY_DENY,
    POLICY_REQUIRE_APPROVAL,
    RISK_COMMAND,
    RISK_FILE_WRITE,
    RISK_READONLY,
)
from agent_platform.agentdesk.service import append_event
from agent_platform.agentdesk.workspace import DEMO_REPO_NAME, WorkspaceManager
from agent_platform.core.config import settings
from agent_platform.db.models import (
    AgentTask,
    AlwaysAllowed,
    Approval,
)
from agent_platform.guardrails.audit import record_event

# 审计动作（与 db.models.AUDIT_ACTIONS 的 agentdesk 段一致）
AUDIT_TOOL_CALL = "agentdesk.tool_call"
AUDIT_OUT_OF_BOUNDS = "agentdesk.out_of_bounds"
AUDIT_REDLINE = "agentdesk.redline_blocked"

_GIT_IDENTITY = ("-c", "user.name=agent-platform", "-c", "user.email=agent@platform.local")


@dataclass(frozen=True)
class ToolSchema:
    """工具描述符（ADR-012 工具协议）：Graph 枚举与 LLM tool-calling 的数据源。"""

    name: str
    description: str
    risk_level: str  # L0 / L1 / L2
    parameters: dict  # JSON Schema 形态
    approvable: bool  # 是否可能触发审批（L1/L2 为 True）


TOOL_REGISTRY: dict[str, ToolSchema] = {
    schema.name: schema
    for schema in (
        ToolSchema(
            name="read_files",
            description="读取 Task 工作区内文件内容（相对工作区根的路径，可批量）",
            risk_level=RISK_READONLY,
            parameters={
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "相对工作区根的文件路径列表",
                    }
                },
                "required": ["paths"],
            },
            approvable=False,
        ),
        ToolSchema(
            name="apply_patch",
            description="以整文件内容覆写工作区内文件；路径必须命中 Task 的 owns 声明",
            risk_level=RISK_FILE_WRITE,
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区根的目标文件路径"},
                    "content": {"type": "string", "description": "覆写后的完整文件内容"},
                },
                "required": ["path", "content"],
            },
            approvable=True,
        ),
        ToolSchema(
            name="run_command",
            description=(
                "在 Task 工作区根目录执行 shell 命令（带超时与输出截断）；"
                "cd 到工作区外与红线命令（删根目录/读密钥/强推等）被拒绝"
            ),
            risk_level=RISK_COMMAND,
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "待执行的 shell 命令"}
                },
                "required": ["command"],
            },
            approvable=True,
        ),
        ToolSchema(
            name="git_commit",
            description="在工作区演示仓提交全部改动（git add -A + git commit）",
            risk_level=RISK_COMMAND,
            parameters={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "提交说明"}
                },
                "required": ["message"],
            },
            approvable=True,
        ),
    )
}


def list_tools() -> list[ToolSchema]:
    """枚举全部工具 schema（Graph 组装 tool-calling 定义与前端工具面板共用）。"""
    return list(TOOL_REGISTRY.values())


@dataclass
class ToolResult:
    """一次工具调用的结构化结论（Graph 与事件层共用）。"""

    tool: str
    decision: str  # allow / deny / require_approval
    ok: bool  # 仅 allow 且执行成功（exit_code==0）为 True
    reason_kind: str | None = None  # redline / out_of_bounds / mode_denied / invalid_args
    reason: str | None = None
    output: str | None = None  # 截断后的输出
    exit_code: int | None = None
    duration_ms: int = 0
    approval_id: uuid.UUID | None = None  # require_approval 时创建的审批单


def _truncate(text: str, limit: int) -> str:
    """输出截断：保留头 1/3 + 尾 2/3（pytest 失败摘要集中在尾部）。"""
    if len(text) <= limit:
        return text
    head, tail = limit // 3, limit * 2 // 3
    return f"{text[:head]}\n…[truncated {len(text) - limit} chars]…\n{text[-tail:]}"


def _args_preview(args: dict, limit: int = 200) -> str:
    preview = json.dumps(args, ensure_ascii=False)
    return preview if len(preview) <= limit else preview[:limit] + "…"


class ToolExecutor:
    """四工具的统一执行入口：求值 → 事件/审计 → 执行（超时/截断）。"""

    def __init__(
        self,
        workspace_manager: WorkspaceManager,
        *,
        timeout_seconds: int | None = None,
        output_max_chars: int | None = None,
    ) -> None:
        self.workspaces = workspace_manager
        self.timeout_seconds = timeout_seconds or settings.agentdesk_tool_timeout_seconds
        self.output_max_chars = output_max_chars or settings.agentdesk_tool_output_max_chars
        # shell=True 子进程继承当前解释器的 bin 目录（venv/bin、容器 uv 环境）：
        # 宿主机裸跑 .venv/bin/python 时 PATH 不含 venv/bin，pytest/ruff 会 127；
        # 容器内该目录本就在 PATH，前置幂等无害。注意不能 resolve()：
        # venv 的 python 是指向基础解释器的符号链接，resolve 会退回 base bin。
        self._env = {
            **os.environ,
            "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        }

    @classmethod
    def from_settings(cls, workspace_manager: WorkspaceManager) -> "ToolExecutor":
        return cls(workspace_manager)

    async def execute(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        *,
        username: str,
    ) -> ToolResult:
        """执行一次工具调用：策略求值 + 证据链/审计留痕 + 实际执行。

        事件写入顺序：tool_start → （拦截类专属事件）→ tool_result；
        审计经 record_event 落库（其 commit 同时提交本执行单元的全部事件写入）。
        """
        started = time.perf_counter()
        schema = TOOL_REGISTRY.get(tool_name)
        task_dir = self.workspaces.task_dir(task.id)

        decision = policy.evaluate(
            tool=tool_name,
            mode=task.mode,
            risk_level=schema.risk_level if schema else "unknown",
            args=args,
            task_dir=task_dir,
            owns=json.loads(task.owns or "[]"),
            grants=await self._grants(session, task.created_by),
            user_id=task.created_by,
        ) if schema else policy.PolicyDecision(POLICY_DENY, policy.KIND_INVALID_ARGS, f"unknown tool: {tool_name}")

        await append_event(
            session,
            task.id,
            "tool_start",
            {
                "tool": tool_name,
                "args_preview": _args_preview(args),
                "risk_level": schema.risk_level if schema else "unknown",
                "decided": decision.decision,
            },
        )

        if decision.decision == POLICY_DENY:
            return await self._deny(session, task, tool_name, args, decision, started, username)

        if decision.decision == POLICY_REQUIRE_APPROVAL:
            return await self._await_approval(
                session, task, tool_name, args, decision, started, username
            )

        # ---- allow：实际执行 ----
        output, exit_code = await self._dispatch(session, task, tool_name, args, task_dir)
        duration_ms = int((time.perf_counter() - started) * 1000)
        result = ToolResult(
            tool=tool_name,
            decision=POLICY_ALLOW,
            ok=exit_code == 0,
            output=_truncate(output, self.output_max_chars) if output is not None else None,
            exit_code=exit_code,
            duration_ms=duration_ms,
        )
        await append_event(
            session,
            task.id,
            "tool_result",
            {
                "tool": tool_name,
                "ok": result.ok,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "output": result.output,
            },
        )
        await self._audit(
            session,
            task,
            username,
            AUDIT_TOOL_CALL,
            "allowed",
            decision=POLICY_ALLOW,
            schema=schema,
            tool_name=tool_name,
            exit_code=exit_code,
            duration_ms=duration_ms,
        )
        return result

    async def _deny(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        decision: policy.PolicyDecision,
        started: float,
        username: str,
    ) -> ToolResult:
        """deny：证据链专属事件 + 审计 + 越界/红线错误回注调用方（供 Agent 自纠）。"""
        duration_ms = int((time.perf_counter() - started) * 1000)
        audit_action, event_type = AUDIT_TOOL_CALL, None
        extra: dict = {}
        if decision.kind == policy.KIND_OUT_OF_BOUNDS:
            audit_action, event_type = AUDIT_OUT_OF_BOUNDS, "out_of_bounds"
            extra = {"tool": tool_name, "path": decision.detail}
        elif decision.kind == KIND_REDLINE:
            audit_action, event_type = AUDIT_REDLINE, "redline_blocked"
            extra = {"command": json.dumps(args, ensure_ascii=False)[:200], "pattern": decision.detail}
        if event_type:
            await append_event(session, task.id, event_type, extra)
        await append_event(
            session,
            task.id,
            "tool_result",
            {
                "tool": tool_name,
                "ok": False,
                "exit_code": None,
                "duration_ms": duration_ms,
                "reason_kind": decision.kind,
                "reason": decision.detail,
            },
        )
        await self._audit(
            session,
            task,
            username,
            audit_action,
            "blocked",
            decision=decision.decision,
            kind=decision.kind,
            schema=TOOL_REGISTRY.get(tool_name),
            tool_name=tool_name,
        )
        return ToolResult(
            tool=tool_name,
            decision=POLICY_DENY,
            ok=False,
            reason_kind=decision.kind,
            reason=decision.detail,
            exit_code=None,
            duration_ms=duration_ms,
        )

    async def _await_approval(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        decision: policy.PolicyDecision,
        started: float,
        username: str,
    ) -> ToolResult:
        """require_approval：创建审批单（pending）+ approval_required 事件，Graph 层 interrupt。"""
        schema = TOOL_REGISTRY[tool_name]
        target = {
            "run_command": args.get("command", ""),
            "apply_patch": args.get("path", ""),
            "git_commit": "git commit",
        }.get(tool_name, "")
        approval = Approval(
            task_id=task.id,
            command=str(target)[:2000],
            scope=f"{tool_name}:{schema.risk_level}",
            reason=decision.detail,
        )
        session.add(approval)
        await session.flush()
        await append_event(
            session,
            task.id,
            "approval_required",
            {
                "approval_id": str(approval.id),
                "command": approval.command,
                "scope": approval.scope,
                "reason": decision.detail,
            },
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        await self._audit(
            session,
            task,
            username,
            AUDIT_TOOL_CALL,
            "allowed",
            decision=POLICY_REQUIRE_APPROVAL,
            schema=schema,
            tool_name=tool_name,
            approval_id=str(approval.id),  # detail 走 json.dumps，UUID 需转字符串
        )
        return ToolResult(
            tool=tool_name,
            decision=POLICY_REQUIRE_APPROVAL,
            ok=False,
            reason=decision.detail,
            duration_ms=duration_ms,
            approval_id=approval.id,
        )

    async def _dispatch(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        task_dir: Path,
    ) -> tuple[str, int]:
        """按工具分发实际执行（policy 已放行，此处只管执行与异常兜底）。"""
        try:
            if tool_name == "read_files":
                return self._read_files(task_dir, args["paths"])
            if tool_name == "apply_patch":
                return self._apply_patch(task_dir, args["path"], args["content"])
            if tool_name == "run_command":
                return self._run_command(task_dir, args["command"])
            if tool_name == "git_commit":
                return self._git_commit(task_dir, args["message"])
        except subprocess.TimeoutExpired as exc:
            partial = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
            return f"[timeout after {self.timeout_seconds}s] {partial}", -1
        except Exception as exc:  # noqa: BLE001 -- 执行异常 ≠ 拦截：照实回注 Agent 自纠，兜底语义有意为之
            return f"[tool error] {exc}", -1
        return f"unknown tool: {tool_name}", -1

    def _read_files(self, task_dir: Path, paths: list[str]) -> tuple[str, int]:
        sections = []
        for raw in paths:
            resolved = policy.resolve_in_task_dir(task_dir, raw)
            if resolved is None or not resolved.is_file():
                sections.append(f"===== {raw} =====\n[missing]")
                continue
            content = resolved.read_text(encoding="utf-8", errors="replace")
            sections.append(f"===== {raw} =====\n{content}")
        return "\n\n".join(sections), 0

    def _apply_patch(self, task_dir: Path, raw_path: str, content: str) -> tuple[str, int]:
        resolved = policy.resolve_in_task_dir(task_dir, raw_path)
        if resolved is None:  # 理论不可达（policy 已拦），防御兜底
            return f"path outside workspace: {raw_path}", 1
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
        return f"patched {raw_path} ({len(content.encode('utf-8'))} bytes)", 0

    def _run_command(self, task_dir: Path, command: str) -> tuple[str, int]:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=task_dir,
            capture_output=True,
            text=True,
            timeout=self.timeout_seconds,
            check=False,  # 非零退出码是合法执行结果，不是异常
            env=self._env,
        )
        output = proc.stdout or ""
        if proc.stderr:
            output = f"{output}---- stderr ----\n{proc.stderr}" if output else proc.stderr
        return output, proc.returncode

    def _git_commit(self, task_dir: Path, message: str) -> tuple[str, int]:
        repo = task_dir / DEMO_REPO_NAME
        if not (repo / ".git").exists():
            return "not a git repository (workspace baseline missing)", 1
        add = subprocess.run(
            ["git", "add", "-A"], cwd=repo, capture_output=True, text=True, check=False
        )
        commit = subprocess.run(
            ["git", *_GIT_IDENTITY, "commit", "-m", message],
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
        )
        output = (add.stdout or "") + (commit.stdout or "") + (commit.stderr or "")
        return output, commit.returncode

    async def _grants(self, session: AsyncSession, user_id: str) -> list[AlwaysAllowed]:
        return list(
            (await session.scalars(select(AlwaysAllowed).where(AlwaysAllowed.user_id == user_id))).all()
        )

    # ---------- T13：求值与执行分离（Graph 分节点用；interrupt 语义要求副作用与挂起解耦） ----------

    async def evaluate_only(self, session: AsyncSession, task: AgentTask, tool_name: str, args: dict) -> policy.PolicyDecision:
        """纯求值（只读 grants 不写库）：Graph 的 policy_gate 节点专用。"""
        schema = TOOL_REGISTRY.get(tool_name)
        return policy.evaluate(
            tool=tool_name,
            mode=task.mode,
            risk_level=schema.risk_level if schema else "unknown",
            args=args,
            task_dir=self.workspaces.task_dir(task.id),
            owns=json.loads(task.owns or "[]"),
            grants=await self._grants(session, task.created_by),
            user_id=task.created_by,
        )

    async def execute_approved(
        self, session: AsyncSession, task: AgentTask, tool_name: str, args: dict, *, username: str
    ) -> ToolResult:
        """已放行执行（求值 allow 或审批 once/always 通过后）：跳过 policy，事件与审计口径同 execute。"""
        started = time.perf_counter()
        schema = TOOL_REGISTRY.get(tool_name)
        task_dir = self.workspaces.task_dir(task.id)
        await append_event(
            session,
            task.id,
            "tool_start",
            {
                "tool": tool_name,
                "args_preview": _args_preview(args),
                "risk_level": schema.risk_level if schema else "unknown",
                "decided": POLICY_ALLOW,
            },
        )
        output, exit_code = await self._dispatch(session, task, tool_name, args, task_dir)
        duration_ms = int((time.perf_counter() - started) * 1000)
        truncated = _truncate(output, self.output_max_chars) if output is not None else None
        await append_event(
            session,
            task.id,
            "tool_result",
            {
                "tool": tool_name,
                "ok": exit_code == 0,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "output": truncated,
            },
        )
        await self._audit(
            session, task, username, AUDIT_TOOL_CALL, "allowed",
            decision=POLICY_ALLOW, schema=schema, tool_name=tool_name,
            exit_code=exit_code, duration_ms=duration_ms,
        )
        return ToolResult(
            tool=tool_name, decision=POLICY_ALLOW, ok=exit_code == 0,
            output=truncated, exit_code=exit_code, duration_ms=duration_ms,
        )

    async def record_denied(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        decision: policy.PolicyDecision,
        *,
        username: str,
    ) -> ToolResult:
        """拦截记录（policy_gate deny 分支）：tool_start(decided=deny) + 专属事件 + tool_result + 审计。"""
        schema = TOOL_REGISTRY.get(tool_name)
        await append_event(
            session,
            task.id,
            "tool_start",
            {
                "tool": tool_name,
                "args_preview": _args_preview(args),
                "risk_level": schema.risk_level if schema else "unknown",
                "decided": POLICY_DENY,
            },
        )
        return await self._deny(session, task, tool_name, args, decision, time.perf_counter(), username)

    async def record_pending_approval(
        self,
        session: AsyncSession,
        task: AgentTask,
        tool_name: str,
        args: dict,
        decision: policy.PolicyDecision,
        *,
        username: str,
    ) -> ToolResult:
        """审批挂起记录：tool_start(decided=pending) + 审批单 + approval_required + 审计。"""
        schema = TOOL_REGISTRY.get(tool_name)
        await append_event(
            session,
            task.id,
            "tool_start",
            {
                "tool": tool_name,
                "args_preview": _args_preview(args),
                "risk_level": schema.risk_level if schema else "unknown",
                "decided": POLICY_REQUIRE_APPROVAL,
            },
        )
        return await self._await_approval(session, task, tool_name, args, decision, time.perf_counter(), username)

    def run_check(self, task_dir: Path, command: str) -> tuple[str, int]:
        """门禁命令（Graph check 节点专用）：不经 policy，复用超时/截断配置；事件由调用方写。"""
        try:
            return self._run_command(task_dir, command)
        except subprocess.TimeoutExpired as exc:
            partial = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
            return f"[timeout after {self.timeout_seconds}s] {partial}", -1

    async def _audit(
        self,
        session: AsyncSession,
        task: AgentTask,
        username: str,
        action: str,
        outcome: str,
        *,
        decision: str,
        schema: ToolSchema | None,
        tool_name: str,
        **extra,
    ) -> None:
        """L4 审计：payload 带域标签（ADR-011），两域同表可查。"""
        detail = {
            "domain": "agentdesk",
            "task_id": str(task.id),
            "tool": tool_name,
            "risk_level": schema.risk_level if schema else None,
            "decision": decision,
            **extra,
        }
        await record_event(
            session,
            user_id=task.created_by,
            username=username,
            action=action,
            object_type="agent_task",
            object_id=str(task.id),
            outcome=outcome,
            detail=detail,
        )
