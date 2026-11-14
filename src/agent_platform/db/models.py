"""ORM 模型（T02/T04/T05/T07/T11）：账号 / 知识库 ACL / 入库任务 / 知识块 / 会话与 Run / AgentDesk。

知识库是企业知识隔离单元（T04）：管理员创建元数据并对角色授权（角色 × 知识库 = 可读/不可见），
可见性查询是 T06 检索 ACL 过滤与 T08 审计的数据来源。
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Role(Base):
    """角色：ACL 的主体之一（角色 × 知识库 = 可读/不可见）。"""

    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(32), unique=True)
    description: Mapped[str | None] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class User(Base):
    """用户：口令以加盐哈希存储（core.security），永不落明文。"""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    display_name: Mapped[str | None] = mapped_column(String(128))
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean(), default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now()
    )


class KnowledgeBaseAcl(Base):
    """知识库 ACL：角色 × 知识库的可见性授权，T06 检索权限过滤的数据来源。"""

    __tablename__ = "kb_acls"
    # 同一角色对同一知识库仅一条授权记录；KB 删除时级联清理授权
    __table_args__ = (UniqueConstraint("role_id", "kb_id", name="uq_kb_acls_role_kb"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"), index=True)
    kb_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True
    )
    permission: Mapped[str] = mapped_column(String(32), default="read", server_default="read")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# 密级枚举（T04）：存储英文枚举，API 返回时附中文标签
KB_CLASSIFICATIONS = ("public", "internal", "confidential")
KB_CLASSIFICATION_LABELS = {
    "public": "公开",
    "internal": "内部",
    "confidential": "机密",
}


class KnowledgeBase(Base):
    """知识库元数据（T04）：企业知识隔离单元，含密级与索引版本字段。"""

    __tablename__ = "knowledge_bases"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    classification: Mapped[str] = mapped_column(String(16), default="internal", server_default="internal")
    description: Mapped[str | None] = mapped_column(String(512))  # 可见范围描述
    # 索引版本预留（T10 评测/重建索引用；MVP 恒为 v1）
    index_version: Mapped[str] = mapped_column(String(16), default="v1", server_default="v1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# 入库任务状态机五态（T05，ADR-005）：排队中 / 运行中 / 成功 / 失败待重试 / 重试耗尽死信
TASK_STATUSES = ("queued", "running", "succeeded", "failed", "dead")


class IngestTask(Base):
    """入库任务（T05）：MVP 唯一的异步任务，PG 表 + SKIP LOCKED 实现租约与重试。"""

    __tablename__ = "ingest_tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    kb_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="queued", server_default="queued", index=True)
    attempt: Mapped[int] = mapped_column(Integer(), default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer(), default=3, server_default="3")
    # 租约：running 态的到期时间，到期未续约可被另一个 Worker 重新认领
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 退避：failed 态的下次可认领时间
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text())
    source_filename: Mapped[str] = mapped_column(String(256))
    # 幂等键：同一知识库内相同内容指纹的任务复用，不产生重复 chunks
    content_hash: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(512))  # 对象存储路径（原始文件归档）
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now()
    )


class KbChunk(Base):
    """知识块（T05）：切分后的原文 + 向量；密级冗余自 KB，供 T06 检索权限过滤免 join。"""

    __tablename__ = "kb_chunks"
    __table_args__ = (UniqueConstraint("kb_id", "task_id", "chunk_index", name="uq_kb_chunks_task_index"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    kb_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ingest_tasks.id", ondelete="CASCADE")
    )
    chunk_index: Mapped[int] = mapped_column(Integer())
    content: Mapped[str] = mapped_column(Text())
    heading_path: Mapped[str | None] = mapped_column(String(512))  # 标题层级路径，如 "第一章/第二节"
    classification: Mapped[str] = mapped_column(String(16), default="internal", server_default="internal")
    content_hash: Mapped[str] = mapped_column(String(64))
    # 无维度 vector 列：MVP 不建向量索引（数据量小），并允许切换不同维度 embedding 模型
    embedding: Mapped[list[float]] = mapped_column(Vector())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# 问答 Run 状态（T07）：运行中 / 完成 / 失败
RUN_STATUSES = ("running", "completed", "failed")


class ChatSession(Base):
    """会话元数据（T07，ADR-008）：业务库管理归属与标题；执行态归 Checkpointer 表。"""

    __tablename__ = "chat_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(64))  # JWT sub（用户 UUID 字符串），索引见迁移 0005
    title: Mapped[str | None] = mapped_column(String(128))
    # LangGraph thread 映射：同一 thread_id 的 checkpoint 状态即该会话的执行态
    thread_id: Mapped[uuid.UUID] = mapped_column(Uuid(), unique=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatRun(Base):
    """问答 Run 执行记录（T07）：一次提问 = 一次 Run（glossary：Run ≠ 异步任务）。"""

    __tablename__ = "chat_runs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True
    )
    question: Mapped[str] = mapped_column(Text())
    status: Mapped[str] = mapped_column(String(16), default="running", server_default="running", index=True)
    answer: Mapped[str | None] = mapped_column(Text())
    citations: Mapped[str | None] = mapped_column(Text())  # JSON 数组字符串
    error: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# 审计动作集（T08，ADR-007；T12/T13 起 AgentDesk 域新增）：提问 / 越权拦截 / 输入脱敏 / 输出脱敏
# AgentDesk 域动作带域标签（ADR-011：两域同表，payload 带 domain: agentdesk + task_id）
AUDIT_ACTIONS = (
    "chat.ask",
    "retrieval.search",
    "retrieval.denied",
    "guard.input_masked",
    "guard.output_masked",
    "agentdesk.tool_call",
    "agentdesk.out_of_bounds",
    "agentdesk.redline_blocked",
    "agentdesk.approval_decided",  # T13：审批三选决策（once/always/deny）
)
# 审计处置结果：允许（正常放行）/ 过滤（脱敏后放行）/ 拦截（拒绝）
AUDIT_OUTCOMES = ("allowed", "filtered", "blocked")


class AuditEvent(Base):
    """审计事件（T08，ADR-007）：治理动作记录，审计 ≠ Trace（独立于 Langfuse）。

    每次 Run 记录：谁（user_id/username）、动作（action）、对象（object_type/object_id）、
    结果（outcome）与结构化详情（detail JSON：敏感类型/拒绝范围等）。
    """

    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(64))  # JWT sub，索引见迁移 0006
    username: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(32))  # AUDIT_ACTIONS，索引见迁移 0006
    object_type: Mapped[str] = mapped_column(String(32))  # chat / knowledge_base
    object_id: Mapped[str | None] = mapped_column(String(128))
    outcome: Mapped[str] = mapped_column(String(16))  # allowed / filtered / blocked
    detail: Mapped[str | None] = mapped_column(Text())  # JSON 对象字符串
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# Prompt 版本状态（T10，ADR-009）：草稿 / 已发布（当前生效，同键唯一）/ 已归档（被新版本替代）
PROMPT_STATUSES = ("draft", "published", "archived")


class PromptVersion(Base):
    """Prompt 版本（T10，ADR-009）：版本号按 template_key 单调递增，发布即封版不可篡改。

    运行链路只读 status=published 的当前版本；模板可变区（如 {context}）由运行时填充。
    """

    __tablename__ = "prompt_versions"
    __table_args__ = (UniqueConstraint("template_key", "version", name="uq_prompt_key_version"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    template_key: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), default="draft", server_default="draft")
    template: Mapped[str] = mapped_column(Text())
    change_note: Mapped[str | None] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------- AgentDesk：Agent 执行域（T11，ADR-011/013）----------------

# Agent 任务九态状态机（意图容器生命周期：规划→执行→检查→验收→交付）
AGENT_TASK_STATUSES = (
    "created",    # 已创建：工作区已分配、演示仓已装载，待规划
    "planned",    # 计划已产出：等待用户确认（计划/确认模式）
    "running",    # 执行中：工具循环
    "blocked",    # 被阻塞：等待审批 interrupt resume 或用户确认
    "verifying",  # 检查回灌中：pytest/ruff 校验，失败回灌执行
    "partial",    # 部分完成：修复轮次/步数/预算超限，如实降级
    "review",     # 待人工验收：hunk 逐块接受
    "committed",  # 已提交：门禁通过，workspace 分支落盘
    "cancelled",  # 已取消
)

# 四档执行模式（ADR-013 L3 求值输入）：变更前确认 / 自动编辑 / 计划模式 / 完全访问
AGENT_TASK_MODES = ("confirm", "auto_edit", "plan", "full_access")

# 终态九态的子集（T14 正式化）：runner._fail 兜底、SSE 关流、commit 门禁均以此为据
AGENT_TASK_TERMINAL_STATUSES = ("partial", "review", "committed", "cancelled")

# 事件类型（agentdesk-implementation.md §3）：信封 {type, seq, ts, data}，证据链实体
TASK_EVENT_TYPES = (
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

# 审批单状态与三选决策（ADR-013 L3：仅本次 / 总是允许 / 拒绝）
APPROVAL_STATUSES = ("pending", "resolved")
APPROVAL_DECISIONS = ("once", "always", "deny")


class AgentTask(Base):
    """Agent 任务（T11，ADR-011）：Agent 执行域的意图容器。

    Task ≠ Job：ADR-008 的「任务=异步业务作业」归知识问答域（ingest_tasks 语义不变），
    本表承载 goal/owns/mode 的可检索、可归档执行意图，由执行会话推进。
    """

    __tablename__ = "agent_tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    title: Mapped[str | None] = mapped_column(String(128))  # 缺省由 goal 派生（T14 API 派生）
    goal: Mapped[str] = mapped_column(Text())
    # owns（ADR-011 边界声明）：可改动路径集合，JSON 数组字符串（如 ["payment-console/**"]），
    # T12 策略引擎 L1 越界检测与并行互斥的声明源
    owns: Mapped[str] = mapped_column(Text(), server_default="[]")
    mode: Mapped[str] = mapped_column(String(16), default="confirm", server_default="confirm")
    # @ 引用（PRD §2.1）：附件/文件引用的 JSON 数组字符串
    refs: Mapped[str | None] = mapped_column(Text())
    status: Mapped[str] = mapped_column(
        String(16), default="created", server_default="created", index=True
    )
    # 工作区隔离目录（ADR-013）：相对工作区根的路径（<task_id> 段，即 workspaces/<task_id>/）
    workspace_dir: Mapped[str] = mapped_column(String(512))
    created_by: Mapped[str] = mapped_column(String(64))  # JWT sub
    # T14 队列字段（ADR-005 模式复用）：Worker SKIP LOCKED 认领 + 崩溃重试计数
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer(), default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now()
    )


# hunk 评审状态（T14，PRD 门禁）：pending → accepted / rejected，全 accepted 才可提交
HUNK_STATUSES = ("pending", "accepted", "rejected")


class AgentHunk(Base):
    """diff 逐块评审载体（T14，PRD 门禁）：review 态从 workspace git diff 生成，按文件分块。

    门禁语义：commit 前要求全部 hunk accepted 且 checks 全绿；
    (task_id, idx) 唯一保证幂等生成（已存在则跳过再生成）。
    """

    __tablename__ = "agent_hunks"
    __table_args__ = (UniqueConstraint("task_id", "idx", name="uq_agent_hunks_task_idx"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="CASCADE"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer())
    path: Mapped[str] = mapped_column(String(512))  # 相对 workspace 根
    header: Mapped[str | None] = mapped_column(Text())  # diff 头（---/+++/@@ 行）
    content: Mapped[str | None] = mapped_column(Text())  # diff 块内容（截断落库）
    additions: Mapped[int | None] = mapped_column(Integer())
    deletions: Mapped[int | None] = mapped_column(Integer())
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class TaskEvent(Base):
    """任务事件（T11）：证据链实体，一表三用（SSE 直播 / Last-Event-ID 回放 / 审计证据链）。

    seq 按 task 内单调递增（(task_id, seq) 唯一约束兜底），该组合即游标查询键。
    """

    __tablename__ = "task_events"
    __table_args__ = (UniqueConstraint("task_id", "seq", name="uq_task_events_task_seq"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer())
    type: Mapped[str] = mapped_column(String(32))  # TASK_EVENT_TYPES
    data: Mapped[str | None] = mapped_column(Text())  # JSON 对象字符串
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Approval(Base):
    """审批单（T11，ADR-013 L3）：L2 命令挂起（interrupt）后的三选决策载体。"""

    __tablename__ = "approvals"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="CASCADE"), index=True
    )
    command: Mapped[str] = mapped_column(Text())
    scope: Mapped[str] = mapped_column(String(128))  # 命令作用域（工具名/命令模式）
    reason: Mapped[str | None] = mapped_column(Text())
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending", index=True
    )
    decision: Mapped[str | None] = mapped_column(String(16))  # once / always / deny
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AlwaysAllowed(Base):
    """「总是允许」策略（T11，ADR-013）：用户 × 工具 × 命令模式的放行授权，带有效期。

    决策 deny→once→always 写入即产生（decision=always 时同步落一行），
    求值归 T12 策略引擎；授权本身是权限面，须受审计跟踪（ADR-013 风险项）。
    """

    __tablename__ = "always_allowed"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    tool: Mapped[str] = mapped_column(String(32))
    pattern: Mapped[str] = mapped_column(String(256))  # 命令前缀/模式
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
