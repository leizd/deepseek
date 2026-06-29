from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

import deepseek_infra.web.http_utils as http_utils
import deepseek_infra.web.server as server_module


def test_create_app_still_returns_fastapi_app() -> None:
    app = server_module.create_app()

    assert isinstance(app, FastAPI)


def test_phase1_status_routes_are_registered() -> None:
    app = server_module.create_app()
    paths = {getattr(route, "path", "") for route in app.routes}

    for expected in {
        "/api/config",
        "/api/rag/status",
        "/api/budget",
        "/api/tool-policy",
        "/api/scheduler",
        "/api/mcp",
        "/api/taint",
        "/api/semantic-cache/status",
        "/api/gateway/status",
        "/api/edge/status",
    }:
        assert expected in paths


def test_legacy_server_entrypoints_and_http_helpers_remain_available() -> None:
    assert callable(server_module.create_app)
    assert callable(server_module.create_server)
    assert hasattr(server_module, "FastAPIServer")
    assert server_module.json_response is http_utils.json_response
    assert server_module.read_json_body is http_utils.read_json_body
    assert server_module.require_api_auth is http_utils.require_api_auth


def test_phase1_status_routes_are_not_declared_inline_in_server() -> None:
    server_source = Path(server_module.__file__).read_text(encoding="utf-8")

    assert "create_status_router(_status_route_deps())" in server_source
    for decorator in [
        '@api.get("/api/config")',
        '@api.get("/api/rag/status")',
        '@api.get("/api/budget")',
        '@api.get("/api/tool-policy")',
        '@api.get("/api/scheduler")',
        '@api.get("/api/mcp")',
        '@api.get("/api/taint")',
        '@api.get("/api/semantic-cache/status")',
        '@api.get("/api/gateway/status")',
        '@api.get("/api/edge/status")',
    ]:
        assert decorator not in server_source
