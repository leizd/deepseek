#!/usr/bin/env python3
"""Offline Skill System evaluation for v2.6."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from deepseek_infra.core.config import APP_VERSION  # noqa: E402
from deepseek_infra.infra.skills import evidence  # noqa: E402
from scripts.smoke_skills import run_checks  # noqa: E402

GOLDEN = REPO_ROOT / "evals" / "golden" / "skills" / "skill_eval_cases.jsonl"


def load_cases(path: Path = GOLDEN) -> list[dict[str, Any]]:
    cases = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        data = json.loads(line)
        if isinstance(data, dict):
            cases.append(data)
    return cases


def build_report(*, version: str) -> dict[str, Any]:
    cases = load_cases()
    with tempfile.TemporaryDirectory(prefix="deepseek-skill-eval-", ignore_cleanup_errors=True) as tmp:
        checks, details = run_checks(Path(tmp))
    details = {**details, "caseCount": len(cases), "cases": cases}
    return evidence.release_evidence_payload(checks=checks, version=version, details=details)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run offline Skill eval")
    parser.add_argument("--version", default=APP_VERSION)
    parser.add_argument("--out", default=str(REPO_ROOT / "evals" / "reports" / "skill-latest.json"))
    parser.add_argument("--strict", action="store_true", help="Exit 1 when the Skill eval status is not PASS.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report(version=args.version)
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "checks": report["checks"], "out": str(target)}, ensure_ascii=False, indent=2))
    return 1 if args.strict and report["status"] != "PASS" else 0


if __name__ == "__main__":
    raise SystemExit(main())
