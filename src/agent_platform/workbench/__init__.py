"""统一智能工作台（ADR-014~017 一期桥接层）。

渠道层新功能域：智能体可选（Profile）+ 会话级绑定 + 消息信封（chat_messages）
+ 双引擎路由（qa_graph 直跑现有 RAG 图 / agentdesk_bridge 桥接 AgentDesk 任务）
+ model_policy fallback 链。既有 chat / agentdesk 两域代码一期零侵入（Q9A/Q15A）：
本模块只做编排与转写，不复制其执行逻辑。
"""
