from __future__ import annotations

from pathlib import Path

import pytest

from deepseek_infra.core.errors import AppError
from deepseek_infra.infra.data import projects
from deepseek_infra.infra.observability import observability
from deepseek_infra.infra.skills import evidence, permissions, registry
from deepseek_infra.infra.skills.runner import run_skill


def _custom_skill() -> dict[str, object]:
    return {
        "skillId": "skill_unit_custom",
        "name": "Unit Custom Skill",
        "description": "Used by registry unit tests.",
        "version": "1.0.0",
        "systemPrompt": "Return markdown.",
        "inputSchema": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"], "additionalProperties": True},
        "allowedTools": ["search_files"],
        "memoryPolicy": {"scope": "project", "read": True, "write": False},
        "artifactPolicy": {"autoSave": True, "types": ["md"]},
        "projectBinding": {"enabled": True},
        "exampleInputs": [{"topic": "unit"}],
    }


def test_builtin_skill_pack_loads() -> None:
    skills = registry.list_builtin_skills()
    ids = {item["skillId"] for item in skills}

    assert {
        "skill_document_reader",
        "skill_research_brief",
        "skill_paper_writer",
        "skill_ppt_generator",
        "skill_code_review",
        "skill_study_tutor",
    } <= ids


def test_custom_skill_crud_disable_and_export(tmp_settings: Path) -> None:
    created = registry.create_custom_skill(_custom_skill())
    exported = registry.export_skill_config(created["skillId"])
    disabled = registry.set_skill_disabled(created["skillId"], True)

    assert created["builtin"] is False
    assert exported["skillId"] == "skill_unit_custom"
    assert disabled["disabled"] is True
    assert created["skillId"] not in {item["skillId"] for item in registry.list_skills()}

    enabled = registry.set_skill_disabled(created["skillId"], False)
    updated = registry.update_skill(created["skillId"], {"description": "Updated description"})
    deleted = registry.delete_skill(created["skillId"])

    assert enabled["disabled"] is False
    assert updated["description"] == "Updated description"
    assert deleted["deleted"] == "skill_unit_custom"


def test_skill_schema_rejects_unknown_tool(tmp_settings: Path) -> None:
    config = _custom_skill()
    config["allowedTools"] = ["rm_rf"]

    with pytest.raises(AppError):
        registry.create_custom_skill(config)


def test_skill_runner_offline_persists_project_artifacts(tmp_settings: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(observability, "TRACE_ENABLED", False)
    project = projects.create_project("Skill Project")

    result = run_skill("skill_research_brief", {"topic": "Skill System", "depth": "quick"}, project_id=project["id"], offline=True)
    exported = projects.export_project(project["id"])
    artifact_index = evidence.artifacts_for_skill_run(result["skillRunId"])

    assert result["ok"] is True
    assert result["artifacts"][0]["source"]["skillRunId"] == result["skillRunId"]
    assert result["savedItems"][0]["source"]["skillId"] == "skill_research_brief"
    assert exported["skillRuns"][0]["skillRunId"] == result["skillRunId"]
    assert exported["artifacts"][0]["source"]["type"] == "skill_run"
    assert artifact_index[0]["source"]["projectId"] == project["id"]


def test_skill_permission_gate_denies_tools_outside_allowed_list() -> None:
    skill = registry.get_skill("skill_code_review")
    decision = permissions.evaluate_skill_tool(skill, "fetch_url", {"url": "https://example.com"})

    assert decision.allowed is False
