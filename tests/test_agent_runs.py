from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

import deepseek_mobile.services.agent_runs as agent_runs


def valid_payload(**extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "apiKey": "secret-key",
        "tavilyApiKey": "secret-search",
        "model": "deepseek-v4-pro",
        "stream": True,
        "messages": [{"role": "user", "content": "请分析这个任务"}],
    }
    payload.update(extra)
    return payload


def test_create_run_sanitizes_private_keys_and_appends_indexed_events(tmp_settings) -> None:
    run = agent_runs.create_run(valid_payload(nested={"apiKey": "nested-secret"}), conversation_id="c1", message_id="m1")
    run_id = run["runId"]

    assert "requestPayload" not in run
    path = agent_runs.AGENT_RUNS_DIR / f"{run_id}.json"
    raw = path.read_text(encoding="utf-8")
    assert "secret-key" not in raw
    assert "secret-search" not in raw
    assert "nested-secret" not in raw

    first = agent_runs.append_event(run_id, {"type": "content", "text": "hello"})
    second = agent_runs.append_event(run_id, {"type": "done", "content": "hello", "diagnostics": {"ok": True}})
    stored = agent_runs.load_run(run_id)

    assert first["index"] == 0
    assert second["index"] == 1
    assert stored["nextIndex"] == 2
    assert stored["finalAnswer"] == "hello"
    assert stored["status"] == "done"
    assert stored["diagnostics"] == {"ok": True}
    assert [event["index"] for event in agent_runs.events_after(run_id, 0)] == [1]


def test_reset_events_keep_snapshots_derived_from_event_log(tmp_settings) -> None:
    run_id = agent_runs.create_run(valid_payload())["runId"]

    agent_runs.append_event(run_id, {"type": "agent_delta", "phase": "coder", "name": "Coder", "text": "old output"})
    agent_runs.append_event(run_id, {"type": "content", "text": "old final"})
    assert agent_runs.load_run(run_id)["agentOutputs"]["coder"]["content"] == "old output"
    assert agent_runs.load_run(run_id)["finalAnswer"] == "old final"

    agent_reset = agent_runs.append_event(run_id, {"type": "agent_reset", "phase": "coder", "reason": "rerun_agent"})
    final_reset = agent_runs.append_event(run_id, {"type": "final_reset", "scope": "final_answer", "reason": "rerun_synthesizer"})
    stored = agent_runs.load_run(run_id)

    assert agent_reset["runId"] == run_id
    assert final_reset["scope"] == "final_answer"
    assert "coder" not in stored["agentOutputs"]
    assert stored["finalAnswer"] == ""


def test_replace_with_retry_handles_transient_windows_lock(tmp_settings, monkeypatch: pytest.MonkeyPatch) -> None:
    source = agent_runs.AGENT_RUNS_DIR / "retry-source.tmp"
    target = agent_runs.AGENT_RUNS_DIR / "retry-target.json"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text('{"ok": true}', encoding="utf-8")
    attempts = {"count": 0}
    original_replace = Path.replace

    def flaky_replace(self: Path, target_path: Path) -> Path:
        if Path(self) == source and Path(target_path) == target and attempts["count"] < 2:
            attempts["count"] += 1
            raise PermissionError("locked")
        return original_replace(self, target_path)

    monkeypatch.setattr(Path, "replace", flaky_replace)

    agent_runs.replace_with_retry(source, target, delays=(0.0, 0.0, 0.0))

    assert attempts["count"] == 2
    assert not source.exists()
    assert target.read_text(encoding="utf-8") == '{"ok": true}'


def test_parallel_event_writes_leave_no_shared_tmp_files(tmp_settings) -> None:
    run_id = agent_runs.create_run(valid_payload())["runId"]
    errors: list[BaseException] = []

    def worker(index: int) -> None:
        try:
            agent_runs.append_event(run_id, {"type": "agent_note", "phase": f"worker-{index}", "text": f"note {index}"})
        except BaseException as exc:  # pragma: no cover - surfaced by assertion below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)

    stored = agent_runs.load_run(run_id)

    assert errors == []
    assert stored["nextIndex"] == 12
    assert [event["index"] for event in stored["events"]] == list(range(12))
    assert not list(agent_runs.AGENT_RUNS_DIR.glob("*.tmp"))


def test_registry_prevents_duplicate_start_and_allows_waiters_to_attach() -> None:
    registry = agent_runs.AgentRunRegistry()
    entered = threading.Event()
    release = threading.Event()

    def target() -> None:
        entered.set()
        release.wait(timeout=2)

    assert registry.ensure_started("run_test12345678", target) is True
    assert entered.wait(timeout=1)
    assert registry.ensure_started("run_test12345678", target) is False

    notified = threading.Event()

    def waiter() -> None:
        registry.wait_for_event("run_test12345678", timeout=1)
        notified.set()

    wait_thread = threading.Thread(target=waiter)
    wait_thread.start()
    registry.notify_event("run_test12345678")
    wait_thread.join(timeout=2)
    release.set()

    assert notified.is_set()


def test_startup_marks_leftover_running_runs_as_orphaned(tmp_settings) -> None:
    run_id = agent_runs.create_run(valid_payload())["runId"]
    agent_runs.append_status(run_id, "running")

    assert agent_runs.mark_orphan_runs_on_startup() == 1

    stored = agent_runs.load_run(run_id)
    assert stored["status"] == "orphaned"
    assert stored["events"][-1]["reason"] == "server_restart"


def test_confirm_plan_policy_prefers_fast_path_unless_requested_or_auto() -> None:
    payload = valid_payload()

    assert agent_runs.should_confirm_plan(payload, confirm_plan=False, agent_preset="full") is False
    assert agent_runs.should_confirm_plan(payload, confirm_plan=True, agent_preset="full") is True
    assert agent_runs.should_confirm_plan(payload, confirm_plan=False, agent_preset="auto") is True


def test_rerun_agent_resets_phase_and_final_answer_without_cascading(tmp_settings, monkeypatch: pytest.MonkeyPatch) -> None:
    run_id = agent_runs.create_run(valid_payload())["runId"]
    agent_runs.append_event(run_id, {"type": "agent_plan", "plan": [{"id": "coder", "task": "检查代码"}]})
    agent_runs.append_event(
        run_id,
        {
            "type": "agent_output",
            "phase": "coder",
            "output": {"id": "coder", "name": "Coder", "task": "检查代码", "content": "old", "full_output": "old"},
        },
    )
    agent_runs.append_event(run_id, {"type": "content", "text": "old final"})
    agent_runs.append_status(run_id, "done")

    def fake_run_agent(*args, **kwargs):
        return {
            "id": "coder",
            "name": "Coder",
            "task": "检查代码",
            "content": "new coder output",
            "summary": "new",
            "evidence": "",
            "risks": "",
            "full_output": "new coder output",
            "usage": {},
        }

    def fake_synthesis(*args, emit_event, **kwargs) -> None:
        emit_event({"type": "content", "text": "new final"})
        emit_event({"type": "done", "content": "new final", "diagnostics": {"agentCount": 1}})

    monkeypatch.setattr(agent_runs, "run_agent", fake_run_agent)
    monkeypatch.setattr(agent_runs, "stream_synthesis_for_outputs", fake_synthesis)

    agent_runs.rerun_agent(run_id, valid_payload(), agent_id="coder", resynthesize=True)
    stored = agent_runs.load_run(run_id)
    event_types = [event["type"] for event in stored["events"]]

    assert "agent_reset" in event_types
    assert "final_reset" in event_types
    assert stored["agentOutputs"]["coder"]["content"] == "new coder output"
    assert stored["finalAnswer"] == "new final"
    assert stored["status"] == "done"
    assert any("未自动重跑" in event.get("text", "") for event in stored["events"])


def test_run_files_are_valid_json_snapshots(tmp_settings) -> None:
    run_id = agent_runs.create_run(valid_payload())["runId"]
    agent_runs.append_event(run_id, {"type": "agent_plan", "plan": [{"id": "critic", "task": "复核"}]})

    snapshot = json.loads((agent_runs.AGENT_RUNS_DIR / f"{run_id}.json").read_text(encoding="utf-8"))

    assert snapshot["runId"] == run_id
    assert snapshot["plan"] == [{"id": "critic", "task": "复核"}]
    assert snapshot["events"][0]["createdAt"].endswith("Z")
