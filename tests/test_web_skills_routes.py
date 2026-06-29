from __future__ import annotations

import contextlib
import http.client
import json
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import deepseek_infra.web.server as server_module
from deepseek_infra.core.errors import ErrorCode
from deepseek_infra.infra.data import projects


def _collect_route_paths(routes: list[Any]) -> set[str]:
    paths: set[str] = set()
    for route in routes:
        path = getattr(route, "path", "")
        if path:
            paths.add(path)
        original = getattr(route, "original_router", None)
        if original is not None:
            paths |= _collect_route_paths(getattr(original, "routes", []))
    return paths


@contextlib.contextmanager
def _running_server() -> Iterator[Any]:
    server, _ = server_module.create_server(0, host="127.0.0.1")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _request(
    server: Any,
    method: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any], http.client.HTTPResponse]:
    body = json.dumps(payload or {}).encode("utf-8") if payload is not None else None
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        return response.status, json.loads(data.decode("utf-8")), response
    finally:
        connection.close()


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {server_module.settings.auth.token}"}


def _custom_skill() -> dict[str, Any]:
    return {
        "skillId": "skill_web_custom",
        "name": "Web Custom Skill",
        "description": "Used by Skill route tests.",
        "version": "1.0.0",
        "systemPrompt": "Return markdown.",
        "inputSchema": {"type": "object", "properties": {"topic": {"type": "string"}}, "required": ["topic"], "additionalProperties": False},
        "outputSchema": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"], "additionalProperties": True},
        "allowedTools": ["search_files"],
        "memoryPolicy": {"scope": "project", "read": True, "write": False},
        "artifactPolicy": {"autoSave": True, "types": ["md"]},
        "projectBinding": {"enabled": True},
        "exampleInputs": [{"topic": "web"}],
    }


def test_skills_routes_are_registered() -> None:
    app = server_module.create_app()
    paths = _collect_route_paths(app.routes)

    assert "/api/skills" in paths
    assert "/api/skills/{skill_id}/run" in paths


def test_skills_action_auth_enforced() -> None:
    with _running_server() as server:
        status, payload, _ = _request(server, "POST", "/api/skills", payload={"action": "list"})

    assert status == 401
    assert payload["code"] == ErrorCode.UNAUTHORIZED.value


def test_skills_action_list_get_create_disable_enable_and_run(tmp_settings: Path) -> None:
    project = projects.create_project("Skill Route Project")

    with _running_server() as server:
        status, listed, _ = _request(server, "POST", "/api/skills", payload={"action": "list"}, headers=_auth_headers())
        assert status == 200
        assert "skill_research_brief" in {item["skillId"] for item in listed["skills"]}

        status, fetched, _ = _request(
            server,
            "POST",
            "/api/skills",
            payload={"action": "get", "skillId": "skill_research_brief"},
            headers=_auth_headers(),
        )
        assert status == 200
        assert fetched["skill"]["skillId"] == "skill_research_brief"

        status, created, _ = _request(
            server,
            "POST",
            "/api/skills",
            payload={"action": "create", "skill": _custom_skill()},
            headers=_auth_headers(),
        )
        assert status == 200
        assert created["skill"]["skillId"] == "skill_web_custom"

        status, disabled, _ = _request(
            server,
            "POST",
            "/api/skills",
            payload={"action": "disable", "skillId": "skill_web_custom"},
            headers=_auth_headers(),
        )
        assert status == 200
        assert disabled["skill"]["disabled"] is True

        status, enabled, _ = _request(
            server,
            "POST",
            "/api/skills",
            payload={"action": "enable", "skillId": "skill_web_custom"},
            headers=_auth_headers(),
        )
        assert status == 200
        assert enabled["skill"]["disabled"] is False

        status, run, _ = _request(
            server,
            "POST",
            "/api/skills",
            payload={
                "action": "run",
                "skillId": "skill_research_brief",
                "input": {"topic": "Skill API", "depth": "quick"},
                "projectId": project["id"],
                "offline": True,
            },
            headers=_auth_headers(),
        )
        assert status == 200
        assert run["ok"] is True
        assert run["skillId"] == "skill_research_brief"
        assert run["projectId"] == project["id"]
        assert run["artifacts"][0]["source"]["skillRunId"] == run["skillRunId"]


def test_skill_run_path_executes_offline(tmp_settings: Path) -> None:
    project = projects.create_project("Skill Run Path")

    with _running_server() as server:
        status, payload, _ = _request(
            server,
            "POST",
            "/api/skills/skill_research_brief/run",
            payload={"input": {"topic": "Path Run", "depth": "quick"}, "projectId": project["id"], "offline": True},
            headers=_auth_headers(),
        )

    assert status == 200
    assert payload["ok"] is True
    assert payload["skillId"] == "skill_research_brief"
