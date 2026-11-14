"""AgentDesk 策略引擎（T12，ADR-013 四层拦截的 L2/L3；借鉴 ZCode permission/service.ts，ADR-012）。

求值顺序（红线先于一切，永远不可被模式或授权救回）：
1. **L2 红线**：正则 + 命令解析（shlex）双层匹配，独立于任何模式与授权，命中即 deny；
2. **工作区/owns 边界**：读路径须落在 Task 工作区内（L1 路径约束），写路径还须命中 owns 声明，越界 deny；
3. **L3 模式矩阵**：四档模式 × 工具风险等级（L0 只读 / L1 写文件 / L2 可执行命令）求值；
4. **always_allowed**：仅能把 require_approval 升级为 allow，不能救任何 deny。

策略引擎是纯函数求值（不触库、不做 IO），拦截与审计由工具执行器（tools.py）落实。
"""

import fnmatch
import re
import shlex
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

# 工具风险等级（ADR-013 L3）
RISK_READONLY = "L0"
RISK_FILE_WRITE = "L1"
RISK_COMMAND = "L2"

# 求值结论
POLICY_ALLOW = "allow"
POLICY_DENY = "deny"
POLICY_REQUIRE_APPROVAL = "require_approval"

# deny 原因类别（kind）：红线 / 越界（工作区根或 owns）/ 模式拒绝 / 参数不合法
KIND_REDLINE = "redline"
KIND_OUT_OF_BOUNDS = "out_of_bounds"
KIND_MODE_DENIED = "mode_denied"
KIND_INVALID_ARGS = "invalid_args"

# 四档模式 × 风险等级矩阵（ADR-013 L3：L2 且非「完全访问」→ 审批 interrupt；
# 「计划模式」只读，写类操作一律 deny——确认计划后由 Graph 切 auto_edit）
MODE_POLICY_MATRIX: dict[str, dict[str, str]] = {
    "confirm": {
        RISK_READONLY: POLICY_ALLOW,
        RISK_FILE_WRITE: POLICY_REQUIRE_APPROVAL,
        RISK_COMMAND: POLICY_REQUIRE_APPROVAL,
    },
    "auto_edit": {
        RISK_READONLY: POLICY_ALLOW,
        RISK_FILE_WRITE: POLICY_ALLOW,
        RISK_COMMAND: POLICY_REQUIRE_APPROVAL,
    },
    "plan": {
        RISK_READONLY: POLICY_ALLOW,
        RISK_FILE_WRITE: POLICY_DENY,
        RISK_COMMAND: POLICY_DENY,
    },
    "full_access": {
        RISK_READONLY: POLICY_ALLOW,
        RISK_FILE_WRITE: POLICY_ALLOW,
        RISK_COMMAND: POLICY_ALLOW,
    },
}

# 平台自身治理代码路径（审计与权限模块，ADR-013 红线之「触碰审计与权限模块」）
_GOVERNANCE_PATH = r"agent_platform[/\\](?:guardrails|auth|db)\b|audit_events\b|always_allowed\b"

# 红线清单——命令文本匹配（run_command 用；label 用于事件与审计留痕）
REDLINE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # 格式化文件系统 / 裸写块设备
    ("disk_destructive", re.compile(r"\bmkfs(?:\.\S+)?\b|\bdd\b[^;&|]*\bof=/dev/")),
    # 读取密钥凭据文件（动词 + 路径形态）
    (
        "secret_file_read",
        re.compile(
            r"(?:^|[\s;&|(])(?:cat|head|tail|less|more|vi|vim|nano|open|base64|strings)\s+"
            r"[^;&|]*?(?:\.env\b|id_rsa\b|\.ssh[/\s]|/etc/shadow\b|credentials\b)",
            re.IGNORECASE,
        ),
    ),
    # 强推远程分支
    ("force_push", re.compile(r"\bgit\s+push\b[^;&|]*(?:--force\b|\s-f\b)")),
    # 改写历史（reset --hard / rebase / filter-branch）
    ("history_rewrite", re.compile(r"\bgit\s+(?:reset\s+--hard\b|rebase\b|filter-branch\b)")),
    # 下载并执行非白名单脚本（管道进 shell）
    ("remote_script_exec", re.compile(r"\b(?:curl|wget)\b[^;&|]*\|\s*(?:ba|z|da)?sh\b", re.IGNORECASE)),
    # 触碰平台审计与权限模块
    ("governance_module", re.compile(_GOVERNANCE_PATH)),
)

# 红线清单——路径文本匹配（read_files / apply_patch 的路径参数用）
REDLINE_PATH_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("secret_file_read", re.compile(r"(?:^|/)\.env$|id_rsa\b|\.ssh/|credentials\b|/etc/shadow\b", re.IGNORECASE)),
    ("governance_module", re.compile(_GOVERNANCE_PATH)),
)

# cwd 逃逸：cd 到工作区根之外（绝对路径 / 家目录 / 上级目录）。
# 前置边界仅限行首或 ;&| ——避免 grep "cd /" 这类字面量误报
_CWD_ESCAPE = re.compile(r"(?:^|[;&|])\s*cd\s+(?:[/~]|\.\.)")

# rm 组合 flag 的灾难性删除由 shlex 解析层判断（flag 组合形态多变，正则易漏）：
# 目标限定根目录/家目录/通配根，普通文件与子目录删除不拦
_DESTRUCTIVE_TARGETS = {"/", "/*", "~", "~/*", "*"}


@dataclass(frozen=True)
class PolicyDecision:
    """求值结论：decision + 拦截类别 + 人读原因（写入事件与审计留痕）。"""

    decision: str
    kind: str | None = None
    detail: str | None = None


def check_redline_text(text: str) -> tuple[str, str] | None:
    """命令文本红线匹配（正则层）：返回 (label, 命中片段) 或 None。"""
    for label, pattern in REDLINE_PATTERNS:
        hit = pattern.search(text)
        if hit:
            return label, hit.group(0)
    return None


def check_redline_path(path_text: str) -> tuple[str, str] | None:
    """路径文本红线匹配（读/写路径参数用）。"""
    for label, pattern in REDLINE_PATH_PATTERNS:
        hit = pattern.search(path_text)
        if hit:
            return label, hit.group(0)
    return None


def destructive_delete_hit(command: str) -> bool:
    """命令解析层（shlex）：rm 组合 -r -f 类 flag 且目标为根目录/家目录/通配根。"""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    for i, tok in enumerate(tokens):
        if tok != "rm" and not tok.endswith("/rm"):
            continue
        flags = ""
        rest = tokens[i + 1 :]
        n_flags = 0
        for t in rest:
            if t.startswith("-"):
                flags += t
                n_flags += 1
            else:
                break
        lowered = flags.lower()
        if "r" in lowered and "f" in lowered:
            targets = [t for t in rest[n_flags:] if not t.startswith("-")]
            if targets and targets[0] in _DESTRUCTIVE_TARGETS:
                return True
    return False


def cwd_escape_hit(command: str) -> bool:
    """run_command 的 cwd 逃逸检测：cd 到绝对路径/家目录/上级目录即视为逃出工作区。"""
    return _CWD_ESCAPE.search(command) is not None


def resolve_in_task_dir(task_dir: Path, raw_path: str) -> Path | None:
    """把相对路径归并到工作区根内（resolve 吃掉 .. 与符号链接形态）。

    返回 None 表示越界（绝对路径指外、.. 上跳、恰好等于工作区根）。
    """
    candidate = (task_dir / raw_path.strip()).resolve()
    root = task_dir.resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        return None
    return candidate


def owns_match(owns: list[str], rel_path: str) -> bool:
    """写路径是否命中 Task 声明的 owns 集合（glob 语义，fnmatch）。"""
    return any(fnmatch.fnmatch(rel_path, pattern) for pattern in owns)


def match_grant(grants, user_id: str, tool: str, text: str) -> bool:
    """「总是允许」求值：user × tool × pattern（fnmatch 或前缀），过期授权无效。"""
    now = datetime.now(UTC)
    for grant in grants:
        if grant.user_id != user_id or grant.tool != tool:
            continue
        if grant.expires_at is not None:
            expires = grant.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=UTC)
            if expires < now:
                continue
        if fnmatch.fnmatch(text, grant.pattern) or text.startswith(grant.pattern):
            return True
    return False


def _require_args(args: dict, keys: tuple[str, ...], types: tuple[type, ...]) -> str | None:
    """最小参数校验：返回缺失/类型错误的键名（None=合法）。防御 LLM 传参畸形。"""
    for key, expected in zip(keys, types):
        value = args.get(key)
        if not isinstance(value, expected) or (isinstance(value, str) and not value.strip()):
            return key
    return None


def evaluate(
    *,
    tool: str,
    mode: str,
    risk_level: str,
    args: dict,
    task_dir: Path,
    owns: list[str],
    grants,
    user_id: str,
) -> PolicyDecision:
    """对一次工具调用求值（纯函数）：参数校验 → 红线 → 边界 → 模式矩阵 → 授权升级。"""
    matrix = MODE_POLICY_MATRIX.get(mode)
    if matrix is None:
        return PolicyDecision(POLICY_DENY, KIND_INVALID_ARGS, f"unknown mode: {mode}")

    # ---- 参数合法性（防御 LLM 传参畸形）----
    required: dict[str, tuple[tuple[str, ...], tuple[type, ...]]] = {
        "read_files": (("paths",), (list,)),
        "apply_patch": (("path", "content"), (str, str)),
        "run_command": (("command",), (str,)),
        "git_commit": (("message",), (str,)),
    }
    if tool not in required:
        return PolicyDecision(POLICY_DENY, KIND_INVALID_ARGS, f"unknown tool: {tool}")
    keys, types = required[tool]
    for key, expected in zip(keys, types):
        value = args.get(key)
        bad = not isinstance(value, expected) or (isinstance(value, str) and not value.strip())
        if key == "paths" and isinstance(value, list):
            bad = not value or not all(isinstance(p, str) and p.strip() for p in value)
        if bad:
            return PolicyDecision(POLICY_DENY, KIND_INVALID_ARGS, f"missing/invalid arg: {key}")

    # ---- L2 红线（先于边界与模式；任何模式含完全访问下均拒绝）----
    if tool == "run_command":
        command = args["command"]
        hit = check_redline_text(command)
        if hit is None and destructive_delete_hit(command):
            hit = ("destructive_delete", command.strip()[:120])
        if hit:
            return PolicyDecision(POLICY_DENY, KIND_REDLINE, f"{hit[0]}: {hit[1]}")
        if cwd_escape_hit(command):
            return PolicyDecision(
                POLICY_DENY, KIND_OUT_OF_BOUNDS, f"cwd escape: {command.strip()[:120]}"
            )
    elif tool in ("read_files", "apply_patch"):
        raw_paths = args["paths"] if tool == "read_files" else [args["path"]]
        for raw in raw_paths:
            hit = check_redline_path(raw)
            if hit:
                return PolicyDecision(POLICY_DENY, KIND_REDLINE, f"{hit[0]}: {hit[1]}")

    # ---- L1 工作区/owns 边界 ----
    if tool in ("read_files", "apply_patch"):
        raw_paths = args["paths"] if tool == "read_files" else [args["path"]]
        for raw in raw_paths:
            if resolve_in_task_dir(task_dir, raw) is None:
                return PolicyDecision(
                    POLICY_DENY, KIND_OUT_OF_BOUNDS, f"path outside workspace: {raw}"
                )
        if tool == "apply_patch":
            rel = PurePosixPath(args["path"].strip()).as_posix()
            if not owns_match(owns, rel):
                return PolicyDecision(POLICY_DENY, KIND_OUT_OF_BOUNDS, f"path not in owns: {rel}")

    # ---- L3 模式矩阵 ----
    base = matrix[risk_level]
    if base == POLICY_DENY:
        return PolicyDecision(
            POLICY_DENY, KIND_MODE_DENIED, f"mode {mode} only allows read-only tools"
        )

    # ---- always_allowed 升级（仅救 require_approval，救不了任何 deny）----
    # 注意分支求值：dict 字面量会先求值全部 value，args 里没有其他工具的键会 KeyError
    if base == POLICY_REQUIRE_APPROVAL:
        if tool == "run_command":
            target = args["command"]
        elif tool == "apply_patch":
            target = args["path"]
        else:
            target = "git commit"
        if match_grant(grants, user_id, tool, target):
            return PolicyDecision(POLICY_ALLOW)
        return PolicyDecision(
            POLICY_REQUIRE_APPROVAL, detail=f"{tool} in {mode} mode requires approval"
        )

    return PolicyDecision(POLICY_ALLOW)
