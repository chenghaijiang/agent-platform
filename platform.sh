#!/usr/bin/env bash
# ============================================================
# Agent Platform 一键启停脚本
# 用法：./platform.sh <command>
#   start    首次/常规启动（自动检查 .env 与密钥，改 .env 后用 restart 生效）
#   stop     停止全部服务（保留容器与数据卷）
#   restart  改 .env 后使配置生效（重建受影响容器，不动数据卷）
#   rebuild  改代码后重建镜像并启动（Dockerfile/依赖变更用）
#   status   服务健康总览 + 探针 + 当前模型映射（key 打码）
#   logs     跟踪服务日志：./platform.sh logs [app|worker|db|...]
#   down     删除容器（数据卷保留，重启后数据仍在）
#   help     显示本帮助
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

need_env() {
  if [ ! -f .env ]; then
    echo "错误：缺 .env 文件。执行：cp .env.example .env，并按文件内注释生成密钥" >&2
    exit 1
  fi
}

wait_healthy() {
  echo "等待 app 容器 healthy ..."
  for _ in $(seq 1 40); do
    st=$(docker inspect --format '{{.State.Health.Status}}' agent-platform-app-1 2>/dev/null || echo "missing")
    [ "$st" = "healthy" ] && { echo "app: healthy"; return 0; }
    sleep 3
  done
  echo "警告：app 未在 120s 内 healthy，查看日志：./platform.sh logs app" >&2
  return 1
}

case "${1:-status}" in
  start)
    need_env
    docker compose up -d
    wait_healthy
    ./platform.sh status
    ;;
  stop)
    docker compose stop
    echo "已停止（数据卷保留；重新启动：./platform.sh start）"
    ;;
  restart)
    need_env
    # up -d 会自动重建配置（.env/compose 定义）发生变化的容器，数据卷不受影响
    docker compose up -d
    wait_healthy
    ./platform.sh status
    ;;
  rebuild)
    need_env
    docker compose up -d --build
    wait_healthy
    ./platform.sh status
    ;;
  status)
    echo "=== 服务状态 ==="
    docker compose ps --format "table {{.Name}}\t{{.Status}}"
    echo "=== 平台探针 ==="
    printf "healthz: %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8000/healthz || echo unreachable)"
    printf "readyz : %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8000/readyz || echo unreachable)"
    printf "web    : %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8000/ || echo unreachable)"
    printf "harness : %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8000/api/harness/api/health || echo unreachable)  # 经网关（401=网关在但未带登录态；000=sidecar 未起）"
    printf "langfuse: %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/api/public/health || echo unreachable)"
    echo "=== 当前模型映射（key 打码） ==="
    grep -E "^MODEL_(GATEWAY_BASE_URL|CHAT_MODEL|EMBEDDING_MODEL)=" .env || echo "（.env 无 MODEL_* 配置，用 compose 默认 fake-openai）"
    ;;
  logs)
    docker compose logs -f --tail=100 "${2:-app}"
    ;;
  down)
    docker compose down
    echo "容器已删除（数据卷保留；彻底清数据：docker compose down -v，慎用）"
    ;;
  help|*)
    sed -n '2,14p' "$0"
    ;;
esac
