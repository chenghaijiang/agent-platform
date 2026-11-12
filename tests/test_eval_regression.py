"""评测回归测试（T10，pytest 风格）：固定评测集上的检索命中率与要点覆盖率。

- 被测服务不可达时 pytest.skip（CI 无服务环境不失败）
- 有 baseline 时断言指标不低于基线减容差（回归提示，故意宽松）
- 无 baseline 时仅执行评测并落盘 last.json（首次记录）
"""

import json

import pytest

from evals.run_eval import BASELINE, LAST, _service_ready, run_eval

EVAL_BASE_URL = "http://localhost:8000"
TOLERANCE = 0.1  # 指标波动容差：评测作提示信号，不做硬门禁


def _live() -> bool:
    return _service_ready(EVAL_BASE_URL)


@pytest.fixture(scope="module")
def eval_result():
    if not _live():
        pytest.skip("eval service not reachable; evals run against a live deployment")
    return run_eval(EVAL_BASE_URL)


def test_eval_runs_and_records_report(eval_result):
    assert eval_result["cases"] > 0
    assert 0.0 <= eval_result["hit_rate"] <= 1.0
    assert 0.0 <= eval_result["coverage"] <= 1.0
    LAST.parent.mkdir(parents=True, exist_ok=True)
    LAST.write_text(json.dumps(eval_result, ensure_ascii=False, indent=2), encoding="utf-8")


def test_eval_metrics_not_below_baseline(eval_result):
    if not BASELINE.exists():
        pytest.skip("no baseline recorded yet; run evals/run_eval.py --update-baseline first")
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    assert eval_result["hit_rate"] >= baseline["hit_rate"] - TOLERANCE, (
        f"hit_rate regressed: {baseline['hit_rate']} -> {eval_result['hit_rate']}"
    )
    assert eval_result["coverage"] >= baseline["coverage"] - TOLERANCE, (
        f"coverage regressed: {baseline['coverage']} -> {eval_result['coverage']}"
    )
