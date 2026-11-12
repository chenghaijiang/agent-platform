"""评测脚本（T10，ADR-010）：固定评测集上计算检索命中率与答案要点覆盖率。

- 检索命中率 hit_rate：top_k 结果包含期望文档的比例；expected_document 为空的条目
  期望检索为空（无依据场景）
- 要点覆盖率 coverage：回答文本覆盖 must_cover 词的比例
- 结果写 evals/results/last.json；存在 baseline.json 时打印对比 delta；
  --update-baseline 将当前结果写为基线
- 服务不可达：输出 SKIPPED 并以 0 退出——评测结果作为提示、不阻塞发布（ADR-010）
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parent
GOLDEN_SET = BASE_DIR / "golden_set.jsonl"
RESULTS_DIR = BASE_DIR / "results"
LAST = RESULTS_DIR / "last.json"
BASELINE = RESULTS_DIR / "baseline.json"


def _service_ready(base_url: str) -> bool:
    try:
        resp = httpx.get(f"{base_url}/healthz", timeout=3)
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


def _login(base_url: str) -> str:
    username = os.environ.get("EVAL_USERNAME", "admin")
    password = os.environ.get("EVAL_PASSWORD", "Changeme-1234")
    resp = httpx.post(
        f"{base_url}/api/auth/login", json={"username": username, "password": password}, timeout=10
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def run_eval(base_url: str, *, top_k: int = 5) -> dict:
    """执行评测：逐条调用检索与问答链路，输出指标与明细。"""
    token = _login(base_url)
    headers = {"Authorization": f"Bearer {token}"}
    cases = [json.loads(line) for line in GOLDEN_SET.read_text(encoding="utf-8").splitlines() if line.strip()]

    hits = []
    coverages = []
    details = []
    for case in cases:
        # 检索命中率
        search = httpx.post(
            f"{base_url}/api/search",
            headers=headers,
            json={"query": case["question"], "top_k": top_k},
            timeout=30,
        )
        expected = case["expected_document"]
        if expected:
            docs = [c["document"] for c in search.json().get("results", [])]
            hit = expected in docs
        else:
            hit = len(search.json().get("results", [])) == 0
        hits.append(hit)

        # 要点覆盖率（走完整问答链路：SSE delta 拼接即回答）
        sid = httpx.post(f"{base_url}/api/sessions", headers=headers, json={"title": "eval"}, timeout=10).json()["id"]
        sse_text = ""
        with httpx.stream(
            "POST",
            f"{base_url}/api/sessions/{sid}/chat",
            headers=headers,
            json={"question": case["question"], "top_k": top_k},
            timeout=60,
        ) as resp:
            for chunk in resp.iter_text():
                sse_text += chunk
        answer = _extract_answer(sse_text)
        must = case.get("must_cover", [])
        coverage = (sum(1 for w in must if w in answer) / len(must)) if must else 1.0
        coverages.append(coverage)
        details.append(
            {"id": case["id"], "hit": hit, "coverage": round(coverage, 3), "answer_preview": answer[:60]}
        )

    result = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "base_url": base_url,
        "hit_rate": round(sum(hits) / len(hits), 3),
        "coverage": round(sum(coverages) / len(coverages), 3),
        "cases": len(cases),
        "details": details,
    }
    return result


def _extract_answer(sse_text: str) -> str:
    """从 SSE 文本中提取 delta 帧拼接的回答全文。"""
    text = ""
    for block in sse_text.split("\n\n"):
        if not block.startswith("event: delta"):
            continue
        for line in block.splitlines():
            if line.startswith("data: "):
                text += json.loads(line[6:])["text"]
    return text


def compare(current: dict, baseline: dict) -> str:
    lines = [
        f"hit_rate : {baseline['hit_rate']} -> {current['hit_rate']} (delta {round(current['hit_rate'] - baseline['hit_rate'], 3)})",
        f"coverage : {baseline['coverage']} -> {current['coverage']} (delta {round(current['coverage'] - baseline['coverage'], 3)})",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="run retrieval/answer evals against a live deployment")
    parser.add_argument("--base-url", default=os.environ.get("EVAL_BASE_URL", "http://localhost:8000"))
    parser.add_argument("--update-baseline", action="store_true", help="write current result as baseline")
    args = parser.parse_args()

    if not _service_ready(args.base_url):
        print(f"SKIPPED: service not reachable at {args.base_url} (evals are advisory, not blocking)")
        return 0

    result = run_eval(args.base_url)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    LAST.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"hit_rate={result['hit_rate']} coverage={result['coverage']} ({result['cases']} cases)")

    if BASELINE.exists():
        baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
        print("--- vs baseline ---")
        print(compare(result, baseline))
    else:
        print("no baseline yet; run with --update-baseline to record one")
    if args.update_baseline:
        BASELINE.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print("baseline updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
