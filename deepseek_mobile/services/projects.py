"""Persistent local project spaces and document libraries."""

from __future__ import annotations

import json
import re
import secrets
import shutil
import time
from typing import Any

from deepseek_mobile.core.config import PROJECTS_DIR
from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services.files import extract_uploaded_file

MAX_PROJECTS = 40
MAX_PROJECT_DOCUMENTS = 120


def list_projects() -> list[dict[str, Any]]:
    if not PROJECTS_DIR.exists():
        return []
    projects = []
    for path in PROJECTS_DIR.iterdir():
        if not path.is_dir():
            continue
        project = read_project(path.name)
        if project:
            projects.append(public_project(project))
    return sorted(projects, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)


def create_project(name: str) -> dict[str, Any]:
    if len(list_projects()) >= MAX_PROJECTS:
        raise AppError("Too many projects", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
    now = int(time.time() * 1000)
    project = {
        "id": f"proj-{secrets.token_hex(6)}",
        "name": normalize_project_name(name),
        "documents": [],
        "createdAt": now,
        "updatedAt": now,
    }
    write_project(project)
    return public_project(project)


def delete_project(project_id: str) -> int:
    safe_id = validate_project_id(project_id)
    path = PROJECTS_DIR / safe_id
    if not path.exists():
        return 0
    try:
        from deepseek_mobile.services import local_rag

        local_rag.delete_items(collection=local_rag.COLLECTION_FILES, project_id=safe_id)
    except Exception:
        pass
    shutil.rmtree(path)
    return 1


def add_project_files(
    project_id: str,
    files: list[dict[str, Any]],
    *,
    ocr_enabled: bool | None = None,
    ocr_api_key: str | None = None,
) -> list[dict[str, Any]]:
    project = require_project(project_id)
    documents = list(project.get("documents") or [])
    if len(documents) + len(files) > MAX_PROJECT_DOCUMENTS:
        raise AppError("Too many project documents", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)

    added = []
    for file_info in files:
        raw_data = file_info.get("data")
        extracted = extract_uploaded_file(
            str(file_info.get("filename") or "file"),
            str(file_info.get("content_type") or "application/octet-stream"),
            raw_data if isinstance(raw_data, bytes) else b"",
            ocr_enabled=ocr_enabled,
            ocr_api_key=ocr_api_key,
            project_id=str(project["id"]),
        )
        document = project_document_from_extracted(extracted)
        documents = [item for item in documents if item.get("fileId") != document["fileId"]]
        documents.append(document)
        added.append(document)

    project["documents"] = documents[-MAX_PROJECT_DOCUMENTS:]
    project["updatedAt"] = int(time.time() * 1000)
    write_project(project)
    return added


def project_document_from_extracted(extracted: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": secrets.token_hex(8),
        "name": str(extracted.get("name") or "文件"),
        "type": str(extracted.get("type") or ""),
        "size": int(extracted.get("size") or 0),
        "kind": str(extracted.get("kind") or "text"),
        "fileId": str(extracted.get("fileId") or ""),
        "projectId": str(extracted.get("projectId") or ""),
        "sourceAvailable": bool(extracted.get("sourceAvailable")),
        "preview": str(extracted.get("preview") or "")[:1800],
        "pageCount": int(extracted.get("pageCount") or 0),
        "charCount": int(extracted.get("charCount") or 0),
        "chunkCount": int(extracted.get("chunkCount") or 0),
        "chunked": bool(extracted.get("chunked")),
        "createdAt": int(time.time() * 1000),
    }


def require_project(project_id: str) -> dict[str, Any]:
    project = read_project(project_id)
    if project is None:
        raise AppError("Project not found", code=ErrorCode.NOT_FOUND, status=404)
    return project


def read_project(project_id: str) -> dict[str, Any] | None:
    safe_id = validate_project_id(project_id)
    path = PROJECTS_DIR / safe_id / "project.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    data["id"] = safe_id
    data["name"] = normalize_project_name(data.get("name"))
    data["documents"] = normalize_documents(data.get("documents"))
    return data


def write_project(project: dict[str, Any]) -> None:
    safe_id = validate_project_id(str(project.get("id") or ""))
    directory = PROJECTS_DIR / safe_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "project.json"
    tmp = directory / "project.tmp"
    tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def public_project(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(project.get("id") or ""),
        "name": normalize_project_name(project.get("name")),
        "documents": normalize_documents(project.get("documents")),
        "createdAt": int(project.get("createdAt") or 0),
        "updatedAt": int(project.get("updatedAt") or 0),
    }


def normalize_project_name(value: Any) -> str:
    name = str(value or "").replace("\n", " ").strip()
    return (name[:60] or "新项目")


def normalize_documents(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    documents = []
    for item in value:
        if not isinstance(item, dict):
            continue
        file_id = str(item.get("fileId") or "")
        project_id = str(item.get("projectId") or "")
        if not re.fullmatch(r"[0-9a-f]{32}", file_id) or not project_id:
            continue
        documents.append(
            {
                "id": str(item.get("id") or file_id),
                "name": str(item.get("name") or "文件")[:180],
                "type": str(item.get("type") or ""),
                "size": int(item.get("size") or 0),
                "kind": str(item.get("kind") or "text"),
                "fileId": file_id,
                "projectId": project_id,
                "sourceAvailable": bool(item.get("sourceAvailable")),
                "preview": str(item.get("preview") or "")[:1800],
                "pageCount": int(item.get("pageCount") or 0),
                "charCount": int(item.get("charCount") or 0),
                "chunkCount": int(item.get("chunkCount") or 0),
                "chunked": bool(item.get("chunked")),
                "createdAt": int(item.get("createdAt") or 0),
            }
        )
    return documents


def validate_project_id(project_id: str) -> str:
    safe_id = str(project_id or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{4,64}", safe_id):
        raise AppError("Invalid project id", code=ErrorCode.INVALID_PAYLOAD, status=400)
    return safe_id
