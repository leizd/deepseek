#!/usr/bin/env python3
"""Report-only adversarial prompt-injection evaluation.

This runner complements ``run_tool_eval.py``. The fixed golden regression suite
still gates CI; this adversarial set is intentionally broader and reports
block/false-positive/bypass rates without failing the build yet.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from deepseek_infra.infra.evaluation import harness  # noqa: E402
from deepseek_infra.infra.gateway import context_taint  # noqa: E402

_BASE64_RE = re.compile(r"\b[A-Za-z0-9+/]{24,}={0,2}\b")


def decoded_base64_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    for match in _BASE64_RE.findall(str(text or "")):
        padded = match + ("=" * ((4 - len(match) % 4) % 4))
        try:
            raw = base64.b64decode(padded, validate=True)
            decoded = raw.decode("utf-8", errors="ignore").strip()
        except (binascii.Error, ValueError):
            continue
        if decoded:
            candidates.append(decoded)
    return candidates


def scan_case(case: dict[str, Any]) -> dict[str, Any]:
    text = str(case.get("text") or "")
    expected = str(case.get("expected") or "block")
    started = time.perf_counter()
    scans = [context_taint.scan_text(text)]
    scans.extend(context_taint.scan_text(candidate) for candidate in decoded_base64_candidates(text))
    latency_ms = (time.perf_counter() - started) * 1000.0
    injection = sum(scan.injection for scan in scans)
    exfiltration = sum(scan.exfiltration for scan in scans)
    tool_directive = sum(scan.tool_directive for scan in scans)
    blocked = (injection + exfiltration + tool_directive) > 0
    should_block = expected == "block"
    return {
        "id": str(case.get("id") or ""),
        "category": str(case.get("category") or ""),
        "expected": expected,
        "actual": "block" if blocked else "allow",
        "blocked": blocked,
        "passed": blocked == should_block,
        "injectionHits": injection,
        "exfiltrationHits": exfiltration,
        "toolDirectiveHits": tool_directive,
        "latencyMs": round(latency_ms, 3),
    }


def evaluate(golden: list[dict[str, Any]]) -> harness.EvalReport:
    rows = [scan_case(case) for case in golden]
    attack_rows = [row for row in rows if row["expected"] == "block"]
    benign_rows = [row for row in rows if row["expected"] == "allow"]
    blocked_attacks = [bool(row["blocked"]) for row in attack_rows]
    false_positives = [bool(row["blocked"]) for row in benign_rows]
    latency = harness.latency_benchmark([float(row["latencyMs"]) for row in rows])
    block_rate = harness.aggregate_ratio(blocked_attacks)
    metrics = {
        "blockRate": block_rate,
        "falsePositiveRate": harness.aggregate_ratio(false_positives),
        "bypassRate": round(1.0 - block_rate, 4) if attack_rows else 0.0,
        "avgLatencyMs": latency["avgMs"],
        "p95LatencyMs": latency["p95Ms"],
    }
    return harness.EvalReport(
        suite="injection-adversarial",
        cases=len(rows),
        metrics=metrics,
        benchmarks={"latency": latency, "reportOnly": True},
        details=rows,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report-only adversarial prompt-injection eval")
    parser.add_argument("--golden", default=str(REPO_ROOT / "evals" / "golden" / "injection_adversarial.jsonl"))
    parser.add_argument("--report-dir", default=str(REPO_ROOT / "evals" / "reports"))
    parser.add_argument("--no-report", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    report = evaluate(harness.load_jsonl(args.golden))

    if args.json:
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(report.to_text())
        bypasses = [row for row in report.details if row["expected"] == "block" and not row["blocked"]]
        false_positives = [row for row in report.details if row["expected"] == "allow" and row["blocked"]]
        if bypasses:
            print("\nBypasses (report-only):")
            for row in bypasses:
                print(f"  - {row['id']} ({row['category']})")
        if false_positives:
            print("\nFalse positives (report-only):")
            for row in false_positives:
                print(f"  - {row['id']} ({row['category']})")
    if not args.no_report:
        path = report.write(args.report_dir)
        print(f"\nReport written to {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
