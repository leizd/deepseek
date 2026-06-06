from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import deepseek_mobile.services.deepseek_client as deepseek_client
from deepseek_mobile.services.deepseek_client import call_deepseek
from deepseek_mobile.services import observability, semantic_cache


class FakeResponse:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        return self.data


def response_bytes(content: str = "hello", usage: dict[str, int] | None = None) -> bytes:
    return json.dumps(
        {
            "id": "response-id",
            "model": "deepseek-v4-pro",
            "choices": [{"message": {"content": content}}],
            "usage": usage or {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
    ).encode("utf-8")


def test_trace_store_records_run_and_span(tmp_settings: Any) -> None:
    payload: dict[str, Any] = {}
    context = observability.ensure_trace(payload, kind="chat", title="hello", metadata={"stream": False})
    span = observability.start_span(context.trace_id, name="deepseek", kind="deepseek_api", input_data={"prompt": "hello"})
    span.finish(output_data={"content": "world"}, usage={"total_tokens": 12})
    observability.finish_trace(context.trace_id, metadata={"model": "deepseek-v4-pro"})

    trace = observability.get_trace(context.trace_id)

    assert trace is not None
    assert trace["traceId"] == context.trace_id
    assert trace["status"] == "completed"
    assert trace["summary"]["spanCount"] == 1
    assert trace["summary"]["totalTokens"] == 12
    assert trace["spans"][0]["name"] == "deepseek"
    assert observability.trace_status()["traceCount"] == 1


def test_semantic_cache_store_and_lookup(tmp_settings: Any) -> None:
    payload = {"messages": [{"role": "user", "content": "summarize alpha"}], "toolsEnabled": False}
    body = {"model": "deepseek-v4-pro", "messages": [{"role": "user", "content": "summarize alpha"}]}

    missed = semantic_cache.lookup(payload, body)
    stored = semantic_cache.store(payload, body, {"model": "deepseek-v4-pro", "content": "alpha summary", "usage": {"total_tokens": 9}})
    hit = semantic_cache.lookup(payload, body)

    assert missed.hit is False
    assert missed.diagnostics["checked"] is True
    assert stored["stored"] is True
    assert hit.hit is True
    assert hit.result is not None
    assert hit.result["content"] == "alpha summary"
    assert hit.diagnostics["hit"] is True


def test_call_deepseek_uses_semantic_cache_hit_without_upstream(tmp_settings: Any) -> None:
    payload = {
        "apiKey": "test",
        "model": "expert",
        "toolsEnabled": False,
        "messages": [{"role": "user", "content": "summarize alpha"}],
    }
    fixed_time = "[Current time]\nLocal time: 2026-06-05T00:00:00+08:00\nUTC time: 2026-06-04T16:00:00Z"

    with (
        patch.object(deepseek_client, "format_current_time_context", return_value=fixed_time),
        patch("urllib.request.urlopen", return_value=FakeResponse(response_bytes("alpha summary"))) as urlopen,
    ):
        first = call_deepseek(dict(payload))

    with (
        patch.object(deepseek_client, "format_current_time_context", return_value=fixed_time),
        patch("urllib.request.urlopen", side_effect=AssertionError("upstream should not be called")) as urlopen_again,
    ):
        second = call_deepseek(dict(payload))

    urlopen.assert_called_once()
    urlopen_again.assert_not_called()
    assert first["diagnostics"]["semanticCache"]["stored"] is True
    assert second["content"] == "alpha summary"
    assert second["diagnostics"]["semanticCache"]["hit"] is True
    assert second["diagnostics"]["traceId"]


def test_semantic_cache_skips_tool_enabled_body(tmp_settings: Any) -> None:
    payload = {"messages": [{"role": "user", "content": "need tool"}]}
    body = {
        "model": "deepseek-v4-pro",
        "messages": [{"role": "user", "content": "need tool"}],
        "tools": [{"type": "function", "function": {"name": "python_eval"}}],
    }

    result = semantic_cache.lookup(payload, body)

    assert result.hit is False
    assert result.diagnostics["checked"] is False
    assert result.diagnostics["skippedReason"] == "tools_enabled"
