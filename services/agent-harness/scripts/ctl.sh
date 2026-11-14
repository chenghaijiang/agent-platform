#!/usr/bin/env bash
# agent-harness 一键启停脚本
#
# 用法：
#   ./scripts/ctl.sh start    # 启动 qdrant + server（后台）
#   ./scripts/ctl.sh stop     # 停止 qdrant + server
#   ./scripts/ctl.sh status   # 查看各服务状态
#   ./scripts/ctl.sh restart  # 重启
#   ./scripts/ctl.sh logs [server|qdrant]  # 查看日志（默认 server）
#
# 目录约定：
#   ~/.harness/bin/qdrant         qdrant 二进制
#   ~/.harness/qdrant/storage/    qdrant 数据
#   ~/.harness/run/               PID 文件
#   ~/.harness/logs/              日志文件
set -eo pipefail

# 确保直连本地端口（不走 http_proxy —— 代理会让 http_probe 误判端口在线）
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="127.0.0.1,localhost"

# ── 路径常量 ──────────────────────────────────────────────
HARNESS_HOME="$HOME/.harness"
QDRANT_BIN="$HARNESS_HOME/bin/qdrant"
QDRANT_STORAGE="$HARNESS_HOME/qdrant/storage"
RUN_DIR="$HARNESS_HOME/run"
LOG_DIR="$HARNESS_HOME/logs"
SERVER_PID="$RUN_DIR/server.pid"
QDRANT_PID="$RUN_DIR/qdrant.pid"
SERVER_LOG="$LOG_DIR/server.log"
QDRANT_LOG="$HARNESS_HOME/qdrant/qdrant.log"

# 仓库根（脚本的 ../..）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ENTRY="$REPO_ROOT/packages/server/dist/main.js"

# 端口
QDRANT_PORT=6333
SERVER_PORT=4173
OLLAMA_PORT=11434

# launchd
UID_NUM=$(id -u)
QDRANT_LABEL="com.harness.qdrant"
QDRANT_PLIST="$HOME/Library/LaunchAgents/${QDRANT_LABEL}.plist"

# 颜色
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
info() { echo -e "${CYAN}ℹ${NC} $1"; }

# ── 辅助函数 ──────────────────────────────────────────────
mkdir -p "$RUN_DIR" "$LOG_DIR"

# 检查端口是否在监听（返回 0=在监听，1=不在）
port_alive() {
  lsof -ti:"$1" >/dev/null 2>&1
}

# 读 PID 文件（返回 PID 或空）
read_pid() {
  local f="$1"
  [ -f "$f" ] && cat "$f" 2>/dev/null || true
}

# 检查 PID 进程是否存活
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# HTTP 探针（返回 0=在线）
http_probe() {
  curl -s --max-time 2 "http://127.0.0.1:$1" >/dev/null 2>&1
}

# 按端口杀进程（处理多 PID：lsof -ti 可能返回多行）
# 先 SIGTERM，等 5×0.5s，仍存活则 SIGKILL
kill_by_port() {
  local port="$1"
  local label="$2"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    return 1
  fi
  # 逐个 SIGTERM（lsof 返回多行时不能把整块字符串传给 kill）
  local pid
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  # 等待退出
  local i
  for i in $(seq 1 10); do
    port_alive "$port" || break
    sleep 0.5
  done
  # 仍存活则 SIGKILL
  if port_alive "$port"; then
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 0.5
  fi
  if port_alive "$port"; then
    err "$label 端口 $port 仍有进程占用（kill -9 后仍在）"
    return 1
  fi
  ok "$label 已停止（按端口杀 pid: $(echo "$pids" | tr '\n' ' ')）"
  return 0
}

# launchd：检测 label 是否已加载
launchd_loaded() {
  local label="$1"
  launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1
}

# launchd：bootout（卸载并停止，KeepAlive 不再重启）
launchd_bootout() {
  local label="$1"
  launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
}

# launchd：bootstrap（从 plist 加载并启动）
launchd_bootstrap() {
  local plist="$1"
  launchctl bootstrap "gui/${UID_NUM}" "$plist" 2>/dev/null || true
}

# ── qdrant ────────────────────────────────────────────────
start_qdrant() {
  if port_alive "$QDRANT_PORT"; then
    warn "qdrant 端口 $QDRANT_PORT 已在监听，跳过启动"
    return 0
  fi
  if [ ! -f "$QDRANT_BIN" ]; then
    err "qdrant 二进制不存在：$QDRANT_BIN"
    info "下载方式：mkdir -p ~/.harness/bin && curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.harness/bin"
    return 1
  fi
  mkdir -p "$QDRANT_STORAGE"
  # 优先用 launchd（如果 plist 已生成）——这样关终端不退出
  if [ -f "$QDRANT_PLIST" ]; then
    launchd_bootstrap "$QDRANT_PLIST"
    local i
    for i in $(seq 1 8); do
      if http_probe "$QDRANT_PORT"; then
        ok "qdrant 已启动 (launchd 托管, :$QDRANT_PORT)"
        return 0
      fi
      sleep 1
    done
    # launchd 启动失败，fallback 到 nohup
    warn "launchd 启动未就绪，回退到 nohup"
  fi
  QDRANT__STORAGE__STORAGE_PATH="$QDRANT_STORAGE" \
    QDRANT__SERVICE__HOST="127.0.0.1" \
    nohup "$QDRANT_BIN" >>"$QDRANT_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$QDRANT_PID"
  # 等待 qdrant 就绪（最多 8 秒）
  local i
  for i in $(seq 1 8); do
    if http_probe "$QDRANT_PORT"; then
      ok "qdrant 已启动 (pid $pid, :$QDRANT_PORT)"
      return 0
    fi
    sleep 1
  done
  err "qdrant 启动超时，查看日志：$QDRANT_LOG"
  return 1
}

stop_qdrant() {
  # 先 bootout launchd（KeepAlive 托管时杀了会重启）
  if launchd_loaded "$QDRANT_LABEL"; then
    launchd_bootout "$QDRANT_LABEL"
    sleep 1
    if ! port_alive "$QDRANT_PORT"; then
      ok "qdrant 已停止（launchd bootout）"
      rm -f "$QDRANT_PID"
      return 0
    fi
    warn "launchd bootout 后端口仍占用，继续按端口杀"
  fi
  # PID 文件路径
  local pid
  pid=$(read_pid "$QDRANT_PID")
  if pid_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      pid_alive "$pid" || break
      sleep 0.5
    done
    pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    ok "qdrant 已停止 (pid $pid)"
  else
    # PID 文件不在但端口可能被别的 qdrant 占着
    if port_alive "$QDRANT_PORT"; then
      kill_by_port "$QDRANT_PORT" "qdrant" || true
    else
      warn "qdrant 未在运行"
    fi
  fi
  rm -f "$QDRANT_PID"
}

# ── server ────────────────────────────────────────────────
start_server() {
  if port_alive "$SERVER_PORT"; then
    warn "server 端口 $SERVER_PORT 已在监听，跳过启动"
    return 0
  fi
  if [ ! -f "$SERVER_ENTRY" ]; then
    info "未检测到构建产物，执行 pnpm build…"
    (cd "$REPO_ROOT" && pnpm build)
  fi
  # 直接在当前 shell 后台启动（不用子 shell——子 shell 退出会杀掉 nohup 进程）
  # bash -c 确保 cwd 是 REPO_ROOT（server 可能依赖相对路径）；exec 让 node 继承同一 PID
  nohup bash -c 'cd "$1" && exec node "$2"' _ "$REPO_ROOT" "$SERVER_ENTRY" >>"$SERVER_LOG" 2>&1 &
  local pid=$!
  echo "$pid" > "$SERVER_PID"
  # 等待 server 就绪（最多 15 秒）
  local i
  for i in $(seq 1 15); do
  if http_probe "$SERVER_PORT"; then
    ok "server 已启动 (pid $pid, :$SERVER_PORT)"
    # 打印模型信息（从 /api/health 取）
    local model="?"
    model=$(curl -s "http://127.0.0.1:$SERVER_PORT/api/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('model','?'))" 2>/dev/null) || model="?"
    info "当前模型：$model  日志：$SERVER_LOG"
    return 0
    fi
    sleep 1
  done
  err "server 启动超时，查看日志：$SERVER_LOG"
  return 1
}

stop_server() {
  local pid
  pid=$(read_pid "$SERVER_PID")
  if pid_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      pid_alive "$pid" || break
      sleep 0.5
    done
    pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    ok "server 已停止 (pid $pid)"
  else
    if port_alive "$SERVER_PORT"; then
      kill_by_port "$SERVER_PORT" "server" || true
    else
      warn "server 未在运行"
    fi
  fi
  rm -f "$SERVER_PID"
}

# ── ollama 检测（只读，不启停）────────────────────────────
check_ollama() {
  if http_probe "$OLLAMA_PORT"; then
    ok "ollama 在线 (:$OLLAMA_PORT)"
  else
    err "ollama 离线 (:$OLLAMA_PORT) — 模型后端不可用，server 会降级"
    info "启动方式：ollama serve（或打开 Ollama.app）"
  fi
}

# ── 命令分发 ──────────────────────────────────────────────
cmd_start() {
  echo "── agent-harness 启动 ──"
  check_ollama || true
  start_qdrant || true
  start_server || true
  echo ""
  cmd_status
}

cmd_stop() {
  echo "── agent-harness 停止 ──"
  stop_server || true
  stop_qdrant || true
  echo ""
  ok "已停止"
}

cmd_status() {
  echo "── agent-harness 状态 ──"
  # ollama
  if http_probe "$OLLAMA_PORT"; then
    echo -e "  ${GREEN}●${NC} ollama       :$OLLAMA_PORT  在线"
  else
    echo -e "  ${RED}○${NC} ollama       :$OLLAMA_PORT  离线"
  fi
  # qdrant
  local qpid
  qpid=$(read_pid "$QDRANT_PID")
  if http_probe "$QDRANT_PORT"; then
    echo -e "  ${GREEN}●${NC} qdrant      :$QDRANT_PORT  在线${qpid:+ (pid $qpid)}"
  else
    echo -e "  ${RED}○${NC} qdrant      :$QDRANT_PORT  离线"
  fi
  # server
  local spid
  spid=$(read_pid "$SERVER_PID")
  if http_probe "$SERVER_PORT"; then
    local health="" model="?" mode="?" degraded=""
    health=$(curl -s "http://127.0.0.1:$SERVER_PORT/api/health" 2>/dev/null) || health="{}"
    model=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('model','?'))" 2>/dev/null) || model="?"
    mode=$(curl -s "http://127.0.0.1:$SERVER_PORT/api/state" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print('智能体' if d.get('agentMode') else '问答')" 2>/dev/null) || mode="?"
    degraded=$(echo "$health" | python3 -c "import json,sys; d=json.load(sys.stdin); print('⚠降级' if d.get('degraded') else '')" 2>/dev/null) || degraded=""
    echo -e "  ${GREEN}●${NC} server      :$SERVER_PORT  在线${spid:+ (pid $spid)}  模型=$model  模式=$mode${degraded:+ $degraded}"
  else
    echo -e "  ${RED}○${NC} server      :$SERVER_PORT  离线"
  fi
  echo ""
  echo "  PID:  $RUN_DIR/{server,qdrant}.pid"
  echo "  日志: server → $SERVER_LOG"
  echo "        qdrant → $QDRANT_LOG"
}

cmd_restart() {
  cmd_stop
  echo ""
  sleep 1
  cmd_start
}

cmd_logs() {
  local target="${1:-server}"
  case "$target" in
    server|s) tail -f "$SERVER_LOG" ;;
    qdrant|q) tail -f "$QDRANT_LOG" ;;
    *) err "未知日志目标：$target（可选：server / qdrant）"; exit 1 ;;
  esac
}

# ── 入口 ──────────────────────────────────────────────────
main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    restart) cmd_restart ;;
    logs)    cmd_logs "$@" ;;
    *)
      cat <<'USAGE'
agent-harness 控制脚本

用法：
  ./scripts/ctl.sh start              启动 qdrant + server（后台）
  ./scripts/ctl.sh stop               停止 qdrant + server
  ./scripts/ctl.sh status             查看各服务状态
  ./scripts/ctl.sh restart            重启（stop + start）
  ./scripts/ctl.sh logs [server|qdrant]  查看日志（默认 server，Ctrl+C 退出）

服务：
  ollama  :11434  模型后端（脚本只检测，不启停——由你管理）
  qdrant  :6333   向量库
  server  :4173   agent-harness 协议服务器
USAGE
      exit 1
      ;;
  esac
}

main "$@"
