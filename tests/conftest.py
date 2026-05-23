from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import pytest

import deepseek_mobile.core.config as config
import deepseek_mobile.services.files as files
import deepseek_mobile.services.agent_runs as agent_runs
import deepseek_mobile.services.memory as memory
import deepseek_mobile.services.projects as projects
import deepseek_mobile.services.reminders as reminders
import deepseek_mobile.services.search as search
import deepseek_mobile.services.tools as tools


@pytest.fixture
def tmp_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Point local state directories at a fresh temporary workspace."""
    file_cache_dir = tmp_path / ".file-cache"
    agent_runs_dir = tmp_path / ".agent-runs"
    memory_dir = tmp_path / ".memory"
    search_cache_dir = tmp_path / ".search-cache"
    reminders_dir = tmp_path / ".reminders"
    projects_dir = tmp_path / ".projects"

    monkeypatch.setattr(config, "FILE_CACHE_DIR", file_cache_dir)
    monkeypatch.setattr(config, "AGENT_RUNS_DIR", agent_runs_dir)
    monkeypatch.setattr(config, "MEMORY_DIR", memory_dir)
    monkeypatch.setattr(config, "MEMORY_FILE", memory_dir / "memories.json")
    monkeypatch.setattr(config, "SEARCH_CACHE_DIR", search_cache_dir)
    monkeypatch.setattr(config, "REMINDERS_DIR", reminders_dir)
    monkeypatch.setattr(config, "REMINDERS_FILE", reminders_dir / "reminders.json")
    monkeypatch.setattr(config, "PROJECTS_DIR", projects_dir)

    monkeypatch.setattr(files, "FILE_CACHE_DIR", file_cache_dir)
    monkeypatch.setattr(agent_runs, "AGENT_RUNS_DIR", agent_runs_dir)
    monkeypatch.setattr(memory, "MEMORY_DIR", memory_dir)
    monkeypatch.setattr(memory, "MEMORY_FILE", memory_dir / "memories.json")
    monkeypatch.setattr(search, "SEARCH_CACHE_DIR", search_cache_dir)
    monkeypatch.setattr(reminders, "REMINDERS_DIR", reminders_dir)
    monkeypatch.setattr(reminders, "REMINDERS_FILE", reminders_dir / "reminders.json")
    monkeypatch.setattr(projects, "PROJECTS_DIR", projects_dir)
    monkeypatch.setattr(files, "PROJECTS_DIR", projects_dir)
    monkeypatch.setattr(tools, "FILE_CACHE_DIR", file_cache_dir)
    monkeypatch.setattr(tools, "SEARCH_CACHE_DIR", search_cache_dir)
    monkeypatch.setattr(tools, "PROJECTS_DIR", projects_dir)

    files._load_cached_file_cached.cache_clear()
    yield tmp_path
    files._load_cached_file_cached.cache_clear()


@pytest.fixture
def fake_deepseek() -> Callable[[str, str, dict[str, int] | None], dict[str, object]]:
    def _make(content: str = "hello", reasoning: str = "", usage: dict[str, int] | None = None) -> dict[str, object]:
        return {
            "id": "chatcmpl-test",
            "model": "deepseek-v4-pro",
            "choices": [{"message": {"content": content, "reasoning_content": reasoning}}],
            "usage": usage or {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    return _make


@pytest.fixture
def mock_urlopen() -> object:
    with patch("urllib.request.urlopen") as mocked:
        yield mocked


def deepseek_response_bytes(content: str = "hello", usage: dict[str, int] | None = None) -> bytes:
    return json.dumps(
        {
            "id": "chatcmpl-test",
            "model": "deepseek-v4-pro",
            "choices": [{"message": {"content": content}}],
            "usage": usage or {},
        }
    ).encode("utf-8")


