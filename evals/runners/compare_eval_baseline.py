#!/usr/bin/env python3
"""Compare a current offline eval report against a versioned baseline."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

EPSILON = 1e-9

CHECKS: tuple[dict[str, Any], ...] = (
    {"metric": "rag.recallAt5", "direction": "drop", "limit": 0.02, "label": "RAG Recall@5"},
    {"metric": "rag.citationAccuracy", "direction": "drop", "limit": 0.02, "label": "Citation Accuracy"},
    {"metric": "toolPolicy.passRate", "direction": "drop", "limit": 0.0, "label": "Tool Policy Pass Rate"},
    {"metric": "injection.bypassRate", "direction": "increase", "limit": 0.05, "label": "Injection Bypass Rate"},
    {"metric": "injection.falsePositiveRate", "direction": "increase", "limit": 0.05, "label": "Injection False Positive Rate"},
)


def load_report(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def metric_value(report: dict[str, Any], dotted_path: str) -> float:
    value: Any = report
    for part in dotted_path.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(dotted_path)
        value = value[part]
    return float(value)


def compare_one(baseline: dict[str, Any], current: dict[str, Any], check: dict[str, Any]) -> dict[str, Any]:
    metric = str(check["metric"])
    limit = float(check["limit"])
    direction = str(check["direction"])
    try:
        old = metric_value(baseline, metric)
        new = metric_value(current, metric)
    except KeyError:
        return {
            "metric": metric,
            "label": check["label"],
            "status": "FAIL",
            "message": "metric missing from baseline or current report",
        }

    delta = round(new - old, 4)
    if direction == "drop":
        regression = old - new
        failed = regression > limit + EPSILON
        warned = regression > EPSILON
        rule = f"drop <= {limit:.4f}"
    else:
        regression = new - old
        failed = regression > limit + EPSILON
        warned = regression > EPSILON
        rule = f"increase <= {limit:.4f}"

    status = "FAIL" if failed else ("WARNING" if warned else "PASS")
    if limit == 0.0 and warned:
        status = "FAIL"

    return {
        "metric": metric,
        "label": check["label"],
        "baseline": round(old, 4),
        "current": round(new, 4),
        "delta": delta,
        "allowed": rule,
        "status": status,
    }


def compare_reports(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    checks = [compare_one(baseline, current, check) for check in CHECKS]
    if any(check["status"] == "FAIL" for check in checks):
        status = "FAIL"
    elif any(check["status"] == "WARNING" for check in checks):
        status = "WARNING"
    else:
        status = "PASS"
    return {
        "schemaVersion": "offline-eval-compare.v1",
        "status": status,
        "baseline": {
            "version": baseline.get("version", "unknown"),
            "gitSha": baseline.get("gitSha", "unknown"),
        },
        "current": {
            "version": current.get("version", "unknown"),
            "gitSha": current.get("gitSha", "unknown"),
        },
        "checks": checks,
    }


def render_text(result: dict[str, Any]) -> str:
    lines = [
        "=== Eval Baseline Compare ===",
        f"Baseline: {result['baseline']['version']} ({result['baseline']['gitSha']})",
        f"Current: {result['current']['version']} ({result['current']['gitSha']})",
        f"Overall: {result['status']}",
        "",
    ]
    for check in result["checks"]:
        if check["status"] == "FAIL" and "baseline" not in check:
            lines.append(f"- {check['label']}: {check['message']} [FAIL]")
            continue
        lines.append(
            f"- {check['label']}: {check['baseline']:.4f} -> {check['current']:.4f} "
            f"(delta {check['delta']:+.4f}; allowed {check['allowed']}) [{check['status']}]"
        )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compare offline eval report against a versioned baseline")
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--out", default="")
    parser.add_argument("--json", action="store_true", help="Print the machine-readable compare result")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = compare_reports(load_report(args.baseline), load_report(args.current))
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render_text(result))
    return 1 if result["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
