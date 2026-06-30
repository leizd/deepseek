#!/usr/bin/env python3
"""Offline smoke for the Skill Workbench UI integration."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from deepseek_infra.core.config import APP_VERSION  # noqa: E402
from deepseek_infra.infra.skills import evidence  # noqa: E402


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _contains_all(text: str, needles: tuple[str, ...]) -> bool:
    return all(needle in text for needle in needles)


def run_checks() -> tuple[dict[str, str], dict[str, Any]]:
    index = _read("static/index.html")
    chat = _read("static/modules/chat.js")
    skills = _read("static/modules/skills.js")
    styles = _read("static/styles.css")
    service_worker = _read("static/sw.js")
    ci = _read(".github/workflows/ci.yml")

    checks: dict[str, str] = {}
    details: dict[str, Any] = {}

    checks["skillWorkbenchEntrypoint"] = "PASS" if _contains_all(
        index,
        (
            'id="skillButton"',
            'id="skillPanel"',
            'id="skillRunForm"',
            'id="skillBuiltinList"',
            'id="skillCustomList"',
            'id="skillRecentRunList"',
        ),
    ) else "FAIL"

    checks["skillRunSchemaForm"] = "PASS" if _contains_all(
        skills,
        (
            "function renderRunFields",
            "schema.properties",
            "data-run-field",
            "prop.enum",
            "input.required = true",
            "collectRunInput",
        ),
    ) else "FAIL"

    checks["skillApiActions"] = "PASS" if _contains_all(
        skills,
        (
            'action: "list"',
            'action: "run"',
            'const action = skill.disabled ? "enable" : "disable"',
            'action: "import"',
            'action: "export"',
        ),
    ) else "FAIL"

    checks["projectSkillBindingUi"] = "PASS" if _contains_all(
        index + chat + skills,
        (
            'id="projectSkills"',
            "renderProjectSkillBinding(project.id, projectSkillsBody)",
            "PROJECT_API",
            "${projectId}/skills",
            'data-project-skill-binding="enabled"',
            'data-project-skill-binding="default"',
        ),
    ) else "FAIL"

    checks["skillRunResultLinks"] = "PASS" if _contains_all(
        index + skills,
        (
            "skillRunResult",
            "skillRunResultBody",
            "skillRunSavedItemsLink",
            "skillRunArtifactsLink",
            "savedItems",
            "artifacts",
        ),
    ) else "FAIL"

    checks["skillPanelLifecycle"] = "PASS" if _contains_all(
        chat + skills,
        (
            "beforeOpenPanel",
            "onPanelStateChange",
            "isSkillPanelOpen()",
            "closeSkillWorkbench()",
            "setPanelTriggerState(skillButton, skillPanel",
        ),
    ) else "FAIL"

    checks["skillPanelStyles"] = "PASS" if _contains_all(
        styles,
        (
            ".skill-panel",
            ".skill-panel.open",
            ".skill-card",
            ".skill-run-form",
            ".project-skills",
        ),
    ) else "FAIL"

    checks["skillAppShellCache"] = "PASS" if '"/modules/skills.js"' in service_worker else "FAIL"

    syntax = subprocess.run(["node", "--check", "static/modules/skills.js"], cwd=REPO_ROOT, capture_output=True, text=True)
    checks["skillJsSyntax"] = "PASS" if syntax.returncode == 0 else "FAIL"
    details["skillJsSyntax"] = {"returnCode": syntax.returncode, "stderr": syntax.stderr.strip()}

    checks["ciSyntaxGate"] = "PASS" if "node --check static/modules/skills.js" in ci else "FAIL"

    assets = ["docs/assets/skill-workbench.png", "docs/assets/skill-run-result.png"]
    missing_assets = [asset for asset in assets if not (REPO_ROOT / asset).is_file() or (REPO_ROOT / asset).stat().st_size <= 0]
    checks["skillUiAssets"] = "PASS" if not missing_assets else "FAIL"
    details["skillUiAssets"] = {"assets": assets, "missingOrEmpty": missing_assets}

    details["uiEntrypoints"] = ["#skillButton", "#skillPanel", "#skillRunForm", "#projectSkills"]
    details["assets"] = assets
    return checks, details


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run offline Skill Workbench UI smoke")
    parser.add_argument("--offline", action="store_true", help="Kept for release-smoke symmetry; this smoke is always offline.")
    parser.add_argument("--version", default=APP_VERSION)
    parser.add_argument("--out", default=str(REPO_ROOT / "docs" / "evidence" / f"skills-ui-v{APP_VERSION}.json"))
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    checks, details = run_checks()
    payload = evidence.release_evidence_payload(checks=checks, version=args.version, details=details)
    evidence.write_release_evidence(Path(args.out), payload)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for name, status in checks.items():
            print(f"[{status}] {name}")
        print(f"Skill UI smoke summary: {payload['status']} -> {args.out}")
    return 0 if payload["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
