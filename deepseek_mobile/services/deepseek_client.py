"""DeepSeek request orchestration, prompt assembly, and sync/stream HTTP calls."""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

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
from deepseek_mobile.services.presentations import create_presentation_from_text
from deepseek_mobile.services.slides_skill import format_slides_skill_context
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
TOOL_PARALLEL_SYSTEM_HINT = (
    "当需要多个独立信息时（如查询多个不同 URL、多个不同文件），请在同一回复中并行发起多个工具调用，而不是一轮一个。"
    "当某个本地工具能直接产出用户想要的成果时，必须调用该工具，不要用文本或 Markdown 自行模拟其结果——"
    "用户要求制作 PPT / 幻灯片 / 演示文稿时调用 create_pptx 生成可下载文件，不要输出 Marp / Markdown 幻灯片大纲来代替；需要图表时调用 generate_chart。"
)
WEB_SEARCH_SYSTEM_HINT = (
    "If web search is available, decide whether to call web_search before answering. "
    "For current facts, prices, releases, documentation, citations, product comparisons, or uncertain external claims, search first. "
    "If the available results are enough, do not keep searching; when a key fact is still missing, call web_search at most once more with a refined query. "
    "Cite web search results with the exact [^Wn] markers provided by web_search or the per-turn search context. "
    "Do not invent citation ids or use free-form labels like [Source] or [Reddit]. "
    "Cite uploaded files with the existing [^Fn-m] markers."
)
WEB_SEARCH_TURN_LIMIT = 15
WEB_SEARCH_LIMIT_ERROR = "本轮搜索次数已达上限，请基于已有搜索结果回答。"
TOOL_BUDGET_EXHAUSTED_PROMPT = (
    "本轮可用的本地工具调用次数已经用完。请不要再调用任何工具，"
    "直接基于已经获得的信息和对话上下文给出最终回答；如信息不足，请明确说明。"
)
PRESENTATION_KEYWORDS_RE = re.compile(r"\b(?:ppt|powerpoint|presentation)\b|幻灯片|演示文稿", re.IGNORECASE)
PRESENTATION_CREATE_RE = re.compile(r"做|制作|生成|创建|帮我|给我|出一[份套]|设计|create|make|generate|build", re.IGNORECASE)
PRESENTATION_REFUSAL_RE = re.compile(r"(?:无法|不能|没有.*能力|不能直接|无法直接).{0,40}(?:pptx|PPT|幻灯片|演示文稿|文件)", re.IGNORECASE)


MINDMAP_KEYWORDS_RE = re.compile(r"思维导图|腦圖|脑图|mind\s*map|mindmap", re.IGNORECASE)
MINDMAP_CREATE_RE = re.compile(r"画|畫|做|生成|创建|建立|绘制|梳理|整理|导出|create|make|draw|generate|build|map", re.IGNORECASE)
CURRENT_TIME_CONTEXT_HEADER = "[Current time]"


class RequestCancelled(Exception):
    """Raised internally when a streaming request is cancelled or the client disconnects."""


def request_cancelled(cancel_event: threading.Event | None = None) -> bool:
    return bool(cancel_event is not None and cancel_event.is_set())


def raise_if_cancelled(cancel_event: threading.Event | None = None) -> None:
    if request_cancelled(cancel_event):
        raise RequestCancelled()


def force_final_answer_without_tools(body: dict[str, Any]) -> dict[str, Any]:
    # 达到工具轮次上限后让模型直接作答。保留 tools 数组——它在 prompt 前缀里，删掉会让这次
    # （上下文体量最大的）请求整段 cache miss；改用 tool_choice="none" 来禁止继续调用工具。
    messages = list(body.get("messages") or [])
    messages.append({"role": "user", "content": TOOL_BUDGET_EXHAUSTED_PROMPT})
    next_body = {**body, "messages": messages}
    if next_body.get("tools"):
        next_body["tool_choice"] = "none"
    else:
        next_body.pop("tool_choice", None)
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


class TokenBudget:
    """Thread-safe post-hoc token accounting for a multi-agent run.

    Unlike :class:`SearchBudget` (a *pre-action* gate on countable searches), a
    call's token count is only known *after* it returns. So this records usage
    as workers finish and exposes :meth:`exhausted` so the orchestrator can stop
    launching *new* tiers once the run has already overspent — it can never abort
    an in-flight call. ``total_limit <= 0`` means unlimited (never exhausted).
    """

    def __init__(self, *, total_limit: int) -> None:
        self.total_limit = max(0, int(total_limit))
        self.used = 0
        self._lock = threading.Lock()

    def record(self, tokens: int) -> int:
        with self._lock:
            self.used += max(0, int(tokens))
            return self.used

    def exhausted(self) -> bool:
        if self.total_limit <= 0:
            return False
        with self._lock:
            return self.used >= self.total_limit


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
    # 只包含真正会话级稳定的内容（角色提示 + 通用工具并行 hint）。
    # 搜索 hint / context_summary / memory 都走 trailing dynamic context，让 system
    # 在搜索开关变化时也保持稳定，命中可以贯穿到 last assistant message。
    stable_system_parts: list[str] = []
    system_prompt = str(payload.get("systemPrompt") or "").strip()
    if system_prompt:
        stable_system_parts.append(system_prompt)

    if tools_enabled:
        stable_system_parts.append(TOOL_PARALLEL_SYSTEM_HINT)

    context_summary = str(payload.get("contextSummary") or "").strip()

    api_messages: list[dict[str, Any]] = []
    if stable_system_parts:
        api_messages.append({"role": "system", "content": "\n\n".join(stable_system_parts)})

    normalized_messages = normalize_chat_messages(messages)
    _validate_request_messages(payload, messages)

    memory_state = memory_state or empty_memory_state(payload)
    memory_enabled = bool(memory_state.get("enabled"))
    memory_hit_count = int(memory_state.get("hitCount") or 0)
    dynamic_context = build_dynamic_turn_context(payload, memory_state, tools_enabled=tools_enabled)
    if dynamic_context:
        normalized_messages = append_context_to_latest_user(normalized_messages, dynamic_context)

    api_messages.extend(normalized_messages)

    # 含图片的多模态消息强制走视觉模型 deepseek-v4-pro（仅它支持读图 + 深度理解）；
    # 普通对话和多 Agent worker 共用此组装路径，所以两者都自动获得视觉能力。
    if _has_image_content(api_messages):
        model = "deepseek-v4-pro"

    request_body: dict[str, Any] = {"model": model, "messages": api_messages, "stream": stream}
    if tools_enabled:
        request_tools = tools_for_payload(payload)
        request_body["tools"] = request_tools
        forced_tool = forced_artifact_tool_name(payload, request_tools)
        if forced_tool:
            request_body["tool_choice"] = {"type": "function", "function": {"name": forced_tool}}
        else:
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


def presentation_intent_requested(payload: dict[str, Any]) -> bool:
    query = latest_user_query(payload)
    if not query or not PRESENTATION_KEYWORDS_RE.search(query):
        return False
    return bool(PRESENTATION_CREATE_RE.search(query))


def should_force_create_pptx(payload: dict[str, Any]) -> bool:
    return presentation_intent_requested(payload)


def has_create_pptx_tool(tools: list[dict[str, Any]]) -> bool:
    return any(str(tool.get("function", {}).get("name") or "") == "create_pptx" for tool in tools)


def mindmap_intent_requested(payload: dict[str, Any]) -> bool:
    query = latest_user_query(payload)
    if not query or not MINDMAP_KEYWORDS_RE.search(query):
        return False
    return bool(MINDMAP_CREATE_RE.search(query))


def forced_artifact_tool_name(payload: dict[str, Any], tools: list[dict[str, Any]]) -> str:
    if payload.get("toolsEnabled") is False:
        return ""
    available = {str(tool.get("function", {}).get("name") or "") for tool in tools}
    allowed = payload.get("allowedTools")
    allowed_names = {str(item) for item in allowed} if isinstance(allowed, list) else available
    if presentation_intent_requested(payload) and "create_pptx" in available and "create_pptx" in allowed_names:
        return "create_pptx"
    if mindmap_intent_requested(payload) and "create_mindmap" in available and "create_mindmap" in allowed_names:
        return "create_mindmap"
    return ""


def normalize_reasoning_effort(value: Any) -> str:
    effort = str(value or "").strip()
    return effort if effort in REASONING_EFFORTS else "high"


def _image_content_parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    """从 user message 的附件里提取带 base64 的图片，转成 OpenAI 兼容的 image_url content part。

    只认 ``imageData`` 为 ``data:image/...;base64,`` 形式的附件。前端只给本轮最新 user
    message 的图片注入 ``imageData``（历史图片不带），从而实现“图片首轮走视觉模型、后续轮
    退回 OCR 文字”，既省 token 又不破坏长历史的 cache 前缀。
    """
    attachments = message.get("attachments")
    if not isinstance(attachments, list):
        return []
    parts: list[dict[str, Any]] = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        image_data = str(attachment.get("imageData") or "").strip()
        if image_data.startswith("data:image/") and len(image_data) > 32:
            parts.append({"type": "image_url", "image_url": {"url": image_data}})
    return parts


def _has_image_content(api_messages: list[dict[str, Any]]) -> bool:
    for message in api_messages:
        content = message.get("content")
        if isinstance(content, list) and any(
            isinstance(part, dict) and part.get("type") == "image_url" for part in content
        ):
            return True
    return False


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
        if role == "user":
            image_parts = _image_content_parts(message)
            if image_parts:
                text = content.strip() if isinstance(content, str) else ""
                parts: list[dict[str, Any]] = [{"type": "text", "text": text}] if text else []
                parts.extend(image_parts)
                api_messages.append({"role": "user", "content": parts})
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


def normalize_tool_calls(value: Any, *, stable_ids: bool = False, canonical_arguments: bool = False) -> list[dict[str, Any]]:
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
        normalized_arguments = canonical_tool_arguments(arguments) if canonical_arguments else (
            arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
        )
        tool_call_id = stable_tool_call_id(index, name) if stable_ids else str(item.get("id") or f"call_{index + 1}")
        tool_calls.append(
            {
                "id": tool_call_id,
                "type": str(item.get("type") or "function"),
                "function": {"name": name, "arguments": normalized_arguments},
            }
        )
    return tool_calls


def stable_tool_call_id(index: int, name: str) -> str:
    safe_name = "".join(char if char.isalnum() else "_" for char in name.lower()).strip("_") or "tool"
    return f"call_{index + 1}_{safe_name[:48]}"


def canonical_tool_arguments(arguments: Any) -> str:
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return arguments.strip()
    else:
        parsed = arguments
    return json.dumps(parsed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def format_current_time_context(now: datetime | None = None) -> str:
    current = now or datetime.now().astimezone()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc).astimezone()
    utc_time = current.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    local_time = current.isoformat(timespec="seconds")
    timezone_name = current.tzname() or str(current.tzinfo) or "local"
    return (
        f"{CURRENT_TIME_CONTEXT_HEADER}\n"
        f"Local time: {local_time} ({timezone_name})\n"
        f"UTC time: {utc_time}\n"
        "Use this timestamp for current-time and relative-date questions in this turn."
    )


def build_dynamic_turn_context(payload: dict[str, Any], memory_state: dict[str, Any], *, tools_enabled: bool = True) -> str:
    dynamic_parts: list[str] = [format_current_time_context()]

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

    # 搜索能力是本轮开关，不属于稳定会话前缀。放在尾部 dynamic context 后，
    # 从“搜索关”切到“搜索开”不会让系统提示后的整段历史全部 cache miss。
    if tools_enabled and search_tool_enabled(payload):
        dynamic_parts.append(WEB_SEARCH_SYSTEM_HINT)

    if tools_enabled and presentation_intent_requested(payload):
        dynamic_parts.append(format_slides_skill_context())

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
    """把本轮 dynamic context 作为独立的 trailing system message 追加到 messages 末尾。

    历史教训：早期实现把 dynamic context 拼到 latest user 的 content 里。但前端 history
    只持久化原始 user content（未注入版本），所以下一轮发送时那条原本"latest"的 user
    在 history 中是原始字面 —— 与上一轮发送时（注入版）不同 —— DeepSeek prompt cache
    在那条 user 处就 miss，整段历史 cache 命中率长期个位数。

    改成 trailing system message 后：
    - history 里所有 user/assistant 在多轮发送间字面完全稳定 → cache 可贯穿到 latest user
    - 每轮变化的只剩末尾的 dynamic system message 这一条，对 prefix 命中无影响
    - 模型按顺序读 prompt，trailing system 紧跟在 latest user 之后，仍作为"回答本轮问题
      所需的本轮辅助信息"被使用（OpenAI 兼容协议允许 system message 出现在任意位置）
    """
    if not dynamic_context:
        return [dict(message) for message in messages]
    result = [dict(message) for message in messages]
    result.append({"role": "system", "content": dynamic_context})
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
            use_cache=True,
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


USAGE_SUM_FIELDS = (
    ("prompt_tokens", "promptTokens"),
    ("completion_tokens", "completionTokens"),
    ("total_tokens", "totalTokens"),
    ("prompt_cache_hit_tokens", "promptCacheHitTokens"),
    ("prompt_cache_miss_tokens", "promptCacheMissTokens"),
)


def merge_usage_totals(total: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(usage, dict) or not usage:
        return dict(total)
    result = dict(total)
    for canonical, alias in USAGE_SUM_FIELDS:
        value = usage_int(usage, canonical, alias)
        if value:
            result[canonical] = usage_int(result, canonical, alias) + value
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


def pptx_result_from_messages(body: dict[str, Any]) -> dict[str, Any] | None:
    artifact = terminal_artifact_result_from_messages(body)
    if artifact and artifact[0] == "create_pptx":
        return artifact[1]
    return None


def terminal_artifact_result_from_messages(body: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    for message in reversed(list(body.get("messages") or [])):
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        try:
            data = json.loads(str(message.get("content") or ""))
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict) or data.get("ok") is not True:
            continue
        tool = str(data.get("tool") or message.get("name") or "")
        if tool not in {"create_pptx", "create_document", "create_mindmap"}:
            continue
        result = data.get("result")
        if isinstance(result, dict) and download_url_has_pptx_id(str(result.get("downloadUrl") or "")):
            return tool, result
    return None


def response_has_pptx_link(content: str) -> bool:
    return download_url_has_pptx_id(str(content or ""))


def pptx_link_text(result: dict[str, Any], *, base_url: str = "") -> str:
    return artifact_link_text("create_pptx", result, base_url=base_url)


def artifact_link_text(tool: str, result: dict[str, Any], *, base_url: str = "") -> str:
    url = absolute_download_url(str(result.get("downloadUrl") or ""), base_url=base_url)
    filename = str(
        result.get("filename")
        or ("presentation.pptx" if tool == "create_pptx" else "mindmap.svg" if tool == "create_mindmap" else "document.docx")
    )
    outline = result.get("outline")
    titles: list[str] = []
    if isinstance(outline, list):
        for item in outline[:6]:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or item.get("heading") or item.get("label") or "").strip()
            if title:
                titles.append(title)
    inventory = f" Main items: {', '.join(titles)}." if titles else ""
    if tool == "create_mindmap":
        try:
            node_count = int(result.get("nodeCount") or 0)
        except (TypeError, ValueError):
            node_count = 0
        count_text = f"{node_count} nodes. " if node_count else ""
        return (
            f"Mind map SVG generated. {count_text}{inventory} Download link is valid for 6 hours.\n\n"
            f"![{filename}]({url})"
        )
    if tool == "create_document":
        format_label = "PDF" if str(result.get("format") or "").lower() == "pdf" else "Word"
        try:
            section_count = int(result.get("sectionCount") or 0)
        except (TypeError, ValueError):
            section_count = 0
        count_text = f"{section_count} sections. " if section_count else ""
        return f"{format_label} document generated: [{filename}]({url}). {count_text}{inventory} Download link is valid for 6 hours."
    try:
        slide_count = int(result.get("slideCount") or 0)
    except (TypeError, ValueError):
        slide_count = 0
    count_text = f"{slide_count} slides. " if slide_count else ""
    return f"PPT generated: [{filename}]({url}). {count_text}{inventory} Download link is valid for 6 hours."

def download_url_has_pptx_id(value: str) -> bool:
    return bool(re.search(r"(?:https?://[^)\s]+)?/api/download\?[^)\s#]*\bid=[0-9a-f]{32}", str(value or ""), flags=re.IGNORECASE))


def pptx_download_base_url(payload: dict[str, Any]) -> str:
    raw = str(payload.get("localBaseUrl") or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def absolute_download_url(value: str, *, base_url: str = "") -> str:
    raw = str(value or "").strip()
    base = str(base_url or "").rstrip("/")
    if raw.startswith("/api/download?"):
        return f"{base}{raw}" if base else raw
    if raw.startswith("http://") or raw.startswith("https://"):
        try:
            parsed = urlsplit(raw)
        except ValueError:
            return raw
        if parsed.path == "/api/download" and parsed.query:
            local_path = urlunsplit(("", "", parsed.path, parsed.query, ""))
            return f"{base}{local_path}" if base else local_path
    return raw


def absolutize_pptx_links(content: str, *, base_url: str = "") -> str:
    if not base_url:
        return str(content or "")

    def replace(match: re.Match[str]) -> str:
        return absolute_download_url(match.group(0), base_url=base_url)

    return re.sub(
        r"(?:https?://[^)\s]+)?/api/download\?[^)\s#]*\bid=[0-9a-f]{32}",
        replace,
        str(content or ""),
        flags=re.IGNORECASE,
    )


def remove_pptx_refusal_lines(content: str) -> str:
    lines = []
    for line in str(content or "").splitlines():
        if PRESENTATION_REFUSAL_RE.search(line):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def ensure_pptx_response(payload: dict[str, Any], content: str, body: dict[str, Any], *, strip_refusal: bool = True) -> tuple[str, bool]:
    base_url = pptx_download_base_url(payload)
    if not presentation_intent_requested(payload):
        return absolutize_pptx_links(content, base_url=base_url), False
    if response_has_pptx_link(content):
        return absolutize_pptx_links(content, base_url=base_url), False

    result = pptx_result_from_messages(body)
    created = False
    if result is None:
        try:
            result = create_presentation_from_text(latest_user_query(payload), content)
            created = True
        except AppError:
            return content, False

    base = remove_pptx_refusal_lines(content) if created and strip_refusal else str(content or "").strip()
    if not base:
        base = "已根据你的要求生成 PPT。"
    return f"{base.rstrip()}\n\n{pptx_link_text(result, base_url=base_url)}", created


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
        "tool_calls": tool_calls,
    }
    if "content" in assistant_message:
        content = assistant_message.get("content")
        assistant_payload["content"] = content if content is None or isinstance(content, str) else str(content)
    else:
        assistant_payload["content"] = ""
    # 必须回填上一轮的 reasoning_content，不能为了 prompt cache 省略它：
    # DeepSeek V4-Pro thinking 模式下，带 tool_calls 的 assistant 消息在后续请求里若缺少
    # reasoning_content，上游会直接报错 “The reasoning_content in the thinking mode must be
    # passed back to the API.”，整个带工具调用的回合会失败。这是该模式工具调用协议的必需部分。
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
    next_body = {**body, "messages": messages}
    if isinstance(next_body.get("tool_choice"), dict):
        next_body["tool_choice"] = "auto"
    return next_body


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
    # Preserve the upstream tool_call ids and argument JSON exactly for the
    # immediate tool-followup request. DeepSeek prompt cache can reuse the
    # prefix ending at the previous model output only when the assistant
    # tool_calls we send back match that output byte-for-byte in substance.
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
    response_json: dict[str, Any] = {}
    answer: dict[str, Any] = {}
    usage_totals: dict[str, Any] = {}
    local_final_content = ""
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
        usage_totals = merge_usage_totals(usage_totals, response_json.get("usage") or {})
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
        artifact = terminal_artifact_result_from_messages(body)
        if artifact:
            local_final_content = artifact_link_text(artifact[0], artifact[1], base_url=pptx_download_base_url(payload))
            answer = {"content": local_final_content}
            break
    usage = usage_totals or response_json.get("usage") or {}
    search_data = current_search_data()
    if local_final_content:
        final_content, fallback_created = local_final_content, False
    else:
        final_content, fallback_created = ensure_pptx_response(payload, str(answer.get("content") or ""), body)
    if fallback_created:
        tool_call_count += 1
        seen_tool_names.append("create_pptx")
    diagnostics = diagnostics_with_tools(prepared.diagnostics, count=tool_call_count, names=seen_tool_names)
    result = {
        "id": response_json.get("id"),
        "model": response_json.get("model", body["model"]),
        "content": final_content,
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
        local_final_content = ""
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
            round_usage: dict[str, Any] = {}
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
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if isinstance(chunk.get("usage"), dict):
                        round_usage = chunk["usage"]
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
            usage = merge_usage_totals(usage, round_usage)
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
            artifact = terminal_artifact_result_from_messages(body)
            if artifact:
                emit_checked({"type": "system_note", "text": "本地文件已生成，正在返回下载链接。\n\n"})
                local_final_content = artifact_link_text(artifact[0], artifact[1], base_url=pptx_download_base_url(payload))
                delta = f"\n\n{local_final_content}" if content.strip() else local_final_content
                content += delta
                emit_checked({"type": "content", "text": delta})
                break
            emit_checked({"type": "system_note", "text": "本地工具调用完成，继续生成回答。\n\n"})

        raise_if_cancelled(cancel_event)
        search_data = current_search_data()
        search_for_response = search_for_client(search_data) if search_data else search_for_response
        if local_final_content:
            final_content, fallback_created = content, False
        else:
            final_content, fallback_created = ensure_pptx_response(payload, content, body, strip_refusal=False)
        if final_content != content:
            delta = final_content[len(content) :] if final_content.startswith(content) else f"\n\n{final_content}"
            content = final_content
            emit_checked({"type": "content", "text": delta})
        if fallback_created:
            tool_call_count += 1
            seen_tool_names.append("create_pptx")
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
