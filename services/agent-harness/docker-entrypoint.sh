#!/bin/sh
# agent-harness sidecar 入口（agent-platform 集成，ADR-019）
#
# 模型出口统一走平台 model_gateway 上游：提供 MODEL_GATEWAY_BASE_URL 时，每次启动
# 重新生成 ~/.harness/config.yaml（声明式：compose env 是单一事实源，改 .env 重启即生效）。
# 未提供时保留 harness 原生行为（首次启动自动写 Ollama 默认 config）。
set -eu

if [ -n "${MODEL_GATEWAY_BASE_URL:-}" ]; then
  mkdir -p "${HOME}/.harness"
  # 注意：api_key 会落盘到挂载卷中的 config.yaml——演示环境为 demo key；生产接入时
  # 应改用密钥管理服务注入（harness 原生只支持文件态 config）
  cat > "${HOME}/.harness/config.yaml" <<EOF
# agent-platform sidecar 集成：由 docker-entrypoint.sh 生成（勿手工编辑，重启会被覆盖）
model:
  default: ${MODEL_CHAT_MODEL:-qwen3.8:27b-mlx}
  providers:
    - name: platform-gateway
      type: openai-compatible
      base_url: ${MODEL_GATEWAY_BASE_URL}
      api_key: ${MODEL_GATEWAY_API_KEY:-demo-key-not-for-prod}
      # provider 必须显式声明其提供的模型名（schema 默认空数组→"none configured"），
      # default 模型按名路由到该 provider
      models: ["${MODEL_CHAT_MODEL:-qwen3.8:27b-mlx}"]
      capabilities:
        tool_calling: true
        streaming: true
        structured_output: true
        vision: true
        context_window: ${HARNESS_CONTEXT_WINDOW:-32768}
        max_output_tokens: ${HARNESS_MAX_OUTPUT_TOKENS:-8192}
loop:
  max_iterations: ${HARNESS_MAX_ITERATIONS:-25}
  parallel_tool_limit: 10
  retry_budget: 4
context:
  auto_compact_threshold: 0.7
permissions:
  sandbox: strict
  confirm_levels: [destructive, external]
vector_store:
  type: qdrant
  url: ${HARNESS_QDRANT_URL:-http://localhost:6333}
  # 容器默认无 Qdrant：向量路降级，SQLite FTS5 检索仍可用（kb 原生降级开关）
  degrade_to_fts_only: true
logging:
  trace_enabled: true
  level: info
EOF
  echo "harness config → 平台模型上游 ${MODEL_GATEWAY_BASE_URL}（model: ${MODEL_CHAT_MODEL:-qwen3.8:27b-mlx}）"
fi

exec node packages/server/dist/main.js
