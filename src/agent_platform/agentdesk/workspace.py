"""AgentDesk 工作区底座（T11，ADR-013）：Task 隔离目录的分配与演示仓装载。

工作区形态：workspaces/<task_id>/（compose 为 app/worker 挂同一命名卷，挂载点
/app/workspaces），Task 级路径隔离——这是路径隔离而非操作系统级沙箱（ADR-013
诚实边界声明，生产形态为阶段二）。

每个 Task 初始化时装载 payment-console 演示仓（pricing 模块 + pytest + ruff，含一个
可被修复的预置缺陷），并以 git 基线提交固定初始状态：T13 的 hunk diff 与 workspace
分支提交依赖此基线，git 缺失时降级为纯目录（不阻塞工作区可用）。
"""

import logging
import shutil
import subprocess
import uuid
from pathlib import Path

from agent_platform.core.config import settings

logger = logging.getLogger(__name__)

# 演示仓名（agentdesk-implementation.md §5 / ADR-013：pricing + pytest + ruff 迷你项目）
DEMO_REPO_NAME = "payment-console"
_DEMO_REPO_TEMPLATE = Path(__file__).parent / "demo_repo" / DEMO_REPO_NAME
_GIT_BASELINE_MESSAGE = "baseline: payment-console demo repo"
_GIT_IDENTITY = ("-c", "user.name=agent-platform", "-c", "user.email=agent@platform.local")


class WorkspaceManager:
    """Task ↔ 工作区目录的分配器：根目录来自配置，目录创建与演示仓装载幂等。"""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    @classmethod
    def from_settings(cls) -> "WorkspaceManager":
        return cls(settings.agentdesk_workspaces_dir)

    def allocate(self, task_id: uuid.UUID) -> Path:
        """为 Task 分配隔离目录并装载演示仓。

        幂等约定：目录已存在即跳过复制（Worker 重试/重复分配不覆盖已有内容），
        返回 Task 工作区目录（演示仓在其下 payment-console/）。
        """
        task_dir = self.root / str(task_id)
        task_dir.mkdir(parents=True, exist_ok=True)
        repo_dir = task_dir / DEMO_REPO_NAME
        if not repo_dir.exists():
            shutil.copytree(_DEMO_REPO_TEMPLATE, repo_dir)
            self._git_baseline(repo_dir)
        return task_dir

    def task_dir(self, task_id: uuid.UUID) -> Path:
        """Task 工作区目录（不创建；读侧使用，如 T12 工具层的路径约束求值）。"""
        return self.root / str(task_id)

    def _git_baseline(self, repo_dir: Path) -> None:
        """演示仓 git init + 基线提交（预置缺陷态入库，修复即产生可审阅 diff）。

        git 缺失或失败仅告警不阻塞：本地裸环境可继续做文件级演示，
        容器内由镜像提供 git（见 Dockerfile），T13 提交工具依赖此基线。
        """
        try:
            subprocess.run(
                ["git", "init", "-q", "-b", "main"],
                cwd=repo_dir,
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "add", "-A"], cwd=repo_dir, check=True, capture_output=True
            )
            subprocess.run(
                ["git", *_GIT_IDENTITY, "commit", "-q", "-m", _GIT_BASELINE_MESSAGE],
                cwd=repo_dir,
                check=True,
                capture_output=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as exc:
            logger.warning("workspace git baseline skipped (%s): %s", repo_dir, exc)
