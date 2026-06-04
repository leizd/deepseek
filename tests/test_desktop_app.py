from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import patch

import deepseek_mobile.desktop_app as desktop_app


def test_desktop_app_starts_webview_and_shuts_down() -> None:
    handle = SimpleNamespace(computer_url="http://127.0.0.1:8000/?token=abc")

    with (
        patch.object(desktop_app, "prepare_and_start", return_value=handle) as prepare,
        patch.object(desktop_app, "open_app_window") as open_window,
        patch.object(desktop_app, "shutdown_handle") as shutdown,
    ):
        assert desktop_app.main() == 0

    prepare.assert_called_once_with(host="127.0.0.1", serve=True)
    open_window.assert_called_once_with("http://127.0.0.1:8000/?token=abc&desktop=1")
    shutdown.assert_called_once_with(handle)


def test_desktop_app_shuts_down_after_window_error() -> None:
    handle = SimpleNamespace(computer_url="http://127.0.0.1:8000/?token=abc")

    with (
        patch.object(desktop_app, "prepare_and_start", return_value=handle),
        patch.object(desktop_app, "open_app_window", side_effect=RuntimeError("boom")),
        patch.object(desktop_app, "show_startup_error") as show_error,
        patch.object(desktop_app, "shutdown_handle") as shutdown,
    ):
        assert desktop_app.main() == 1

    show_error.assert_called_once()
    shutdown.assert_called_once_with(handle)


def test_open_app_window_uses_pywebview() -> None:
    fake_webview = ModuleType("webview")
    calls: list[tuple[Any, ...]] = []

    def create_window(*args: object, **kwargs: object) -> None:
        calls.append(("create_window", args, kwargs))

    def start(*args: object, **kwargs: object) -> None:
        calls.append(("start", args, kwargs))

    fake_webview.create_window = create_window  # type: ignore[attr-defined]
    fake_webview.start = start  # type: ignore[attr-defined]

    with patch.dict(sys.modules, {"webview": fake_webview}):
        desktop_app.open_app_window("http://127.0.0.1:8000/")

    assert calls[0][0] == "create_window"
    assert calls[0][1][0] == "DeepSeek Mobile"
    assert calls[0][1][1] == "http://127.0.0.1:8000/"
    assert calls[1] == ("start", (), {"debug": False, "private_mode": False})


def test_webview_entry_url_marks_desktop_handshake() -> None:
    assert desktop_app.webview_entry_url("http://127.0.0.1:8000/?token=abc") == "http://127.0.0.1:8000/?token=abc&desktop=1"
    assert desktop_app.webview_entry_url("http://127.0.0.1:8000/?token=abc&desktop=1") == "http://127.0.0.1:8000/?token=abc&desktop=1"
