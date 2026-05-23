"""DeepSeek request orchestration, prompt assembly, and sync/stream HTTP calls."""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

from deepseek_mobile.core.config import (
    DEEPSEEK_TIMEOUT_SECONDS,
    DEEPSEEK_URL,
    DEFAULT_MODEL,
    SUPPORTED_MODELS,
    settings,
)
from deepseek_mobile.services.chat_payload import count_payload_attachments, expanded_message_content
from deepseek_mobile.services.context_compressor import format_context_summary_context
from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services.memory import empty_memory_state, format_memory_notice, memory_scope_from_payload, prepare_memory_state
from deepseek_mobile.services.search import (
    aggregate_search_rounds,
    compact_search_tool_result,
    diagnostics_with_search,
    format_search_context,
    format_search_failure_context,
    normalize_search_query_text,
    search_for_client,
    search_multiple,
    search_queries_for,
    search_single_round,
)
from deepseek_mobile.services.tools import MAX_TOOL_ROUNDS, available_tool_definitions, execute_tool_calls
from deepseek_mobile.core.utils import format_upstream_error, latest_user_query, normalize_model_name

logger = logging.getLogger("deepseek_mobile.deepseek")

MESSAGE_HARD_LIMIT = 40
REASONING_EFFORTS = {"minimal", "low", "medium", "high", "max"}
TOOL_PARALLEL_SYSTEM_HINT = "当需要多个独立信息时（如查询多个不同 URL、多个不同文件），请在同一回复中并行发起多个工具调用，而不是一轮一个。"
WEB_SEARCH_SYSTEM_HINT = (
    "If web search is available, decide whether to call web_search before answering. "
    "For current facts, prices, releases, documentation, citations, product comparisons, or uncertain external claims, search first. "
    "If the available results are enough, do not keep searching; when a key fact is still missing, call web_search at most once more with a refined query. "
    "Cite web search results with the exact [^Wn] markers provided by web_search or the per-turn search context. "
    "Do not invent citation ids or use free-form labels like [Source] or [Reddit]. "
    "Cite uploaded files with the existing [^Fn-m] markers."
)
WEB_SEARCH_TURN_LIMIT = 5
WEB_SEARCH_LIMIT_ERROR = "本轮搜索次数已达上限，请基于已有搜索结果回答。"
TOOL_BUDGET_EXHAUSTED_PROMPT = (
    "本轮可用的本地工具调用次数已经用完。请不要再调用任何工具，"
    "直接基于已经获得的信息和对话上下文给出最终回答；如信息不足，请明确说明。"
)


class RequestCancelled(Exception):
    """Raised internally when a streaming request is cancelled or the client disconnects."""


def request_cancelled(cancel_event: threading.Event | None = None) -> bool:
    return bool(cancel_event is not None and cancel_event.is_set())


def raise_if_cancelled(cancel_event: threading.Event | None = None) -> None:
    if request_cancelled(cancel_event):
        raise RequestCancelled()


def force_final_answer_without_tools(body: dict[str, Any]) -> dict[str, Any]:
    messages = list(body.get("messages") or [])
    messages.append({"role": "user", "content": TOOL_BUDGET_EXHAUSTED_PROMPT})
    next_body = {key: value for key, value in body.items() if key != "tools"}
    next_body["messages"] = messages
    return next_body


class SearchBudget:
    """Thread-safe shared search budget for multi-agent requests."""

    def __init__(self, *, total_limit: int, per_key_limit: int | None = None) -> None:
        self.total_limit = max(0, int(total_limit))
        self.per_key_limit = max(0, int(per_key_limit)) if per_key_limit is not None else None
        self.used = 0
        self.used_by_key: dict[str, int] = {}
        self._lock = threading.Lock()

    def try_consume(self, key: str = "default") -> bool:
        normalized_key = str(key or "default")
        with self._lock:
            if self.used >= self.total_limit:
                return False
            if self.per_key_limit is not None and self.used_by_key.get(normalized_key, 0) >= self.per_key_limit:
                return False
            self.used += 1
            self.used_by_key[normalized_key] = self.used_by_key.get(normalized_key, 0) + 1
            return True


@dataclass(frozen=True)
class PreparedDeepSeekRequest:
    api_key: str
    body: dict[str, Any]
    diagnostics: dict[str, Any]


@dataclass(frozen=True)
class PreparedDeepSeekCall:
    request: PreparedDeepSeekRequest
    search_data: dict[str, Any] | None


def validate_deepseek_payload(payload: dict[str, Any]) -> tuple[str, str, list[Any]]:
    api_key = str(payload.get("apiKey") or settings.deepseek_api_key or "").strip()
    if not api_key:
        raise AppError("Missing DeepSeek API Key. Set DEEPSEEK_API_KEY or enter a key in settings.", code=ErrorCode.MISSING_API_KEY)

    model = normalize_model_name(payload.get("model") or DEFAULT_MODEL)
    if model not in SUPPORTED_MODELS:
        raise AppError("Unsupported model", code=ErrorCode.INVALID_PAYLOAD)

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AppError("At least one message is required", code=ErrorCode.INVALID_PAYLOAD)

    return api_key, model, messages


ValidatedPayload = tuple[str, str, list[Any]]


def preflight_deepseek_payload(payload: dict[str, Any]) -> ValidatedPayload:
    validated = validate_deepseek_payload(payload)
    _validate_request_messages(payload, validated[2])
    return validated


def _validate_request_messages(payload: dict[str, Any], messages: list[Any]) -> None:
    context_summary = str(payload.get("contextSummary") or "").strip()
    normalized_messages = normalize_chat_messages(messages)
    if len(normalized_messages) > MESSAGE_HARD_LIMIT and not context_summary:
        raise AppError(
            "Context compression required before sending more than 40 messages.",
            code=ErrorCode.CONTEXT_COMPRESSION_REQUIRED,
            status=409,
        )
    if not any(item["role"] == "user" for item in normalized_messages):
        raise AppError("A user message is required", code=ErrorCode.INVALID_PAYLOAD)


def build_deepseek_request(
    payload: dict[str, Any],
    *,
    stream: bool,
    memory_state: dict[str, Any] | None = None,
    validated: ValidatedPayload | None = None,
) -> PreparedDeepSeekRequest:
    api_key, model, messages = validated or validate_deepseek_payload(payload)
    tools_enabled = payload.get("toolsEnabled") is not False

    # DeepSeek prompt cache 按 message 字面 prefix 严格匹配。任何让 system message
    # 字符变化的字段都会让其后所有 history 全部 cache miss。这里 stable_system_parts
    # 只包含真正会话级稳定的内容（角色提示 + 工具/搜索 system hint）。
    # context_summary 走 dynamic turn-context（注入 latest user），让 system 保持稳定，
    # 命中可以贯穿到 last assistant message。
    stable_system_parts: list[str] = []
    system_prompt = str(payload.get("systemPrompt") or "").strip()
    if system_prompt:
        stable_system_parts.append(system_prompt)

    if tools_enabled:
        stable_system_parts.append(TOOL_PARALLEL_SYSTEM_HINT)
        if search_tool_enabled(payload):
            stable_system_parts.append(WEB_SEARCH_SYSTEM_HINT)

    context_summary = str(payload.get("contextSummary") or "").strip()

    api_messages: list[dict[str, Any]] = []
    if stable_system_parts:
        api_messages.append({"role": "system", "content": "\n\n".join(stable_system_parts)})

    normalized_messages = normalize_chat_messages(messages)
    _validate_request_messages(payload, messages)

    memory_state = memory_state or empty_memory_state(payload)
    memory_enabled = bool(memory_state.get("enabled"))
    memory_hit_count = int(memory_state.get("hitCount") or 0)
    dynamic_context = build_dynamic_turn_context(payload, memory_state)
    if dynamic_context:
        normalized_messages = append_context_to_latest_user(normalized_messages, dynamic_context)

    api_messages.extend(normalized_messages)

    request_body: dict[str, Any] = {"model": model, "messages": api_messages, "stream": stream}
    if tools_enabled:
        request_body["tools"] = tools_for_payload(payload)
        request_body["tool_choice"] = "auto"

    if model == "deepseek-v4-flash":
        temperature = payload.get("temperature", 1.0)
        if isinstance(temperature, (int, float)):
            request_body["temperature"] = max(0, min(float(temperature), 2))
        else:
            request_body["temperature"] = 1.0
        request_body["top_p"] = 1.0

    thinking_enabled = payload.get("thinkingEnabled")
    if thinking_enabled is None:
        thinking_enabled = model == "deepseek-v4-pro"

    if thinking_enabled is True:
        request_body["reasoning_effort"] = normalize_reasoning_effort(payload.get("reasoningEffort"))
        request_body["thinking"] = {"type": "enabled"}

    def diagnostic_int(name: str) -> int:
        try:
            return max(0, int(payload.get(name) or 0))
        except (TypeError, ValueError):
            return 0

    diagnostics = {
        "requestMessageCount": sum(1 for item in api_messages if item.get("role") in {"user", "assistant"}),
        "contextSummaryChars": len(context_summary),
        "dynamicContextChars": len(dynamic_context),
        "contextSummaryGeneration": diagnostic_int("contextSummaryGeneration"),
        "contextSummaryMessageCount": diagnostic_int("contextSummaryMessageCount"),
        "contextCompressionDeltaCount": diagnostic_int("contextCompressionDeltaCount"),
        "memoryEnabled": memory_enabled,
        "memoryHitCount": memory_hit_count,
        "attachmentCount": count_payload_attachments(messages),
        "searchRoundCount": 0,
        "searchResultCount": 0,
        "toolCallCount": 0,
        "toolNames": [],
    }
    return PreparedDeepSeekRequest(api_key=api_key, body=request_body, diagnostics=diagnostics)


def search_mode(payload: dict[str, Any]) -> str:
    return str(payload.get("searchMode") or "auto").strip().lower()


def forced_search_mode(payload: dict[str, Any]) -> bool:
    return search_mode(payload) in {"on", "force", "true", "1"}


def search_tool_enabled(payload: dict[str, Any]) -> bool:
    if payload.get("searchEnabled") is not True:
        return False
    return search_mode(payload) not in {"off", "false", "0"}


def tools_for_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    tools = available_tool_definitions()
    allowed = payload.get("allowedTools")
    if isinstance(allowed, list):
        allowed_names = {str(item) for item in allowed}
        tools = [tool for tool in tools if str(tool.get("function", {}).get("name") or "") in allowed_names]
    if search_tool_enabled(payload):
        return tools
    return [tool for tool in tools if tool.get("function", {}).get("name") not in {"web_search", "compare_search_results"}]


def normalize_reasoning_effort(value: Any) -> str:
    effort = str(value or "").strip()
    return effort if effort in REASONING_EFFORTS else "high"


def normalize_chat_messages(messages: list[Any]) -> list[dict[str, Any]]:
    api_messages: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = expanded_message_content(message)
        if role == "tool":
            tool_call_id = str(message.get("tool_call_id") or "").strip()
            if isinstance(content, str) and content.strip() and tool_call_id:
                api_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": content.strip()})
            continue
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        tool_calls = normalize_tool_calls(message.get("tool_calls")) if role == "assistant" else []
        if role == "assistant" and tool_calls:
            api_messages.append({"role": role, "content": content.strip(), "tool_calls": tool_calls})
            continue
        if content.strip():
            api_messages.append({"role": role, "content": content.strip()})
    return api_messages


def normalize_tool_calls(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    tool_calls: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        raw_function = item.get("function")
        function: dict[str, Any] = raw_function if isinstance(raw_function, dict) else {}
        name = str(function.get("name") or item.get("name") or "").strip()
        arguments = function.get("arguments", "")
        if not name:
            continue
        tool_calls.append(
            {
                "id": str(item.get("id") or f"call_{index + 1}"),
                "type": str(item.get("type") or "function"),
                "function": {"name": name, "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)},
            }
        )
    return tool_calls


def build_dynamic_turn_context(payload: dict[str, Any], memory_state: dict[str, Any]) -> str:
    dynamic_parts: list[str] = []

    # context_summary 放在 dynamic 段而非 system，让 system message 保持字面稳定，
    # 提高 DeepSeek prompt cache 命中率。摘要更新时只让 latest user 这一条 miss，
    # 而不会让所有历史 message 全部 miss。
    context_summary = str(payload.get("contextSummary") or "").strip()
    if context_summary:
        dynamic_parts.append(format_context_summary_context(context_summary))

    memory_context = str(memory_state.get("context") or "").strip()
    if memory_context:
        dynamic_parts.append(memory_context)

    memory_notice = str(memory_state.get("notice") or "").strip()
    if memory_notice:
        dynamic_parts.append(format_memory_notice(memory_notice))

    search_context = str(payload.get("searchContext") or "").strip()
    if search_context:
        dynamic_parts.append(search_context)

    continuation_context = str(payload.get("continuationContext") or "").strip()
    if continuation_context:
        dynamic_parts.append(continuation_context)

    if not dynamic_parts:
        return ""
    return "\n\n".join(["[Per-turn context]", *dynamic_parts])


def append_context_to_latest_user(messages: list[dict[str, Any]], dynamic_context: str) -> list[dict[str, Any]]:
    result = [dict(message) for message in messages]
    for index in range(len(result) - 1, -1, -1):
        if result[index].get("role") == "user":
            user_content = str(result[index].get("content") or "")
            result[index]["content"] = f"{dynamic_context}\n\n[User message]\n{user_content}".strip()
            return result
    return result


def prepare_deepseek_call(
    payload: dict[str, Any],
    *,
    stream: bool,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    system_note_callback: Callable[[str], None] | None = None,
) -> PreparedDeepSeekCall:
    validated = preflight_deepseek_payload(payload)
    memory_state = prepare_memory_state(payload)
    search_data = None
    if forced_search_mode(payload):
        search_data = search_if_needed(payload, progress_callback=progress_callback, system_note_callback=system_note_callback)
    if search_data and search_data.get("results"):
        payload = {**payload, "searchContext": format_search_context(search_data)}
    elif search_data and search_data.get("status") == "error":
        payload = {**payload, "searchContext": format_search_failure_context(search_data)}
    prepared = build_deepseek_request(payload, stream=stream, memory_state=memory_state, validated=validated)
    return PreparedDeepSeekCall(request=prepared, search_data=search_data)


def search_if_needed(
    payload: dict[str, Any],
    *,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    system_note_callback: Callable[[str], None] | None = None,
) -> dict[str, Any] | None:
    if payload.get("searchEnabled") is not True:
        return None
    if not forced_search_mode(payload):
        return None
    query = latest_user_query(payload)
    if not query:
        raise AppError("Search query is empty", code=ErrorCode.INVALID_PAYLOAD)
    if system_note_callback:
        search_queries = search_queries_for(query)
        if search_queries:
            system_note_callback(f"已为本轮预取搜索结果。第一轮方向：{search_queries[0]}\n后续如需补充，会通过搜索工具继续查询。\n\n")
    tavily_api_key = str(payload.get("tavilyApiKey") or "").strip()
    search_data = search_multiple(query, progress_callback=progress_callback, tavily_api_key=tavily_api_key)
    if system_note_callback and search_data:
        if search_data.get("results"):
            if search_data.get("cached"):
                system_note_callback("已命中本地搜索缓存。我会复用已缓存的搜索来源继续回答。\n\n")
            else:
                system_note_callback("搜索预取已完成。我会结合来源继续推理；如信息不足，可再通过搜索工具补充。\n\n")
        elif search_data.get("status") == "error":
            errors = [
                str(round_item.get("error") or "")
                for round_item in (search_data.get("rounds") or [])
                if isinstance(round_item, dict) and round_item.get("error")
            ]
            detail = errors[0] if errors else "未知错误"
            system_note_callback(f"预取搜索失败：{detail}\n我会继续基于已有上下文回答；如有需要可再次通过搜索工具尝试。\n\n")
    return search_data


def web_search_callback_for_turn(
    payload: dict[str, Any],
    initial_search_data: dict[str, Any] | None,
    *,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    turn_limit: int = WEB_SEARCH_TURN_LIMIT,
    search_budget: SearchBudget | None = None,
    budget_key: str = "default",
) -> tuple[Callable[[str, str], dict[str, Any]], Callable[[], dict[str, Any] | None]]:
    base_query = latest_user_query(payload)
    tavily_api_key = str(payload.get("tavilyApiKey") or "").strip()
    rounds_by_index: dict[int, dict[str, Any]] = {}
    cached_tool_results: dict[str, dict[str, Any]] = {}
    counter = 0
    citation_counter = 0
    latest_search_data = initial_search_data

    if initial_search_data:
        for item in initial_search_data.get("rounds") or []:
            if not isinstance(item, dict):
                continue
            try:
                index = int(item.get("round") or 0)
            except (TypeError, ValueError):
                index = 0
            if index <= 0:
                continue
            rounds_by_index[index] = item
            counter = max(counter, index)
            key = normalize_search_query_text(str(item.get("query") or "")).lower()
            if key:
                cached_tool_results[key] = compact_search_tool_result(item, citation_offset=citation_counter)
                citation_counter += len(cached_tool_results[key].get("results") or [])

    def ordered_rounds() -> list[dict[str, Any]]:
        return [rounds_by_index[index] for index in sorted(rounds_by_index)]

    def record_progress(round_data: dict[str, Any]) -> None:
        nonlocal latest_search_data
        try:
            index = int(round_data.get("round") or 0)
        except (TypeError, ValueError):
            index = 0
        if index > 0:
            rounds_by_index[index] = round_data
        latest_search_data = aggregate_search_rounds(base_query, ordered_rounds())
        if progress_callback:
            progress_callback(latest_search_data)

    def limit_result(query: str, intent: str, error: str) -> dict[str, Any]:
        nonlocal counter
        counter += 1
        round_data = {
            "query": query,
            "round": counter,
            "intent": str(intent or "general"),
            "answer": "",
            "results": [],
            "status": "error",
            "error": error,
            "retried": False,
            "retryQuery": "",
            "retryError": "",
            "cached": False,
        }
        record_progress(round_data)
        return compact_search_tool_result(round_data, intent=str(intent or "general"), citation_offset=citation_counter)

    def perform_web_search(query: str, intent: str) -> dict[str, Any]:
        nonlocal counter, citation_counter
        cleaned = normalize_search_query_text(query)
        key = cleaned.lower()
        if key and key in cached_tool_results:
            return {**cached_tool_results[key], "cached": True}
        if counter >= max(1, int(turn_limit or WEB_SEARCH_TURN_LIMIT)):
            return limit_result(cleaned, intent, WEB_SEARCH_LIMIT_ERROR)
        if search_budget is not None and not search_budget.try_consume(budget_key):
            return limit_result(cleaned, intent, WEB_SEARCH_LIMIT_ERROR)
        counter += 1
        result = search_single_round(
            cleaned,
            intent=intent,
            round_index=counter,
            citation_offset=citation_counter,
            tavily_api_key=tavily_api_key,
            progress_callback=record_progress,
        )
        citation_counter += len(result.get("results") or [])
        if key:
            cached_tool_results[key] = result
        return result

    return perform_web_search, lambda: latest_search_data


def deepseek_request(prepared: PreparedDeepSeekRequest, *, accept: str) -> urllib.request.Request:
    return urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(prepared.body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {prepared.api_key}",
            "Content-Type": "application/json",
            "Accept": accept,
        },
        method="POST",
    )


def diagnostics_with_usage(diagnostics: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    result = dict(diagnostics)
    hit_tokens = usage_int(usage, "prompt_cache_hit_tokens", "promptCacheHitTokens")
    miss_tokens = usage_int(usage, "prompt_cache_miss_tokens", "promptCacheMissTokens")
    result["cacheHitTokens"] = hit_tokens
    result["cacheMissTokens"] = miss_tokens
    total_cache_tokens = hit_tokens + miss_tokens
    result["cacheHitRate"] = round((hit_tokens / total_cache_tokens) * 100, 1) if total_cache_tokens else 0.0
    return result


def usage_int(usage: dict[str, Any], *names: str) -> int:
    for name in names:
        if name not in usage or usage.get(name) in (None, ""):
            continue
        try:
            return max(0, int(usage.get(name)))
        except (TypeError, ValueError):
            continue
    return 0


def first_response_message(response_json: dict[str, Any]) -> dict[str, Any]:
    choices = response_json.get("choices") or []
    if not choices:
        raise AppError("DeepSeek returned no answer", code=ErrorCode.UPSTREAM_FAILURE, status=502)
    message = choices[0].get("message") or {}
    return message if isinstance(message, dict) else {}


def request_with_body(prepared: PreparedDeepSeekRequest, body: dict[str, Any], *, accept: str) -> urllib.request.Request:
    return deepseek_request(PreparedDeepSeekRequest(api_key=prepared.api_key, body=body, diagnostics=prepared.diagnostics), accept=accept)


def tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
    names = []
    for tool_call in tool_calls:
        raw_function = tool_call.get("function")
        function: dict[str, Any] = raw_function if isinstance(raw_function, dict) else {}
        name = str(function.get("name") or "").strip()
        if name:
            names.append(name)
    return names


def diagnostics_with_tools(diagnostics: dict[str, Any], *, count: int, names: list[str]) -> dict[str, Any]:
    result = dict(diagnostics)
    result["toolCallCount"] = count
    result["toolNames"] = sorted(set(names))
    return result


def append_tool_exchange(
    body: dict[str, Any],
    assistant_message: dict[str, Any],
    tool_calls: list[dict[str, Any]],
    *,
    memory_suggestion_callback: Callable[[dict[str, Any]], None] | None = None,
    default_memory_scope: str = "global",
    web_search_callback: Callable[[str, str], dict[str, Any]] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    raise_if_cancelled(cancel_event)
    messages = list(body.get("messages") or [])
    assistant_payload = {
        "role": "assistant",
        "content": str(assistant_message.get("content") or ""),
        "tool_calls": tool_calls,
    }
    reasoning = assistant_message.get("reasoning_content") or assistant_message.get("reasoning")
    if reasoning:
        assistant_payload["reasoning_content"] = str(reasoning)
    messages.append(assistant_payload)
    messages.extend(
        execute_tool_calls(
            tool_calls,
            memory_suggestion_callback=memory_suggestion_callback,
            default_memory_scope=default_memory_scope,
            web_search_callback=web_search_callback,
            cancel_event=cancel_event,
        )
    )
    raise_if_cancelled(cancel_event)
    return {**body, "messages": messages}


def merge_stream_tool_call_deltas(accumulator: dict[int, dict[str, Any]], deltas: Any) -> None:
    if not isinstance(deltas, list):
        return
    for item in deltas:
        if not isinstance(item, dict):
            continue
        index_value = item.get("index")
        if index_value is None:
            index = len(accumulator)
        else:
            try:
                index = int(index_value)
            except (TypeError, ValueError):
                index = len(accumulator)
        current = accumulator.setdefault(index, {"id": f"call_{index + 1}", "type": "function", "function": {"name": "", "arguments": ""}})
        if item.get("id"):
            current["id"] = str(item["id"])
        if item.get("type"):
            current["type"] = str(item["type"])
        function = item.get("function")
        if isinstance(function, dict):
            current_function = current["function"]
            if function.get("name"):
                current_function["name"] = str(function["name"])
            if function.get("arguments"):
                current_function["arguments"] += str(function["arguments"])


def finalized_stream_tool_calls(accumulator: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    return normalize_tool_calls([accumulator[index] for index in sorted(accumulator)])


def call_deepseek(
    payload: dict[str, Any],
    *,
    search_budget: SearchBudget | None = None,
    web_search_turn_limit: int = WEB_SEARCH_TURN_LIMIT,
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
    budget_key: str = "default",
) -> dict[str, Any]:
    prepared_call = prepare_deepseek_call(payload, stream=False)
    prepared = prepared_call.request
    body = prepared.body
    default_memory_scope = memory_scope_from_payload(payload)
    tool_call_count = 0
    seen_tool_names: list[str] = []
    memory_suggestions: list[dict[str, Any]] = []
    perform_web_search, current_search_data = web_search_callback_for_turn(
        payload,
        prepared_call.search_data,
        turn_limit=web_search_turn_limit,
        search_budget=search_budget,
        budget_key=budget_key,
    )
    for tool_round in range(max_tool_rounds + 2):
        request = request_with_body(prepared, body, accept="application/json")
        try:
            with urllib.request.urlopen(request, timeout=DEEPSEEK_TIMEOUT_SECONDS) as response:
                response_json = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise AppError(format_upstream_error(detail), code=ErrorCode.UPSTREAM_FAILURE, status=min(exc.code, 502)) from exc
        except urllib.error.URLError as exc:
            code = ErrorCode.UPSTREAM_TIMEOUT if "timed out" in str(exc.reason).lower() else ErrorCode.UPSTREAM_FAILURE
            raise AppError(f"Cannot reach DeepSeek API: {exc.reason}", code=code, status=502) from exc
        answer = first_response_message(response_json)
        tool_calls = normalize_tool_calls(answer.get("tool_calls"))
        if not tool_calls:
            break
        if tool_round >= max_tool_rounds:
            seen_tool_names.extend(tool_names(tool_calls))
            body = force_final_answer_without_tools(body)
            continue
        tool_call_count += len(tool_calls)
        seen_tool_names.extend(tool_names(tool_calls))
        body = append_tool_exchange(
            body,
            answer,
            tool_calls,
            memory_suggestion_callback=memory_suggestions.append,
            default_memory_scope=default_memory_scope,
            web_search_callback=perform_web_search if search_tool_enabled(payload) else None,
        )
    usage = response_json.get("usage") or {}
    search_data = current_search_data()
    diagnostics = diagnostics_with_tools(prepared.diagnostics, count=tool_call_count, names=seen_tool_names)
    result = {
        "id": response_json.get("id"),
        "model": response_json.get("model", body["model"]),
        "content": answer.get("content") or "",
        "reasoning": answer.get("reasoning_content") or "",
        "usage": usage,
        "diagnostics": diagnostics_with_usage(diagnostics_with_search(diagnostics, search_data), usage),
    }
    if search_data:
        result["search"] = search_for_client(search_data)
    if memory_suggestions:
        result["memorySuggestions"] = memory_suggestions
    return result


def stream_deepseek(
    payload: dict[str, Any],
    emit_event: Callable[[dict[str, Any]], None],
    *,
    search_budget: SearchBudget | None = None,
    web_search_turn_limit: int = WEB_SEARCH_TURN_LIMIT,
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
    budget_key: str = "default",
    cancel_event: threading.Event | None = None,
) -> None:
    content = ""
    reasoning = ""
    response_id = None
    response_model = normalize_model_name(payload.get("model") or DEFAULT_MODEL)
    usage: dict[str, Any] = {}
    search_for_response: dict[str, Any] | None = None
    search_data: dict[str, Any] | None = None
    diagnostics: dict[str, Any] = {}

    def emit_checked(event: dict[str, Any]) -> None:
        raise_if_cancelled(cancel_event)
        emit_event(event)
        raise_if_cancelled(cancel_event)

    def emit_system_note(text: str) -> None:
        emit_checked({"type": "system_note", "text": text})

    def emit_search_progress(progress: dict[str, Any]) -> None:
        nonlocal search_for_response
        search_for_response = search_for_client(progress)
        emit_checked({"type": "search", "search": search_for_response})

    try:
        raise_if_cancelled(cancel_event)
        prepared_call = prepare_deepseek_call(payload, stream=True, progress_callback=emit_search_progress, system_note_callback=emit_system_note)
        prepared = prepared_call.request
        search_data = prepared_call.search_data
        diagnostics = prepared.diagnostics
        response_model = prepared.body["model"]
        search_for_response = search_for_client(search_data) if search_data else search_for_response
        body = prepared.body
        default_memory_scope = memory_scope_from_payload(payload)
        tool_call_count = 0
        seen_tool_names: list[str] = []
        memory_suggestions: list[dict[str, Any]] = []
        perform_web_search, current_search_data = web_search_callback_for_turn(
            payload,
            search_data,
            progress_callback=emit_search_progress,
            turn_limit=web_search_turn_limit,
            search_budget=search_budget,
            budget_key=budget_key,
        )

        def emit_memory_suggestion(suggestion: dict[str, Any]) -> None:
            memory_suggestions.append(suggestion)
            emit_checked({"type": "memory_suggestion", **suggestion})

        for tool_round in range(max_tool_rounds + 2):
            raise_if_cancelled(cancel_event)
            stream_tool_calls: dict[int, dict[str, Any]] = {}
            round_content = ""
            round_reasoning = ""
            request = request_with_body(prepared, body, accept="text/event-stream")

            with urllib.request.urlopen(request, timeout=DEEPSEEK_TIMEOUT_SECONDS) as upstream:
                event_name = "message"
                for raw_line in upstream:
                    raise_if_cancelled(cancel_event)
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        event_name = "message"
                        continue
                    if line.startswith("event:"):
                        event_name = line.removeprefix("event:").strip() or "message"
                        continue
                    if not line.startswith("data:"):
                        continue
                    event_data = line.removeprefix("data:").strip()
                    if event_data == "[DONE]":
                        break
                    if event_name == "error":
                        emit_checked({"type": "error", "error": sse_error_message(event_data), "code": ErrorCode.UPSTREAM_FAILURE.value})
                        return
                    try:
                        chunk = json.loads(event_data)
                    except json.JSONDecodeError:
                        logger.debug("invalid_stream_chunk", extra={"chunk": event_data[:200]})
                        continue
                    response_id = chunk.get("id") or response_id
                    response_model = chunk.get("model") or response_model
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    merge_stream_tool_call_deltas(stream_tool_calls, delta.get("tool_calls"))
                    delta_reasoning = (
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or delta.get("thinking_content")
                        or delta.get("thinking")
                    )
                    delta_content = delta.get("content")
                    if delta_reasoning:
                        text = str(delta_reasoning)
                        reasoning += text
                        round_reasoning += text
                        emit_checked({"type": "reasoning", "text": text})
                    if delta_content:
                        text = str(delta_content)
                        content += text
                        round_content += text
                        emit_checked({"type": "content", "text": text})

            tool_calls = finalized_stream_tool_calls(stream_tool_calls)
            raise_if_cancelled(cancel_event)
            if not tool_calls:
                break
            if tool_round >= max_tool_rounds:
                seen_tool_names.extend(tool_names(tool_calls))
                emit_checked({"type": "system_note", "text": "工具调用次数已达上限，改为直接整理最终回答。\n\n"})
                body = force_final_answer_without_tools(body)
                continue
            tool_call_count += len(tool_calls)
            names = tool_names(tool_calls)
            seen_tool_names.extend(names)
            emit_checked({"type": "system_note", "text": f"正在调用本地工具：{', '.join(names) or 'tool'}\n\n"})
            body = append_tool_exchange(
                body,
                {"content": round_content, "reasoning_content": round_reasoning},
                tool_calls,
                memory_suggestion_callback=emit_memory_suggestion,
                default_memory_scope=default_memory_scope,
                web_search_callback=perform_web_search if search_tool_enabled(payload) else None,
                cancel_event=cancel_event,
            )
            emit_checked({"type": "system_note", "text": "本地工具调用完成，继续生成回答。\n\n"})

        raise_if_cancelled(cancel_event)
        search_data = current_search_data()
        search_for_response = search_for_client(search_data) if search_data else search_for_response
        emit_checked({
            "type": "done",
            "id": response_id,
            "model": response_model,
            "content": content,
            "reasoning": reasoning,
            "usage": usage,
            "search": search_for_response,
            "memorySuggestions": memory_suggestions,
            "diagnostics": diagnostics_with_usage(
                diagnostics_with_search(diagnostics_with_tools(diagnostics, count=tool_call_count, names=seen_tool_names), search_data),
                usage,
            ),
        })
    except RequestCancelled:
        return
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        if cancel_event is not None:
            cancel_event.set()
        return
    except AppError as exc:
        emit_checked({"type": "error", "error": str(exc), "code": exc.code.value})
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        emit_checked({"type": "error", "error": format_upstream_error(detail), "code": ErrorCode.UPSTREAM_FAILURE.value})
    except urllib.error.URLError as exc:
        code = ErrorCode.UPSTREAM_TIMEOUT if "timed out" in str(exc.reason).lower() else ErrorCode.UPSTREAM_FAILURE
        emit_checked({"type": "error", "error": f"Cannot reach DeepSeek API: {exc.reason}", "code": code.value})
    except Exception:
        logger.exception("stream_error")
        emit_checked({"type": "error", "error": "Stream error", "code": ErrorCode.INTERNAL.value})


def sse_error_message(event_data: str) -> str:
    try:
        data = json.loads(event_data)
    except json.JSONDecodeError:
        return event_data[:500] or "Upstream stream error"
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("type")
            if message:
                return str(message)
        message = data.get("message") or data.get("type")
        if message:
            return str(message)
    return event_data[:500] or "Upstream stream error"
