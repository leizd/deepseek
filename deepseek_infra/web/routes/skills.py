"""Skill System registry and runner routes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from deepseek_infra.core.errors import AppError, ErrorCode
from deepseek_infra.web.http_utils import json_response, read_json_body, require_api_auth, truthy


@dataclass(frozen=True)
class SkillsRouteDeps:
    list_skills: Callable[..., list[dict[str, Any]]]
    list_builtin_skills: Callable[..., list[dict[str, Any]]]
    get_skill: Callable[..., dict[str, Any]]
    create_custom_skill: Callable[..., dict[str, Any]]
    update_skill: Callable[[str, dict[str, Any]], dict[str, Any]]
    set_skill_disabled: Callable[[str, bool], dict[str, Any]]
    delete_skill: Callable[[str], dict[str, Any]]
    import_skill_config: Callable[..., dict[str, Any]]
    export_skill_config: Callable[[str], dict[str, Any]]
    run_skill: Callable[..., dict[str, Any]]


def create_skills_router(deps: SkillsRouteDeps) -> APIRouter:
    router = APIRouter()

    @router.post("/api/skills")
    async def api_skills(request: Request) -> JSONResponse:
        require_api_auth(request)
        payload = await read_json_body(request)
        action = str(payload.get("action") or "list").strip().lower()
        if action == "list":
            return json_response({"ok": True, "skills": deps.list_skills(include_disabled=_bool(payload, "includeDisabled"))})
        if action == "builtin":
            return json_response({"ok": True, "skills": deps.list_builtin_skills(include_disabled=_bool(payload, "includeDisabled", default=True))})
        if action == "get":
            return json_response({"ok": True, "skill": deps.get_skill(_skill_id(payload), include_disabled=True)})
        if action == "create":
            return json_response({"ok": True, "skill": deps.create_custom_skill(_skill_config(payload), overwrite=_bool(payload, "overwrite"))})
        if action == "update":
            return json_response({"ok": True, "skill": deps.update_skill(_skill_id(payload), _skill_patch(payload))})
        if action == "disable":
            return json_response({"ok": True, "skill": deps.set_skill_disabled(_skill_id(payload), True)})
        if action == "enable":
            return json_response({"ok": True, "skill": deps.set_skill_disabled(_skill_id(payload), False)})
        if action == "delete":
            return json_response(deps.delete_skill(_skill_id(payload)))
        if action == "import":
            return json_response({"ok": True, "skill": deps.import_skill_config(_skill_config(payload), overwrite=_bool(payload, "overwrite"))})
        if action == "export":
            return json_response({"ok": True, "skill": deps.export_skill_config(_skill_id(payload))})
        if action == "run":
            return json_response(_run_skill(deps, payload, skill_id=_skill_id(payload)))
        raise AppError("Unsupported Skill action", code=ErrorCode.INVALID_PAYLOAD)

    @router.post("/api/skills/{skill_id}/run")
    async def api_skill_run(request: Request, skill_id: str) -> JSONResponse:
        require_api_auth(request)
        payload = await read_json_body(request)
        return json_response(_run_skill(deps, payload, skill_id=skill_id))

    return router


def _skill_id(payload: dict[str, Any]) -> str:
    skill_id = str(payload.get("skillId") or payload.get("id") or "").strip()
    if not skill_id:
        raise AppError("skillId is required", code=ErrorCode.INVALID_PAYLOAD)
    return skill_id


def _skill_config(payload: dict[str, Any]) -> dict[str, Any]:
    for key in ("skill", "config"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    candidate = {key: value for key, value in payload.items() if key not in {"action", "overwrite"}}
    if not candidate:
        raise AppError("Skill config is required", code=ErrorCode.INVALID_PAYLOAD)
    return candidate


def _skill_patch(payload: dict[str, Any]) -> dict[str, Any]:
    for key in ("patch", "skill", "config"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    return {key: value for key, value in payload.items() if key not in {"action", "skillId", "id"}}


def _run_input(payload: dict[str, Any]) -> dict[str, Any]:
    for key in ("input", "inputData", "inputs"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _run_skill(deps: SkillsRouteDeps, payload: dict[str, Any], *, skill_id: str) -> dict[str, Any]:
    return deps.run_skill(
        skill_id,
        _run_input(payload),
        project_id=str(payload.get("projectId") or ""),
        offline=_bool(payload, "offline"),
        api_key=str(payload.get("apiKey") or ""),
        tavily_api_key=str(payload.get("tavilyApiKey") or ""),
        model=str(payload.get("model") or ""),
        persist=_bool(payload, "persist", default=True),
    )


def _bool(payload: dict[str, Any], key: str, *, default: bool = False) -> bool:
    if key not in payload:
        return default
    value = payload.get(key)
    if isinstance(value, bool):
        return value
    return truthy(value)
