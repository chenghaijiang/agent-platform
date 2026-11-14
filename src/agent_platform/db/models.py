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
    # 会话级绑定智能体（ADR-014 决策 3）：软引用 agent_profiles.key；
    # null = knowledge-assistant（存量会话零迁移，换智能体 = 开新会话）
    profile_key: Mapped[str | None] = mapped_column(String(64))
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


# ---------------- 统一智能工作台（ADR-014~017）----------------

# 引擎枚举（ADR-016 决策 1）：qa_graph 现有 RAG 图 | harness 自研内核 sidecar（ADR-019，前端直连）
# | runtime 二期自研内核平台内置形态（预留位）
AGENT_PROFILE_ENGINE_KINDS = ("qa_graph", "harness", "runtime")

# 消息信封类型（ADR-014 决策 4）：text 普通文本（问答/错误均以 assistant 文本信封落库）
CHAT_MESSAGE_TYPES = ("text",)


class AgentProfile(Base):
    """智能体预设（ADR-014 决策 1 / ADR-016 决策 1）：用户可选的 Agent 应用落地实体。

    prompt 不内嵌（prompt_key 软引用 prompts 发布体系，ADR-010）；
    tool_whitelist / model_policy 为 JSON 字符串（null = 全部工具 / 回落全局模型映射）。
    """

    __tablename__ = "agent_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(256))
    # 软引用 prompt_versions.template_key；无发布版本时引擎用代码内默认兜底（与 QA 现状一致）
    prompt_key: Mapped[str | None] = mapped_column(String(64))
    # JSON 数组字符串，如 ["read_files","run_command"]；null = 该引擎注册的全部工具
    tool_whitelist: Mapped[str | None] = mapped_column(Text())
    engine_kind: Mapped[str] = mapped_column(String(32), default="qa_graph", server_default="qa_graph")
    # 缺省执行模式（预留字段，当前引擎不读取）；QA 类智能体无工具执行，null
    default_mode: Mapped[str | None] = mapped_column(String(16))
    # JSON：{primary, fallbacks: []}；null 回落全局 MODEL_CHAT_MODEL（ADR-016 决策 2）
    model_policy: Mapped[str | None] = mapped_column(Text())
    enabled: Mapped[bool] = mapped_column(Boolean(), default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), onupdate=func.now()
    )


class ChatMessage(Base):
    """会话级消息流水（ADR-015 决策 5）：统一工作台聊天流的消息信封落库。

    `{seq, type, data}` —— (session_id, seq) 唯一即 SSE Last-Event-ID 续传游标；
    消息可查询、可回放，重启后聊天流从本表重建；
    checkpointer 继续只管 QA 图执行态（消息与执行态分库分责，ADR-008）。
    """

    __tablename__ = "chat_messages"
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_chat_messages_session_seq"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chat_sessions.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer())
    type: Mapped[str] = mapped_column(String(32))  # CHAT_MESSAGE_TYPES
    data: Mapped[str | None] = mapped_column(Text())  # JSON 对象字符串
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# 审计动作集（T08，ADR-007；T12/T13 起 AgentDesk 域新增）：提问 / 越权拦截 / 输入脱敏 / 输出脱敏
# AgentDesk 域动作带域标签（ADR-011：两域同表，payload 带 domain: agentdesk + task_id）；
# AgentDesk 引擎已退役（harness 取代，ADR-019），动作保留以解释存量审计事件
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
    "workbench.model_fallback",  # 统一工作台一期：fallback 链换模（ADR-016，实际命中模型看网关 usage）
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
