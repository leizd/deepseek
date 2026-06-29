"""Skill registry: built-in Skill pack plus local custom Skill storage."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from deepseek_infra.core.config import BUILTIN_SKILLS_DIR, SKILLS_DIR
from deepseek_infra.core.errors import AppError, ErrorCode
from deepseek_infra.core.utils import utc_now_iso
from deepseek_infra.infra.skills.schema import SkillSchemaError, normalize_skill_id, validate_skill_config


def list_skills(*, include_disabled: bool = False) -> list[dict[str, Any]]:
    skills: dict[str, dict[str, Any]] = {}
    disabled = disabled_skill_ids()
    for skill in load_builtin_skills():
        skill["builtin"] = True
        skill["disabled"] = skill["skillId"] in disabled
        skills[skill["skillId"]] = skill
    for skill in load_custom_skills():
        skill["builtin"] = False
        skill["disabled"] = bool(skill.get("disabled")) or skill["skillId"] in disabled
        skills[skill["skillId"]] = skill
    result = [public_skill(skill) for skill in skills.values() if include_disabled or not skill.get("disabled")]
    return sorted(result, key=lambda item: (bool(item.get("builtin")) is False, str(item.get("name") or "")))


def list_builtin_skills(*, include_disabled: bool = True) -> list[dict[str, Any]]:
    disabled = disabled_skill_ids()
    result = []
    for skill in load_builtin_skills():
        skill["builtin"] = True
        skill["disabled"] = skill["skillId"] in disabled
        if include_disabled or not skill["disabled"]:
            result.append(public_skill(skill))
    return sorted(result, key=lambda item: str(item.get("skillId") or ""))


def get_skill(skill_id: str, *, include_disabled: bool = False) -> dict[str, Any]:
    normalized = normalize_skill_id(skill_id)
    for skill in list_skills(include_disabled=True):
        if skill["skillId"] == normalized:
            if skill.get("disabled") and not include_disabled:
                raise AppError("Skill is disabled", code=ErrorCode.FORBIDDEN, status=403)
            return skill
    raise AppError("Skill not found", code=ErrorCode.NOT_FOUND, status=404)


def create_custom_skill(config: dict[str, Any], *, overwrite: bool = False) -> dict[str, Any]:
    skill = normalize_config_for_storage(config)
    skill_id = skill["skillId"]
    if is_builtin_skill(skill_id):
        raise AppError("Cannot overwrite a built-in Skill", code=ErrorCode.FORBIDDEN, status=403)
    path = custom_skill_path(skill_id)
    if path.exists() and not overwrite:
        raise AppError("Skill already exists", code=ErrorCode.INVALID_PAYLOAD, status=409)
    now = utc_now_iso()
    existing = _read_json(path) if path.exists() else {}
    if isinstance(existing, dict) and existing.get("createdAt"):
        skill["createdAt"] = str(existing["createdAt"])
    else:
        skill["createdAt"] = now
    skill["updatedAt"] = now
    skill["builtin"] = False
    write_custom_skill(skill)
    return public_skill(skill)


def update_skill(skill_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_skill_id(skill_id)
    path = custom_skill_path(normalized)
    if not path.exists():
        if is_builtin_skill(normalized):
            raise AppError("Built-in Skills are read-only; export and import as a custom Skill to edit", code=ErrorCode.FORBIDDEN, status=403)
        raise AppError("Skill not found", code=ErrorCode.NOT_FOUND, status=404)
    current = _read_json(path)
    if not isinstance(current, dict):
        raise AppError("Skill file is corrupt", code=ErrorCode.INVALID_PAYLOAD)
    merged = {**current, **(patch if isinstance(patch, dict) else {})}
    if str(merged.get("skillId") or "") != normalized:
        raise AppError("skillId cannot be changed", code=ErrorCode.INVALID_PAYLOAD)
    skill = normalize_config_for_storage(merged)
    skill["createdAt"] = str(current.get("createdAt") or utc_now_iso())
    skill["updatedAt"] = utc_now_iso()
    skill["builtin"] = False
    write_custom_skill(skill)
    return public_skill(skill)


def set_skill_disabled(skill_id: str, disabled: bool = True) -> dict[str, Any]:
    normalized = normalize_skill_id(skill_id)
    get_skill(normalized, include_disabled=True)
    disabled_ids = set(disabled_skill_ids())
    if disabled:
        disabled_ids.add(normalized)
    else:
        disabled_ids.discard(normalized)
    write_disabled_skill_ids(sorted(disabled_ids))
    return get_skill(normalized, include_disabled=True)


def delete_skill(skill_id: str) -> dict[str, Any]:
    normalized = normalize_skill_id(skill_id)
    path = custom_skill_path(normalized)
    if path.exists():
        try:
            path.unlink()
        except OSError as exc:
            raise AppError(f"Cannot delete Skill: {exc}", code=ErrorCode.INTERNAL, status=500) from exc
        disabled_ids = [item for item in disabled_skill_ids() if item != normalized]
        write_disabled_skill_ids(disabled_ids)
        return {"ok": True, "deleted": normalized, "disabled": False}
    if is_builtin_skill(normalized):
        set_skill_disabled(normalized, True)
        return {"ok": True, "deleted": "", "disabled": True, "skillId": normalized}
    raise AppError("Skill not found", code=ErrorCode.NOT_FOUND, status=404)


def export_skill_config(skill_id: str) -> dict[str, Any]:
    skill = get_skill(skill_id, include_disabled=True)
    return {key: value for key, value in skill.items() if key not in {"builtin", "createdAt", "updatedAt"}}


def export_skill_file(skill_id: str, path: Path) -> dict[str, Any]:
    payload = export_skill_config(skill_id)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(target), "skill": payload}


def import_skill_config(config: dict[str, Any], *, overwrite: bool = False) -> dict[str, Any]:
    return create_custom_skill(config, overwrite=overwrite)


def import_skill_file(path: Path, *, overwrite: bool = False) -> dict[str, Any]:
    data = _read_json(Path(path))
    if not isinstance(data, dict):
        raise AppError("Skill import file must contain a JSON object", code=ErrorCode.INVALID_PAYLOAD)
    return import_skill_config(data, overwrite=overwrite)


def load_builtin_skills() -> list[dict[str, Any]]:
    return [_load_skill_file(path, builtin=True) for path in sorted(BUILTIN_SKILLS_DIR.glob("*.json")) if path.is_file()]


def load_custom_skills() -> list[dict[str, Any]]:
    directory = custom_skills_dir()
    if not directory.exists():
        return []
    skills = []
    for path in sorted(directory.glob("*.json")):
        if not path.is_file():
            continue
        try:
            skills.append(_load_skill_file(path, builtin=False))
        except AppError:
            continue
    return skills


def public_skill(skill: dict[str, Any]) -> dict[str, Any]:
    data = dict(skill)
    data["builtin"] = bool(skill.get("builtin"))
    data["disabled"] = bool(skill.get("disabled"))
    return data


def is_builtin_skill(skill_id: str) -> bool:
    normalized = normalize_skill_id(skill_id)
    return any(skill["skillId"] == normalized for skill in load_builtin_skills())


def normalize_config_for_storage(config: dict[str, Any]) -> dict[str, Any]:
    try:
        return validate_skill_config(config)
    except SkillSchemaError as exc:
        raise AppError(str(exc), code=ErrorCode.INVALID_PAYLOAD) from exc


def custom_skills_dir() -> Path:
    return SKILLS_DIR / "custom"


def custom_skill_path(skill_id: str) -> Path:
    return custom_skills_dir() / f"{normalize_skill_id(skill_id)}.json"


def disabled_skills_path() -> Path:
    return SKILLS_DIR / "disabled.json"


def disabled_skill_ids() -> list[str]:
    data = _read_json(disabled_skills_path())
    if not isinstance(data, list):
        return []
    result = []
    for item in data:
        try:
            result.append(normalize_skill_id(item))
        except SkillSchemaError:
            continue
    return sorted(set(result))


def write_disabled_skill_ids(skill_ids: list[str]) -> None:
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    disabled_skills_path().write_text(json.dumps(sorted(set(skill_ids)), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_custom_skill(skill: dict[str, Any]) -> None:
    custom_skills_dir().mkdir(parents=True, exist_ok=True)
    path = custom_skill_path(str(skill.get("skillId") or ""))
    path.write_text(json.dumps(skill, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_skill_file(path: Path, *, builtin: bool) -> dict[str, Any]:
    data = _read_json(path)
    if not isinstance(data, dict):
        raise AppError(f"Invalid Skill file: {path}", code=ErrorCode.INVALID_PAYLOAD)
    skill = normalize_config_for_storage(data)
    skill["builtin"] = builtin
    for key in ("createdAt", "updatedAt"):
        if data.get(key):
            skill[key] = str(data[key])
    return skill


def _read_json(path: Path) -> Any:
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
