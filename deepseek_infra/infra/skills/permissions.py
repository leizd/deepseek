"""Permission helpers that bind Skill allowedTools to the Tool Policy Engine."""

from __future__ import annotations

from typing import Any

from deepseek_infra.infra.skills.schema import validate_allowed_tools
from deepseek_infra.infra.tool_runtime.tool_policy import PolicyDecision, ToolPolicy


def skill_allowed_tools(skill: dict[str, Any]) -> list[str]:
    return validate_allowed_tools(skill.get("allowedTools") if isinstance(skill, dict) else [])


def build_skill_tool_policy(
    skill: dict[str, Any],
    *,
    project_id: str = "",
    approvals: set[str] | None = None,
    enforce_schema: bool | None = None,
) -> ToolPolicy:
    scope = f"project:{project_id}" if project_id else f"skill:{skill.get('skillId') or 'unknown'}"
    return ToolPolicy(
        capability="full",
        allowed_tools=skill_allowed_tools(skill),
        approvals=approvals,
        enforce_schema=enforce_schema,
        scope=scope,
    )


def evaluate_skill_tool(skill: dict[str, Any], tool_name: str, arguments: dict[str, Any] | None = None) -> PolicyDecision:
    policy = build_skill_tool_policy(skill, enforce_schema=False)
    return policy.evaluate(tool_name, arguments or {})
