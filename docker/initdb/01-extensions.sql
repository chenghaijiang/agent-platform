-- initdb 脚本：平台主库首次初始化时自动启用 pgvector（ADR-004：PG+pgvector 为 MVP 向量库）
-- 注意：SQL 注释必须用 --（PostgreSQL 不支持 # 风格注释）；
-- 该脚本仅在数据卷为空时执行一次，扩展随后持久化于数据卷中
CREATE EXTENSION IF NOT EXISTS vector;
