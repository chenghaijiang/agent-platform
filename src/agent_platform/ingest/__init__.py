"""知识入库流水线（T05）：MVP 唯一的异步任务，PG 表 + SKIP LOCKED 租约（ADR-005）。

链路：上传端点建任务（幂等）→ Worker 认领 → 解析（PDF/Markdown）→ 切分
→ 经模型网关向量化 → chunks 落 pgvector；原始文件归档对象存储。
调用方不应直接 import 本包子模块之外的内容——对外入口是 api.py 的端点。
"""
