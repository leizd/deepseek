from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import deepseek_infra.app as app_module


def test_startup_structured_log_redacts_token_urls() -> None:
    stdout = SimpleNamespace(isatty=lambda: False)

    with patch.object(app_module.sys, "stdout", stdout), patch.object(app_module.logger, "info") as info:
        app_module.log_server_started(
            "http://127.0.0.1:8000/?token=computer-secret",
            "http://192.168.1.2:8000/?token=phone-secret",
        )

    extra = info.call_args.kwargs["extra"]
    serialized = json.dumps(extra, ensure_ascii=False)
    assert "computer-secret" not in serialized
    assert "phone-secret" not in serialized
    assert "%5Bredacted%5D" in serialized


def test_startup_log_handles_windowed_stdout() -> None:
    with patch.object(app_module.sys, "stdout", None), patch.object(app_module.logger, "info") as info:
        app_module.log_server_started(
            "http://127.0.0.1:8000/",
            "http://192.168.1.2:8000/",
        )

    info.assert_called_once()


def test_cleanup_runtime_caches_runs_both_cleaners_and_swallows_errors() -> None:
    with (
        patch.object(app_module, "cleanup_file_cache", side_effect=RuntimeError("file boom")) as file_cleanup,
        patch.object(app_module, "cleanup_search_cache") as search_cleanup,
        patch.object(app_module, "mark_orphan_runs_on_startup") as orphan_cleanup,
        patch.object(app_module.logger, "exception") as log_exception,
    ):
        app_module.cleanup_runtime_caches()

    file_cleanup.assert_called_once_with()
    search_cleanup.assert_called_once_with()
    orphan_cleanup.assert_called_once_with()
    log_exception.assert_called_once()


def test_startup_dependency_check_fails_fast_for_incompatible_multipart() -> None:
    with patch.object(app_module, "multipart_module", None):
        try:
            app_module.ensure_startup_dependencies()
        except SystemExit as exc:
            assert "Multipart parser dependency" in str(exc)
        else:  # pragma: no cover
            raise AssertionError("expected SystemExit")


def test_periodic_cache_cleanup_starts_daemon_thread() -> None:
    with patch.object(app_module.threading, "Thread") as thread_cls:
        stop_event = app_module.start_periodic_cache_cleanup(interval_seconds=999)

    assert hasattr(stop_event, "set")
    thread = thread_cls.call_args.kwargs
    assert thread["name"] == "deepseek-cache-cleanup"
    assert thread["daemon"] is True
    thread_cls.return_value.start.assert_called_once_with()
