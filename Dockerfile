# 平台应用镜像（T01）：基于 uv 官方镜像，依赖层与应用层分离以命中构建缓存
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# 依赖层：仅凭 lock 文件安装，代码变更不触发依赖重装
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 应用层：源码 + 项目本体（editable 安装）
COPY . .
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# Compose 单机模式下迁移/seed 与应用同容器（ADR-004）：
# 启动前自动执行迁移 + 幂等 seed 初始管理员，exec 保证 uvicorn 接收 SIGTERM
CMD ["sh", "-c", "alembic upgrade head && python -m agent_platform.db.seed && exec uvicorn agent_platform.main:app --host 0.0.0.0 --port 8000"]
