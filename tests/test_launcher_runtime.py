"""Tests for the GUI launcher's subprocess runtime helpers."""

from __future__ import annotations

import sys

import pytest

from deepseek_mobile.launcher.credentials import LAN_HOST, LauncherCredentials
from deepseek_mobile.launcher.runtime import build_env, server_command


def test_build_env_carries_keys_and_settings() -> None:
    creds = LauncherCredentials(
        deepseek_api_key="sk-d",
        tavily_api_key="tvly-t",
        host=LAN_HOST,
        port=9123,
        allow_lan=True,
        ocr_enabled=True,
        auth_disabled=False,
    )
    env = build_env(creds)
    assert env["DEEPSEEK_API_KEY"] == "sk-d"
    assert env["TAVILY_API_KEY"] == "tvly-t"
    assert env["HOST"] == LAN_HOST
    assert env["PORT"] == "9123"
    assert env["OCR_ENABLED"] == "1"
    assert "AUTH_DISABLED" not in env
    assert env.get("PYTHONIOENCODING") == "utf-8"
    assert env.get("PYTHONUTF8") == "1"


def test_build_env_strips_empty_keys_from_parent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "inherited")
    monkeypatch.setenv("TAVILY_API_KEY", "inherited")
    monkeypatch.setenv("AUTH_DISABLED", "1")
    creds = LauncherCredentials(deepseek_api_key="", tavily_api_key="")
    env = build_env(creds)
    assert "DEEPSEEK_API_KEY" not in env
    assert "TAVILY_API_KEY" not in env
    assert "AUTH_DISABLED" not in env


def test_build_env_keeps_auth_disabled_when_requested() -> None:
    creds = LauncherCredentials(deepseek_api_key="sk", auth_disabled=True)
    env = build_env(creds)
    assert env["AUTH_DISABLED"] == "1"


def test_build_env_passes_ocr_disabled_explicitly() -> None:
    creds = LauncherCredentials(deepseek_api_key="sk", ocr_enabled=False)
    env = build_env(creds)
    assert env["OCR_ENABLED"] == "0"


def test_server_command_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    cmd = server_command()
    assert cmd == [sys.executable, "-m", "deepseek_mobile.app"]


def test_server_command_frozen_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    cmd = server_command()
    assert cmd == [sys.executable, "--server"]
