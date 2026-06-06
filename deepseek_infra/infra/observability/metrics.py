"""Prometheus exposition for the local AI runtime (sourced from the trace store)."""

from __future__ import annotations

from deepseek_infra.infra.observability.observability import metrics_snapshot


def _line(name: str, value: float | int, help_text: str, metric_type: str = "counter") -> list[str]:
    return [f"# HELP {name} {help_text}", f"# TYPE {name} {metric_type}", f"{name} {value}"]


def render_prometheus() -> str:
    """Render the current local metrics snapshot as Prometheus text (v0.0.4)."""
    snapshot = metrics_snapshot()
    runs_by_kind = snapshot.get("runs_by_kind") or {}
    lines: list[str] = []
    lines += _line("ai_requests_total", int(snapshot.get("runs_total") or 0), "Total AI runs recorded by the local trace store.")
    lines += _line("ai_agent_runs_total", int(runs_by_kind.get("agent") or 0), "Multi-agent DAG runs.")
    lines += _line("ai_chat_runs_total", int(runs_by_kind.get("chat") or 0), "Single-turn chat runs.")
    lines += _line("ai_edge_runs_total", int(runs_by_kind.get("edge") or 0), "Edge (local model) runs.")
    lines += _line("ai_model_calls_total", int(snapshot.get("model_calls_total") or 0), "Upstream DeepSeek model API calls.")
    lines += _line(
        "ai_semantic_cache_checks_total",
        int(snapshot.get("semantic_cache_checks_total") or 0),
        "Semantic cache lookups performed before model calls.",
    )
    lines += _line("ai_semantic_cache_hits_total", int(snapshot.get("semantic_cache_hits_total") or 0), "Semantic cache hits.")
    lines += _line("ai_error_runs_total", int(snapshot.get("error_runs_total") or 0), "Runs that ended in error.")
    lines += _line("ai_tokens_total", int(snapshot.get("tokens_total") or 0), "Total tokens across recorded spans.")
    lines += _line(
        "ai_run_latency_ms_avg",
        float(snapshot.get("run_latency_ms_avg") or 0.0),
        "Average run latency in milliseconds.",
        "gauge",
    )
    lines += _line("ai_trace_enabled", 1 if snapshot.get("enabled") else 0, "Whether local tracing is enabled.", "gauge")
    return "\n".join(lines) + "\n"
