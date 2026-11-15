"""平台知识库 → harness 私有 KB 一次性导出同步脚本。

背景：代码工程师（harness sidecar）只查自己的私有 KB（容器内 SQLite FTS），
看不到平台知识库（PG + MinIO）。本脚本把平台库文档原文导出到 sidecar 容器并
调用 /api/harness/api/kb/ingest 建索引（经 /api/harness 网关，生产同路径）。

说明：
- harness KB 的向量臂依赖容器内 Ollama（localhost:11434 不可达）会自动降级
  fts_only —— FTS5 关键词检索照常可用；Qdrant/Ollama 接通后可重跑 --force 重建向量。
- 平台库后续新增文档需重跑本脚本同步（幂等：KB ingest 未变更跳过，--force 强制重建）。

用法（宿主机）：
    .venv/bin/python tools/export_kb_to_harness.py            # 全部 succeeded 文档
    .venv/bin/python tools/export_kb_to_harness.py --kb 2026 课程资料
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

from agent_platform.core.config import settings

BASE_URL = "http://localhost:8000"
HARNESS_CONTAINER = "agent-platform-harness-1"
APP_CONTAINER = "agent-platform-app-1"
CONTAINER_IMPORT_DIR = "/tmp/kb-import"
APP_EXPORT_DIR = "/tmp/kb-export"
JOB_POLL_INTERVAL_S = 4
JOB_TIMEOUT_S = 600

# MinIO S3 API 仅存在于 compose 内网（宿主未映射端口）：原文导出由 app 容器执行
# （同镜像内 agent_platform + 内网可达），再 docker cp 宿主中转。
_EXTRACT_SCRIPT = f"""
import json, os, sys
from agent_platform.core.config import settings
from agent_platform.ingest.storage import DocumentStorage
rows = json.loads(sys.argv[1])
storage = DocumentStorage.from_settings()
for kb_name, filename, object_key in rows:
    dest_dir = os.path.join("{APP_EXPORT_DIR}", kb_name.replace("/", "_"))
    target = os.path.join(dest_dir, filename)  # source_filename 可含子目录（上传保留相对路径）
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(storage.get(object_key))
print("exported", len(rows))
"""


def http_json(method: str, path: str, *, token: str | None = None, payload: dict | None = None, timeout: int = 60) -> dict:
    request = urllib.request.Request(BASE_URL + path, method=method)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    data = None
    if payload is not None:
        request.add_header("Content-Type", "application/json")
        data = json.dumps(payload).encode()
    try:
        with urllib.request.urlopen(request, data=data, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode()[:300]
        raise SystemExit(f"HTTP {exc.code} {method} {path}: {body}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kb", action="append", default=None, help="仅导出指定知识库名（可重复）；缺省=全部")
    parser.add_argument("--force", action="store_true", help="强制重建（忽略未变更跳过）")
    args = parser.parse_args()

    dsn = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    sql = (
        "SELECT kb.name, t.source_filename, t.object_key FROM ingest_tasks t "
        "JOIN knowledge_bases kb ON kb.id = t.kb_id WHERE t.status = 'succeeded'"
    )
    params: tuple | None = None
    if args.kb:
        sql += " AND kb.name = ANY(%s)"
        params = (args.kb,)
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    print(f"[1/5] 平台库待导出文档：{len(rows)} 篇")
    if not rows:
        return

    # [2/5] app 容器内从 MinIO 导出原文 → 宿主中转目录
    extract_host = Path(tempfile.mkdtemp(prefix="harness-kb-extract-"))
    transfer_root = Path(tempfile.mkdtemp(prefix="harness-kb-transfer-"))
    try:
        (extract_host / "extract.py").write_text(_EXTRACT_SCRIPT, encoding="utf-8")
        subprocess.run(
            ["docker", "cp", str(extract_host / "extract.py"), f"{APP_CONTAINER}:{APP_EXPORT_DIR}.py"],
            check=True,
        )
        subprocess.run(
            ["docker", "exec", APP_CONTAINER, "python", f"{APP_EXPORT_DIR}.py", json.dumps(rows)],
            check=True,
        )
        subprocess.run(
            ["docker", "cp", f"{APP_CONTAINER}:{APP_EXPORT_DIR}", str(transfer_root / "out")],
            check=True,
        )
        total = sum(1 for p in (transfer_root / "out").rglob("*") if p.is_file())
        print(f"[2/5] 原文经 app 容器导出：{total} 个文件")

        subprocess.run(
            ["docker", "cp", str(transfer_root / "out"), f"{HARNESS_CONTAINER}:{CONTAINER_IMPORT_DIR}"],
            check=True,
        )
        print(f"[3/5] 已 docker cp 至 {HARNESS_CONTAINER}:{CONTAINER_IMPORT_DIR}")
    finally:
        shutil.rmtree(extract_host, ignore_errors=True)
        shutil.rmtree(transfer_root, ignore_errors=True)
        subprocess.run(
            ["docker", "exec", APP_CONTAINER, "rm", "-rf", APP_EXPORT_DIR, f"{APP_EXPORT_DIR}.py"],
            check=False,
        )

    token = http_json(
        "POST",
        "/api/auth/login",
        payload={"username": "admin", "password": settings.admin_initial_password},
    )["access_token"]
    ingest_payload: dict = {"paths": [CONTAINER_IMPORT_DIR]}
    if args.force:
        ingest_payload["force"] = True
    job_id = http_json("POST", "/api/harness/api/kb/ingest", token=token, payload=ingest_payload)["jobId"]
    print(f"[4/5] ingest job {job_id} 轮询中（向量臂不可达时自动 fts_only 降级）…")
    deadline = time.monotonic() + JOB_TIMEOUT_S
    job: dict = {}
    while time.monotonic() < deadline:
        time.sleep(JOB_POLL_INTERVAL_S)
        job = http_json("GET", f"/api/harness/api/kb/jobs/{job_id}", token=token)
        if job.get("status") in ("done", "error"):
            break
    print(json.dumps(job.get("report") or job, ensure_ascii=False)[:1200])
    if job.get("status") != "done":
        raise SystemExit("ingest job 未在超时前完成，请检查 harness 日志")

    search = http_json("POST", "/api/harness/api/kb/search", token=token, payload={"query": "三大 Agent Harness 框架研究报告"})
    hits = search.get("hits", [])
    mode = search.get("mode")
    print(f"[5/5] harness KB 检索验证（mode={mode}）：{len(hits)} 命中")
    for hit in hits[:3]:
        text = hit.get("sourceTitle") or hit.get("title") or hit.get("snippet") or json.dumps(hit, ensure_ascii=False)
        print("   -", str(text)[:80].replace("\n", " "))

    subprocess.run(
        ["docker", "exec", HARNESS_CONTAINER, "rm", "-rf", CONTAINER_IMPORT_DIR],
        check=False,
    )
    print("清理完成。后续新增文档重跑本脚本即可增量同步。")


if __name__ == "__main__":
    sys.exit(main())
