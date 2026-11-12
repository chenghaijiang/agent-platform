"""会话与问答 Run（T07）：LangGraph 组织检索→生成，Postgres Checkpointer 持久化执行态，SSE 流式返回。

ADR-008 分库分责：会话元数据（chat_sessions/chat_runs，业务库）与 LangGraph 执行态
（checkpoints 表，PostgresSaver 自动迁移）同库不同表，以 session.thread_id 映射。
"""
