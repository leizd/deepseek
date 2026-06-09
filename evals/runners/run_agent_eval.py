#!/usr/bin/env python3
"""Agent / tool-call regression eval: score recorded predictions against golden tasks.

Multi-agent runs need the cloud model, so this runner is offline and deterministic:
it joins a recorded predictions file with the golden tasks by ``id`` and scores Tool
Call Accuracy, Agent Success Rate, Prompt Regression, latency and token/USD cost with
the pure ``evaluation.harness`` library. Capture predictions from real runs to make it
a true regression gate; a runnable sample ships in ``evals/golden/``.

Usage::

    python evals/runners/run_agent_eval.py
    python evals/runners/run_agent_eval.py \
        --golden evals/golden/agent_tasks.jsonl \
        --predictions evals/golden/agent_predictions.sample.jsonl --json
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from deepseek_infra.infra.evaluation import harness  # noqa: E402


def evaluate(golden: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> harness.EvalReport:
    by_id = harness.index_by_id(predictions)
    rows: list[dict[str, Any]] = []
    for task in golden:
        task_id = str(task.get("id") or "")
        prediction = by_id.get(task_id, {})
        expected_tools = [str(t) for t in (task.get("expected_tools") or [])]
        actual_tools = [str(t) for t in (prediction.get("tools") or [])]
        expected_keywords = [str(kw) for kw in (task.get("expected_keywords") or [])]
        rows.append(
            {
                "id": task_id,
                "task": str(task.get("task") or ""),
                "tool": harness.tool_call_score(expected_tools, actual_tools),
                "success": harness.agent_success(prediction, expected_keywords),
                "latencyMs": float(prediction.get("latencyMs") or 0.0),
                "usage": prediction.get("usage") or {},
                "model": str(prediction.get("model") or ""),
                "hasPrediction": bool(prediction),
            }
        )
    return harness.build_agent_report(rows, suite="agent")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Agent / tool-call regression eval")
    parser.add_argument("--golden", default=str(REPO_ROOT / "evals" / "golden" / "agent_tasks.jsonl"))
    parser.add_argument("--predictions", default=str(REPO_ROOT / "evals" / "golden" / "agent_predictions.sample.jsonl"))
    parser.add_argument("--report-dir", default=str(REPO_ROOT / "evals" / "reports"))
    parser.add_argument("--no-report", action="store_true", help="Skip writing the JSON report.")
    parser.add_argument("--json", action="store_true", help="Print the machine-readable report dict instead of text.")
    args = parser.parse_args(argv)

    golden = harness.load_jsonl(args.golden)
    predictions = harness.load_jsonl(args.predictions)
    report = evaluate(golden, predictions)

    if args.json:
        import json

        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(report.to_text())
    if not args.no_report:
        path = report.write(args.report_dir)
        print(f"\nReport written to {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
