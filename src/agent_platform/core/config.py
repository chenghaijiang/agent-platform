"""应用配置：全部来自环境变量（12-Factor），应用进程本身不持有持久状态（ADR-004）。"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "agent-platform"
    app_version: str = "0.1.0"
    app_env: str = "local"

    # 平台主库（PostgreSQL + pgvector）。psycopg3 双模式：运行时 async / 迁移 sync 复用同一 URL
    # 宿主侧端口 15432/16379：与 compose 映射一致，避开开发机其它项目占用的 5432/6379
    database_url: str = (
        "postgresql+psycopg://postgres:postgres@localhost:15432/agent_platform"
    )

    # Redis：登录态/缓存/限流（v0.2 §6.2）
    redis_url: str = "redis://localhost:16379/0"

    # ---------------- 认证（T02，ADR-006）----------------
    # 自签 access token 密钥：生产必须经 env 注入（compose 用 :? 强制拦截缺失）
    auth_secret: str = "dev-only-secret-do-not-use-in-prod"
    access_token_ttl_minutes: int = 480

    # 认证方式装配点：业务代码只依赖 AuthProvider 协议，
    # 切换认证方式仅改此配置（local=内置口令，fake-oidc=演示第二实现）
    auth_provider: str = "local"

    # 初始管理员（seed 幂等，仅首次创建）
    admin_username: str = "admin"
    admin_initial_password: str = "Changeme-1234"

    # ---------------- 模型网关（T03，v0.2 §5.5 M1 形态）----------------
    # 模型映射表：改配置即切模型，零代码改动。默认指向 compose 内的 fake-openai 演示服务，
    # 切真实供应商只改 .env 四行（BASE_URL/API_KEY/两个模型名），凭证永不落代码仓库
    model_gateway_base_url: str = "http://fake-openai:8000/v1"
    model_gateway_api_key: str = "demo-key-not-for-prod"
    model_chat_model: str = "demo-chat-1"
    model_embedding_model: str = "demo-embedding-1"

    # ---------------- 对象存储（T05，MinIO 平台实例，独立于 Langfuse 的）----------------
    minio_endpoint: str = "http://minio:9000"
    minio_access_key: str = "agentplatform"
    minio_secret_key: str = "agent-minio-secret"
    minio_bucket: str = "agent-platform-documents"

    # ---------------- 入库任务（T05，ADR-005 任务模型）----------------
    ingest_lease_seconds: int = 60
    ingest_max_attempts: int = 3
    ingest_retry_backoff_seconds: int = 10
    ingest_poll_interval_seconds: float = 2.0
    ingest_health_port: int = 9101  # worker TCP 健康探针（compose healthcheck）

    # ---------------- agent-harness 工作台（ADR-019）----------------
    # Node sidecar 协议服务器地址：compose 内网 http://harness:4173，本地裸跑默认 127.0.0.1:4173；
    # 上游无认证，可访问性由 harness/api.py 网关的 require_auth 收口
    harness_base_url: str = "http://127.0.0.1:4173"


settings = Settings()
