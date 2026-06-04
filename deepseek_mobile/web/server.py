"""HTTP routes, local auth enforcement, static serving, and API response handling."""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
from inspect import signature
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from types import ModuleType
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit, urlunsplit

from deepseek_mobile.core.config import (
    APP_VERSION,
    DEFAULT_HOST,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MODEL_ROUTES,
    STATIC_DIR,
    SUPPORTED_MODELS,
    TAVILY_API_KEY,
    settings,
)
from deepseek_mobile.services.context_compressor import compress_context_payload
from deepseek_mobile.services.deepseek_client import RequestCancelled, call_deepseek, preflight_deepseek_payload, stream_deepseek
from deepseek_mobile.services.agent_runs import (
    TERMINAL_STATUSES,
    continue_with_plan,
    create_run as create_agent_run,
    events_after as agent_run_events_after,
    load_run as load_agent_run,
    merge_runtime_payload,
    public_run as public_agent_run,
    registry as agent_run_registry,
    rerun_agent,
    start_planned_run,
)
from deepseek_mobile.services.multi_agent import stream_multi_agent
from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services.files import (
    cached_file_source,
    cleanup_file_cache,
    extract_uploaded_file,
    file_page_image,
    file_page_layout,
    file_page_search,
    file_page_text,
    file_reader_window,
    load_cached_file,
)
from deepseek_mobile.services.memory import (
    clear_memories,
    delete_memories_by_query,
    delete_memory_by_id,
    detect_memory_conflicts,
    load_memories,
    normalize_memory_category,
    normalize_memory_scope,
    upsert_memory,
)
from deepseek_mobile.services.generated_files import download_descriptor, resolve_generated_file, save_generated_file_to_downloads
from deepseek_mobile.services.projects import add_project_files, create_project, delete_project, list_projects
from deepseek_mobile.services.reminders import create_reminder, delete_reminder, due_reminders, load_reminders
from deepseek_mobile.services.title_generator import generate_title_payload
from deepseek_mobile.services.tools import fetch_url
from deepseek_mobile.core.utils import clean_filename, local_ip, url_with_token

logger = logging.getLogger("deepseek_mobile.server")

RouteHandler = Callable[[], None]
AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
MAX_MULTIPART_FIELD_BYTES = 4_096
MAX_MULTIPART_FILES = 8
MAX_MULTIPART_PARTS = MAX_MULTIPART_FILES + 4
MULTIPART_MEMORY_LIMIT = 4 * 1024 * 1024
MULTIPART_SPOOL_LIMIT = 1024 * 1024
MULTIPART_IMPORT_ERROR = "Multipart parser dependency is not installed or is shadowed by an incompatible package. Run pip install -r requirements.txt."
SHARE_TARGET_TTL_SECONDS = 30 * 60
MAX_SHARE_FIELD_CHARS = 12_000
_SHARE_TARGET_LOCK = threading.RLock()
_SHARE_TARGETS: dict[str, tuple[float, dict[str, Any]]] = {}
GET_ROUTES: dict[str, str] = {
    "/api/config": "handle_config",
    "/api/memory": "handle_memory_list",
    "/api/share-target": "handle_share_target",
    "/api/download": "handle_download",
    "/api/file-page-image": "handle_file_page_image",
    "/api/file-page-layout": "handle_file_page_layout",
    "/api/file-page-search": "handle_file_page_search",
    "/api/file-source": "handle_file_source",
}
POST_ROUTES: dict[str, tuple[str, str]] = {
    "/share-target": ("Share target error", "handle_share_target_post"),
    "/api/auth/logout": ("Auth error", "handle_auth_logout"),
    "/api/conversations/search": ("Conversation search error", "handle_conversation_search"),
    "/api/download-save": ("Download error", "handle_download_save"),
    "/api/file-text": ("File parse error", "handle_file_text"),
    "/api/file-chunk": ("File chunk error", "handle_file_chunk"),
    "/api/file-page-text": ("File page text error", "handle_file_page_text"),
    "/api/file-reader": ("File reader error", "handle_file_reader"),
    "/api/fetch-url": ("URL fetch error", "handle_fetch_url"),
    "/api/project-files": ("Project file parse error", "handle_project_file_text"),
    "/api/compress-context": ("Context compress error", "handle_context_compress"),
    "/api/title": ("Title generation error", "handle_title"),
    "/api/memory": ("Memory error", "handle_memory"),
    "/api/projects": ("Project error", "handle_projects"),
    "/api/reminders": ("Reminder error", "handle_reminders"),
    "/api/reminders/due": ("Reminder error", "handle_due_reminders"),
    "/api/chat": ("Server error", "handle_chat"),
}


def multipart_module_issue(candidate: Any) -> str | None:
    parse_options_header = getattr(candidate, "parse_options_header", None)
    parser = getattr(candidate, "MultipartParser", None)
    if not callable(parse_options_header) or not callable(parser):
        missing = [
            name
            for name, value in (("parse_options_header", parse_options_header), ("MultipartParser", parser))
            if not callable(value)
        ]
        return f"incompatible multipart module missing callable {', '.join(missing)}"
    try:
        parameters = signature(parser).parameters
    except (TypeError, ValueError):
        return "MultipartParser signature could not be inspected"
    required = {
        "content_length",
        "strict",
        "header_limit",
        "headersize_limit",
        "part_limit",
        "partsize_limit",
        "spool_limit",
        "memory_limit",
        "disk_limit",
    }
    missing_parameters = sorted(required.difference(parameters))
    if missing_parameters:
        return f"MultipartParser missing parameters: {', '.join(missing_parameters)}"
    return None


def supported_multipart_module(candidate: Any) -> bool:
    return multipart_module_issue(candidate) is None


def load_multipart_module() -> ModuleType | None:
    try:
        import multipart as candidate
    except ModuleNotFoundError:  # pragma: no cover - exercised only before installing requirements
        logger.warning("multipart_dependency_missing")
        return None
    issue = multipart_module_issue(candidate)
    if issue:
        logger.warning("multipart_dependency_incompatible", extra={"detail": issue})
        return None
    return candidate


multipart_module = load_multipart_module()


class DeepSeekMobileHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".css": "text/css",
        ".ico": "image/x-icon",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
        ".woff2": "font/woff2",
    }
    server_version = f"DeepSeekMobile/{APP_VERSION}"

    def translate_path(self, path: str) -> str:
        parsed = urlsplit(path)
        raw_path = unquote(parsed.path)
        if raw_path == "/" or raw_path == "":
            return str(STATIC_DIR / "index.html")
        parts = [part for part in raw_path.split("/") if part and part not in {".", ".."}]
        static_root = STATIC_DIR.resolve()
        candidate = (static_root / Path(*parts)).resolve()
        try:
            candidate.relative_to(static_root)
        except ValueError:
            return str(static_root / "__blocked__")
        return str(candidate)

    def end_headers(self) -> None:
        path = urlsplit(getattr(self, "path", "")).path
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if path == "/api/file-source":
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; "
                "font-src 'self'; "
                "connect-src 'self'; "
                "object-src 'self'; "
                "base-uri 'self'; "
                "frame-ancestors 'self'",
            )
            self.send_header("X-Frame-Options", "SAMEORIGIN")
        else:
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: http: https:; "
                "font-src 'self'; "
                "connect-src 'self'; "
                "object-src 'none'; "
                "base-uri 'self'; "
                "frame-ancestors 'none'",
            )
            self.send_header("X-Frame-Options", "DENY")
        cache_control = "no-store" if path.startswith("/api/") else "no-cache"
        self.send_header("Cache-Control", cache_control)
        super().end_headers()

    def list_directory(self, path: Any) -> Any:
        self.send_error(404, "Not found")
        return None

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        allowed_origin = allowed_cors_origin(self.headers.get("Origin", ""), server_port(self.server.server_address))
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        if self.handle_auth_token_redirect():
            return

        path = urlsplit(self.path).path
        if path.startswith("/api/agent-runs/"):
            try:
                self.require_api_auth()
                self.handle_agent_run_get(path)
            except AppError as exc:
                self.write_json(exc.to_response(), status=exc.status)
            except Exception:
                logger.exception("agent_run_get_error", extra={"path": self.path})
                self.write_json({"error": "Server error", "code": ErrorCode.INTERNAL.value}, status=500)
            return
        route_name = GET_ROUTES.get(path)
        if route_name:
            try:
                self.require_api_auth()
                getattr(self, route_name)()
            except AppError as exc:
                self.write_json(exc.to_response(), status=exc.status)
            except Exception:
                logger.exception("get_route_error", extra={"path": self.path})
                self.write_json({"error": "Server error", "code": ErrorCode.INTERNAL.value}, status=500)
            return
        return super().do_GET()

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/"):
                self.require_api_auth()
            elif path == "/share-target":
                self.require_allowed_host()
        except AppError as exc:
            self.write_json(exc.to_response(), status=exc.status)
            return

        if path == "/api/agent-runs" or path.startswith("/api/agent-runs/"):
            try:
                self.handle_agent_run_post(path)
            except AppError as exc:
                self.write_json(exc.to_response(), status=exc.status)
            except Exception:
                logger.exception("agent_run_post_error", extra={"path": self.path})
                self.write_json({"error": "Agent run error", "code": ErrorCode.INTERNAL.value}, status=500)
            return

        route = POST_ROUTES.get(path)
        if route is None:
            self.write_json({"error": "Not found", "code": ErrorCode.NOT_FOUND.value}, status=404)
            return
        public_error, route_name = route
        try:
            getattr(self, route_name)()
        except AppError as exc:
            self.write_json(exc.to_response(), status=exc.status)
        except Exception:
            logger.exception("post_route_error", extra={"path": self.path})
            self.write_json({"error": public_error, "code": ErrorCode.INTERNAL.value}, status=500)

    def handle_config(self) -> None:
        port = server_port(self.server.server_address)
        computer_url = f"http://127.0.0.1:{port}"
        phone_url = f"http://{local_ip()}:{port}"
        if settings.auth.enabled:
            computer_url = url_with_token(computer_url + "/", settings.auth.token)
            phone_url = url_with_token(phone_url + "/", settings.auth.token)
        self.write_json(
            {
                "version": APP_VERSION,
                "hasServerKey": bool(settings.deepseek_api_key),
                "hasSearch": bool(TAVILY_API_KEY),
                "defaultModel": settings.default_model,
                "models": list(SUPPORTED_MODELS),
                "modelRoutes": dict(MODEL_ROUTES),
                "searchModes": ["off", "auto", "on"],
                "uploadLimits": {
                    "fileMaxBytes": MAX_UPLOAD_FILE_BYTES,
                    "requestMaxBytes": MAX_UPLOAD_BYTES,
                    "maxFiles": MAX_MULTIPART_FILES,
                },
                "ocr": {
                    "enabled": settings.ocr.enabled,
                    "mode": settings.ocr.mode,
                    "localOnly": False,
                },
                "computerUrl": computer_url,
                "phoneUrl": phone_url,
            }
        )

    def handle_auth_token_redirect(self) -> bool:
        parsed = urlsplit(self.path)
        if parsed.path not in {"", "/"} or not settings.auth.enabled:
            return False

        query = parse_qs(parsed.query, keep_blank_values=True)
        token = query.get("token", [""])[0]
        if not token:
            return False
        if not secrets.compare_digest(token, settings.auth.token):
            self.write_json(AppError("Auth required", code=ErrorCode.UNAUTHORIZED, status=401).to_response(), status=401)
            return True

        if query.get("desktop", [""])[0] in {"1", "true", "yes"}:
            self.write_authenticated_index()
            return True

        self.send_response(302)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", auth_cookie_header(settings.auth.token))
        self.end_headers()
        return True

    def write_authenticated_index(self) -> None:
        try:
            body = (STATIC_DIR / "index.html").read_bytes()
        except OSError:
            self.write_json({"error": "Not found", "code": ErrorCode.NOT_FOUND.value}, status=404)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", auth_cookie_header(settings.auth.token))
        self.end_headers()
        self.wfile.write(body)

    def handle_auth_logout(self) -> None:
        body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", expired_auth_cookie_header())
        self.end_headers()
        self.wfile.write(body)

    def require_api_auth(self) -> None:
        if not settings.auth.enabled:
            return

        self.require_allowed_host()
        provided = auth_token_from_headers(self.headers.get("Authorization", ""), self.headers.get("Cookie", ""))
        if not secrets.compare_digest(provided, settings.auth.token):
            raise AppError("Auth required", code=ErrorCode.UNAUTHORIZED, status=401)

    def require_allowed_host(self) -> None:
        host = host_without_port(self.headers.get("Host", ""))
        if host not in allowed_auth_hosts():
            raise AppError("Host not allowed", code=ErrorCode.FORBIDDEN, status=403)

    def handle_memory_list(self) -> None:
        self.write_json({"memories": load_memories()})

    def handle_download(self) -> None:
        # serve 由 create_pptx / create_document / create_mindmap 工具生成的 .pptx / .docx / .pdf / .svg。已过 require_api_auth
        # （GET_ROUTES 分支统一鉴权）；id 经 resolve_generated_file 校验为 32 位十六进制，杜绝路径遍历；
        # MIME 与下载文件名按实际文件后缀派生。
        query = parse_qs(urlsplit(self.path).query)
        file_id = query.get("id", [""])[0]
        path = resolve_generated_file(file_id)
        if path is None:
            raise AppError("文件不存在或已过期", code=ErrorCode.NOT_FOUND, status=404)
        data = path.read_bytes()
        media_type, download_name = download_descriptor(path)
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        disposition = "inline" if path.suffix.lower() == ".svg" and str(query.get("inline", [""])[0]).lower() in {"1", "true"} else "attachment"
        self.send_header("Content-Disposition", f'{disposition}; filename="{download_name}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_file_source(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        file_id = query.get("fileId", [""])[0]
        project_id = query.get("projectId", [""])[0] or None
        cached, path = cached_file_source(file_id, project_id=project_id)
        data = path.read_bytes()
        media_type = original_file_media_type(cached)
        filename = clean_filename(str(cached.get("name") or "document"))
        disposition = "attachment" if str(query.get("download", [""])[0]).lower() in {"1", "true"} else "inline"
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Disposition", content_disposition_header(disposition, filename))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_file_page_image(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        file_id = query.get("fileId", [""])[0]
        project_id = query.get("projectId", [""])[0] or None
        page = query.get("page", ["1"])[0]
        scale = query.get("scale", [""])[0]
        cached, data, rendered_page, page_count = file_page_image(file_id, project_id=project_id, page=page, scale=scale)
        filename = clean_filename(str(cached.get("name") or "document"))
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("X-File-Page", str(rendered_page))
        self.send_header("X-File-Page-Count", str(page_count))
        self.send_header("Content-Disposition", content_disposition_header("inline", f"{Path(filename).stem or 'document'}-page-{rendered_page}.png"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_file_page_layout(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        self.write_json(
            file_page_layout(
                query.get("fileId", [""])[0],
                project_id=query.get("projectId", [""])[0] or None,
                page=query.get("page", ["1"])[0],
            )
        )

    def handle_file_page_search(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        self.write_json(
            file_page_search(
                query.get("fileId", [""])[0],
                project_id=query.get("projectId", [""])[0] or None,
                query=query.get("query", [""])[0],
            )
        )

    def handle_download_save(self) -> None:
        payload = self.read_json_body()
        result = save_generated_file_to_downloads(str(payload.get("id") or ""), filename=str(payload.get("filename") or ""))
        self.write_json(result)

    def handle_chat(self) -> None:
        # 视觉对话会把图片 base64 放进消息体，放宽到 16 MB（普通文本对话远小于此上限）
        payload = self.read_json_body(max_bytes=16_000_000)
        payload = {**payload, "localBaseUrl": request_base_url(self)}
        if payload.get("stream"):
            preflight_deepseek_payload(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            cancel_event = threading.Event()

            def write_stream_event(data: dict[str, Any]) -> None:
                if cancel_event.is_set():
                    raise RequestCancelled()
                try:
                    self.write_stream_event(data)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    cancel_event.set()
                    raise RequestCancelled()

            try:
                if payload.get("agentMode") is True:
                    stream_multi_agent(payload, write_stream_event, cancel_event=cancel_event)
                else:
                    stream_deepseek(payload, write_stream_event, cancel_event=cancel_event)
            except RequestCancelled:
                return
            finally:
                cancel_event.set()
                self.close_connection = True
            return
        self.write_json(call_deepseek(payload))

    def handle_agent_run_post(self, path: str) -> None:
        if path == "/api/agent-runs":
            body = self.read_json_body()
            payload = body.get("payload")
            if not isinstance(payload, dict):
                raise AppError("payload must be an object", code=ErrorCode.INVALID_PAYLOAD)
            payload["agentMode"] = True
            preflight_deepseek_payload(payload)
            confirm_plan = bool(body.get("confirmPlan"))
            agent_preset = str(body.get("agentPreset") or "full")
            run = create_agent_run(
                payload,
                confirm_plan=confirm_plan,
                agent_preset=agent_preset,
                conversation_id=str(body.get("conversationId") or ""),
                message_id=str(body.get("messageId") or ""),
            )
            agent_run_registry.ensure_started(run["runId"], start_planned_run, run["runId"], payload, confirm_plan=confirm_plan, agent_preset=agent_preset)
            self.write_json({"ok": True, "runId": run["runId"], "run": run}, status=201)
            return

        run_id, action = parse_agent_run_action(path)
        body = self.read_json_body()
        stored = load_agent_run(run_id)
        stored_payload = stored.get("requestPayload")
        runtime_payload = merge_runtime_payload(stored_payload if isinstance(stored_payload, dict) else {}, body.get("payload"))
        runtime_payload["agentMode"] = True
        preflight_deepseek_payload(runtime_payload)
        if action == "plan":
            if str(stored.get("status") or "") != "awaiting_plan":
                raise AppError("Agent run is not awaiting plan confirmation", code=ErrorCode.INVALID_PAYLOAD, status=409)
            plan = body.get("plan")
            if plan is not None and not isinstance(plan, list):
                raise AppError("plan must be a list", code=ErrorCode.INVALID_PAYLOAD)
            started = agent_run_registry.ensure_started(run_id, continue_with_plan, run_id, runtime_payload, plan)
            self.write_json({"ok": True, "started": started, "run": public_agent_run(load_agent_run(run_id))})
            return
        if action == "rerun":
            status = str(stored.get("status") or "")
            if status in {"created", "planning", "running"}:
                raise AppError("Agent run is still running", code=ErrorCode.INVALID_PAYLOAD, status=409)
            agent_id = str(body.get("agentId") or "").strip()
            if not agent_id:
                raise AppError("agentId is required", code=ErrorCode.INVALID_PAYLOAD)
            started = agent_run_registry.ensure_started(
                run_id,
                rerun_agent,
                run_id,
                runtime_payload,
                agent_id=agent_id,
                resynthesize=body.get("resynthesize") is not False,
            )
            self.write_json({"ok": True, "started": started, "run": public_agent_run(load_agent_run(run_id))})
            return
        raise AppError("Unsupported Agent run action", code=ErrorCode.NOT_FOUND, status=404)

    def handle_agent_run_get(self, path: str) -> None:
        run_id, action = parse_agent_run_action(path)
        query = parse_qs(urlsplit(self.path).query)
        after = parse_event_cursor(query.get("after", ["-1"])[0])
        if action == "":
            self.write_json({"ok": True, "run": public_agent_run(load_agent_run(run_id))})
            return
        if action == "events":
            self.write_json({"ok": True, "events": agent_run_events_after(run_id, after)})
            return
        if action == "stream":
            self.stream_agent_run(run_id, after)
            return
        raise AppError("Unsupported Agent run action", code=ErrorCode.NOT_FOUND, status=404)

    def stream_agent_run(self, run_id: str, after: int) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        cursor = after
        try:
            while True:
                events = agent_run_events_after(run_id, cursor)
                for event in events:
                    self.write_stream_event(event)
                    cursor = max(cursor, int(event.get("index", cursor)))
                run = load_agent_run(run_id)
                status = str(run.get("status") or "")
                if status in {*TERMINAL_STATUSES, "awaiting_plan"} and int(run.get("nextIndex") or 0) - 1 <= cursor:
                    break
                agent_run_registry.wait_for_event(run_id)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        finally:
            self.close_connection = True

    def read_json_body(self, max_bytes: int = 2_000_000) -> dict[str, Any]:
        content_length = parse_content_length(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise AppError("Request body is empty", code=ErrorCode.INVALID_PAYLOAD)
        if content_length > max_bytes:
            raise AppError("Request body is too large", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
        raw = self.rfile.read(content_length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise AppError(f"Invalid JSON: {exc}", code=ErrorCode.INVALID_PAYLOAD) from exc
        if not isinstance(body, dict):
            raise AppError("Request body must be a JSON object", code=ErrorCode.INVALID_PAYLOAD)
        return body

    def handle_file_text(self) -> None:
        files, ocr_enabled, ocr_api_key = self.read_multipart_files()
        if not files:
            raise AppError("No file uploaded", code=ErrorCode.INVALID_PAYLOAD)
        extracted_files = []
        errors = []
        for file_info in files:
            try:
                extracted_files.append(
                    extract_uploaded_file(
                        file_info["filename"],
                        file_info["content_type"],
                        file_info["data"],
                        ocr_enabled=ocr_enabled,
                        ocr_api_key=ocr_api_key,
                    )
                )
            except AppError as exc:
                errors.append({"name": file_info["filename"], "error": str(exc), "code": exc.code.value, "status": exc.status})
        if not extracted_files and errors:
            error_code = ErrorCode(str(errors[0].get("code") or ErrorCode.INVALID_PAYLOAD.value))
            raise AppError(errors[0]["error"], code=error_code, status=int(errors[0].get("status") or 400))
        cleanup_file_cache()
        self.write_json({"files": extracted_files, "errors": errors, "file": extracted_files[0] if extracted_files else None})

    def handle_project_file_text(self) -> None:
        project_id = parse_qs(urlsplit(self.path).query).get("projectId", [""])[0]
        files, ocr_enabled, ocr_api_key = self.read_multipart_files()
        if not files:
            raise AppError("No file uploaded", code=ErrorCode.INVALID_PAYLOAD)
        documents = add_project_files(project_id, files, ocr_enabled=ocr_enabled, ocr_api_key=ocr_api_key)
        self.write_json({"ok": True, "documents": documents})

    def handle_file_chunk(self) -> None:
        payload = self.read_json_body()
        file_id = str(payload.get("fileId") or "")
        project_id = str(payload.get("projectId") or "") or None
        try:
            chunk_index = max(0, int(payload.get("chunkIndex") or 0) - 1)
        except (TypeError, ValueError) as exc:
            raise AppError("Invalid chunk index", code=ErrorCode.INVALID_PAYLOAD, status=400) from exc
        cached = load_cached_file(file_id, project_id=project_id)
        raw_chunks = cached.get("chunks")
        chunks: list[Any] = raw_chunks if isinstance(raw_chunks, list) else []
        if chunk_index >= len(chunks):
            raise AppError("Chunk not found", code=ErrorCode.NOT_FOUND, status=404)
        chunk = chunks[chunk_index]
        if not isinstance(chunk, dict):
            raise AppError("Chunk not found", code=ErrorCode.NOT_FOUND, status=404)
        self.write_json(
            {
                "file": {
                    "name": cached.get("name"),
                    "kind": cached.get("kind"),
                    "fileId": file_id,
                    "projectId": project_id or "",
                },
                "chunk": chunk,
            }
        )

    def handle_file_reader(self) -> None:
        payload = self.read_json_body()
        self.write_json(
            file_reader_window(
                str(payload.get("fileId") or ""),
                project_id=str(payload.get("projectId") or "") or None,
                chunk_start=payload.get("chunkStart") or 1,
                chunk_count=payload.get("chunkCount") or 6,
            )
        )

    def handle_file_page_text(self) -> None:
        payload = self.read_json_body()
        self.write_json(
            file_page_text(
                str(payload.get("fileId") or ""),
                project_id=str(payload.get("projectId") or "") or None,
                page=payload.get("page") or 1,
            )
        )

    def handle_fetch_url(self) -> None:
        payload = self.read_json_body()
        self.write_json({"ok": True, "page": fetch_url(str(payload.get("url") or ""))})

    def handle_share_target(self) -> None:
        share_id = parse_qs(urlsplit(self.path).query).get("id", [""])[0]
        payload = pop_share_target_payload(share_id)
        if payload is None:
            raise AppError("Shared content expired", code=ErrorCode.NOT_FOUND, status=404)
        self.write_json({"ok": True, "share": payload})

    def handle_share_target_post(self) -> None:
        fields, files = self.read_multipart_form()
        prompt = share_target_prompt(
            title=first_form_value(fields, "title"),
            text=first_form_value(fields, "text"),
            url=first_form_value(fields, "url"),
        )
        attachments = []
        errors = []
        for file_info in files:
            try:
                attachments.append(
                    extract_uploaded_file(
                        file_info["filename"],
                        file_info["content_type"],
                        file_info["data"],
                        ocr_enabled=settings.ocr.enabled,
                        ocr_api_key=first_form_value(fields, "apiKey"),
                    )
                )
            except AppError as exc:
                errors.append({"name": file_info["filename"], "error": str(exc), "code": exc.code.value, "status": exc.status})
        if not prompt and not attachments and errors:
            prompt = "Please process this shared file. Some files could not be extracted; the import errors are attached."
        payload = {"prompt": prompt, "attachments": attachments, "errors": errors}
        share_id = store_share_target_payload(payload)
        location = "/?" + urlencode({"share": share_id})
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def handle_context_compress(self) -> None:
        self.write_json(compress_context_payload(self.read_json_body()))

    def handle_title(self) -> None:
        self.write_json(generate_title_payload(self.read_json_body()))

    def handle_memory(self) -> None:
        payload = self.read_json_body()
        action = str(payload.get("action") or "list").strip().lower()
        if action == "list":
            self.write_json({"memories": load_memories()})
            return
        if action == "clear":
            count = clear_memories()
            self.write_json({"ok": True, "deleted": count})
            return
        if action == "add":
            content = str(payload.get("content") or "").strip()
            category = normalize_memory_category(payload.get("category"), content)
            scope = normalize_memory_scope(payload.get("scope") or "global")
            pinned = bool(payload.get("pinned"))
            replace_ids = payload.get("replaceIds")
            replace_id_list = [str(item) for item in replace_ids] if isinstance(replace_ids, list) else []
            conflicts = detect_memory_conflicts(content, category=category, scope=scope)
            unresolved_conflicts = [item for item in conflicts if str(item.get("id") or "") not in set(replace_id_list)]
            if unresolved_conflicts:
                self.write_json(
                    {
                        "error": "Memory conflicts with an existing item",
                        "code": ErrorCode.MEMORY_CONFLICT.value,
                        "conflicts": unresolved_conflicts,
                    },
                    status=409,
                )
                return
            item = upsert_memory(content, category=category, scope=scope, source="manual", pinned=pinned, replace_ids=replace_id_list)
            self.write_json({"ok": True, "memory": item})
            return
        if action == "delete":
            query = str(payload.get("query") or "").strip()
            scope = normalize_memory_scope(payload.get("scope") or "global")
            scopes = ["global", scope] if scope != "global" else ["global"]
            self.write_json({"ok": True, "deleted": delete_memories_by_query(query, scopes=scopes)})
            return
        if action == "deletebyid":
            memory_id = str(payload.get("id") or "").strip()
            self.write_json({"ok": True, "deleted": delete_memory_by_id(memory_id)})
            return
        raise AppError("Unsupported memory action", code=ErrorCode.INVALID_PAYLOAD)

    def handle_projects(self) -> None:
        payload = self.read_json_body()
        action = str(payload.get("action") or "list").strip().lower()
        if action == "list":
            self.write_json({"projects": list_projects()})
            return
        if action == "create":
            self.write_json({"ok": True, "project": create_project(str(payload.get("name") or ""))})
            return
        if action == "delete":
            self.write_json({"ok": True, "deleted": delete_project(str(payload.get("id") or ""))})
            return
        raise AppError("Unsupported project action", code=ErrorCode.INVALID_PAYLOAD)

    def handle_reminders(self) -> None:
        payload = self.read_json_body()
        action = str(payload.get("action") or "list").strip().lower()
        if action == "list":
            self.write_json({"reminders": load_reminders()})
            return
        if action == "create":
            self.write_json({"ok": True, "reminder": create_reminder(payload)})
            return
        if action == "delete":
            self.write_json({"ok": True, "deleted": delete_reminder(str(payload.get("id") or ""))})
            return
        raise AppError("Unsupported reminder action", code=ErrorCode.INVALID_PAYLOAD)

    def handle_due_reminders(self) -> None:
        self.read_json_body()
        self.write_json({"reminders": due_reminders()})

    def handle_conversation_search(self) -> None:
        payload = self.read_json_body()
        query = str(payload.get("query") or "").strip().lower()
        conversations = payload.get("conversations")
        if not query:
            self.write_json({"results": []})
            return
        if not isinstance(conversations, list):
            raise AppError("conversations must be a list", code=ErrorCode.INVALID_PAYLOAD)

        results: list[dict[str, Any]] = []
        for conversation in conversations[:200]:
            if not isinstance(conversation, dict):
                continue
            matches = conversation_search_matches(conversation, query)
            if matches:
                results.append(
                    {
                        "id": str(conversation.get("id") or ""),
                        "title": str(conversation.get("title") or "新对话")[:160],
                        "updatedAt": conversation.get("updatedAt"),
                        "favorite": bool(conversation.get("favorite")),
                        "tags": conversation_tags(conversation),
                        "matches": matches[:5],
                    }
                )
        self.write_json({"results": results[:50]})

    def read_multipart_files(self) -> tuple[list[dict[str, Any]], bool, str]:
        fields, uploads = self.read_multipart_form()
        ocr_enabled = settings.ocr.enabled
        for value in fields.get("ocrEnabled", []):
            ocr_enabled = str(value).strip().lower() in {"1", "true", "yes", "on"}
        return uploads, ocr_enabled, first_form_value(fields, "apiKey")

    def read_multipart_form(self) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise AppError("Expected multipart/form-data", code=ErrorCode.INVALID_PAYLOAD)
        content_length = parse_content_length(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise AppError("Upload body is empty", code=ErrorCode.INVALID_PAYLOAD)
        if content_length > MAX_UPLOAD_BYTES:
            raise AppError(
                f"Upload body is too large. Maximum request size is {format_upload_limit(MAX_UPLOAD_BYTES)}.",
                code=ErrorCode.UPLOAD_TOO_LARGE,
                status=413,
            )
        if multipart_module is None or not supported_multipart_module(multipart_module):
            if multipart_module is not None:
                logger.warning("multipart_dependency_incompatible", extra={"detail": multipart_module_issue(multipart_module)})
            raise AppError(MULTIPART_IMPORT_ERROR, code=ErrorCode.INTERNAL, status=500)

        media_type, options = multipart_module.parse_options_header(content_type)
        boundary = options.get("boundary", "")
        if media_type != "multipart/form-data" or not boundary:
            raise AppError("Upload body is not multipart/form-data", code=ErrorCode.INVALID_PAYLOAD)

        uploads: list[dict[str, Any]] = []
        parser = multipart_module.MultipartParser(
            self.rfile,
            boundary,
            content_length=content_length,
            strict=True,
            header_limit=8,
            headersize_limit=4_096,
            part_limit=MAX_MULTIPART_PARTS,
            partsize_limit=MAX_UPLOAD_FILE_BYTES,
            spool_limit=MULTIPART_SPOOL_LIMIT,
            memory_limit=MULTIPART_MEMORY_LIMIT,
            disk_limit=MAX_UPLOAD_BYTES,
        )
        fields: dict[str, list[str]] = {}
        try:
            for part in parser:
                try:
                    if part.filename:
                        if len(uploads) >= MAX_MULTIPART_FILES:
                            raise AppError("Too many uploaded files", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
                        filename = clean_filename(part.filename or "")
                        if filename:
                            part_size = max(int(part.size or 0), len(part.raw or b""))
                            if part_size > MAX_UPLOAD_FILE_BYTES:
                                raise AppError(
                                    f"File is too large. Maximum file size is {format_upload_limit(MAX_UPLOAD_FILE_BYTES)}.",
                                    code=ErrorCode.UPLOAD_TOO_LARGE,
                                    status=413,
                                )
                            uploads.append(
                                {
                                    "filename": filename,
                                    "content_type": part.content_type or "application/octet-stream",
                                    "data": part.raw,
                                }
                            )
                        continue
                    if part.size > MAX_MULTIPART_FIELD_BYTES:
                        raise AppError("Upload field is too large", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
                    name = str(part.name or "").strip()
                    if name:
                        fields.setdefault(name, []).append(str(part.value or "")[:MAX_SHARE_FIELD_CHARS])
                finally:
                    part.close()
        except AppError:
            raise
        except Exception as exc:
            translated = translate_multipart_error(exc)
            if translated is None:
                raise
            raise translated from exc
        return fields, uploads

    def write_stream_event(self, data: dict[str, Any]) -> None:
        line = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        self.wfile.write(line)
        self.wfile.flush()

    def write_json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        logger.info("http_request", extra={"client": self.address_string(), "request": redact_sensitive_query(format % args)})


def create_server(start_port: int, host: str | None = None) -> tuple[ThreadingHTTPServer, int]:
    bind_host = host if host is not None else DEFAULT_HOST
    for port in range(start_port, start_port + 20):
        try:
            return ThreadingHTTPServer((bind_host, port), DeepSeekMobileHandler), port
        except OSError:
            continue
    raise SystemExit(f"No available port found from {start_port} to {start_port + 19}")


def server_port(server_address: Any) -> int:
    if isinstance(server_address, tuple) and len(server_address) >= 2:
        try:
            return int(server_address[1])
        except (TypeError, ValueError):
            pass
    return 0


def parse_content_length(value: str) -> int:
    try:
        content_length = int(value)
    except (TypeError, ValueError) as exc:
        raise AppError("Invalid Content-Length", code=ErrorCode.INVALID_PAYLOAD) from exc
    if content_length < 0:
        raise AppError("Invalid Content-Length", code=ErrorCode.INVALID_PAYLOAD)
    return content_length


def parse_agent_run_action(path: str) -> tuple[str, str]:
    parts = [part for part in path.split("/") if part]
    if len(parts) < 3 or parts[0] != "api" or parts[1] != "agent-runs":
        raise AppError("Agent run not found", code=ErrorCode.NOT_FOUND, status=404)
    run_id = parts[2]
    action = parts[3] if len(parts) > 3 else ""
    if len(parts) > 4:
        raise AppError("Agent run not found", code=ErrorCode.NOT_FOUND, status=404)
    return run_id, action


def parse_event_cursor(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def format_upload_limit(value: int) -> str:
    return f"{max(1, round(value / 1_000_000))} MB"


def first_form_value(fields: dict[str, list[str]], name: str) -> str:
    values = fields.get(name) or []
    return str(values[0] if values else "").strip()[:MAX_SHARE_FIELD_CHARS]


def share_target_prompt(*, title: str, text: str, url: str) -> str:
    parts = []
    if title:
        parts.append(f"Title: {title}")
    if url:
        parts.append(f"URL: {url}")
    if text:
        parts.append(text)
    if not parts:
        return ""
    return "Please help me process this shared content:\n\n" + "\n\n".join(parts)


def cleanup_share_target_payloads(now: float | None = None) -> None:
    cutoff = (now if now is not None else time.time()) - SHARE_TARGET_TTL_SECONDS
    expired = [share_id for share_id, (created_at, _) in _SHARE_TARGETS.items() if created_at < cutoff]
    for share_id in expired:
        _SHARE_TARGETS.pop(share_id, None)


def store_share_target_payload(payload: dict[str, Any]) -> str:
    with _SHARE_TARGET_LOCK:
        cleanup_share_target_payloads()
        share_id = secrets.token_urlsafe(12)
        _SHARE_TARGETS[share_id] = (time.time(), payload)
        return share_id


def pop_share_target_payload(share_id: str) -> dict[str, Any] | None:
    value = str(share_id or "").strip()
    if not value:
        return None
    with _SHARE_TARGET_LOCK:
        cleanup_share_target_payloads()
        item = _SHARE_TARGETS.pop(value, None)
    return item[1] if item else None


def auth_cookie_header(token: str) -> str:
    cookie = SimpleCookie()
    cookie["auth_token"] = token
    cookie["auth_token"]["path"] = "/"
    cookie["auth_token"]["samesite"] = "Strict"
    cookie["auth_token"]["httponly"] = True
    cookie["auth_token"]["max-age"] = str(AUTH_COOKIE_MAX_AGE_SECONDS)
    return cookie.output(header="").strip()


def expired_auth_cookie_header() -> str:
    cookie = SimpleCookie()
    cookie["auth_token"] = ""
    cookie["auth_token"]["path"] = "/"
    cookie["auth_token"]["samesite"] = "Strict"
    cookie["auth_token"]["httponly"] = True
    cookie["auth_token"]["max-age"] = "0"
    return cookie.output(header="").strip()


def translate_multipart_error(exc: Exception) -> AppError | None:
    status = int(getattr(exc, "http_status", 0) or 0)
    if status == 0:
        return None
    code = ErrorCode.UPLOAD_TOO_LARGE if status == 413 else ErrorCode.INVALID_PAYLOAD
    message = str(exc) if status == 413 else "Invalid multipart upload"
    return AppError(message, code=code, status=status)


def conversation_tags(conversation: dict[str, Any]) -> list[str]:
    tags = conversation.get("tags")
    if not isinstance(tags, list):
        return []
    return [str(tag).strip()[:32] for tag in tags if str(tag or "").strip()][:12]


def conversation_search_matches(conversation: dict[str, Any], query: str) -> list[dict[str, Any]]:
    haystacks: list[tuple[str, str, str]] = [
        ("title", "", str(conversation.get("title") or "")),
        ("tag", "", " ".join(conversation_tags(conversation))),
    ]
    messages = conversation.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            haystacks.append(
                (
                    "message",
                    str(message.get("id") or ""),
                    f"{message.get('role') or ''} {message.get('content') or ''} {message.get('reasoning') or ''}",
                )
            )

    matches: list[dict[str, Any]] = []
    for kind, message_id, text in haystacks:
        value = str(text or "")
        index = value.lower().find(query)
        if index < 0:
            continue
        start = max(0, index - 48)
        end = min(len(value), index + len(query) + 96)
        matches.append({"kind": kind, "messageId": message_id, "snippet": value[start:end].strip()})
    return matches


def host_without_port(value: str) -> str:
    host = value.strip().split(",", 1)[0].strip()
    if host.startswith("["):
        return host.split("]", 1)[0].lstrip("[").lower()
    return host.split(":", 1)[0].lower()


def request_base_url(handler: DeepSeekMobileHandler) -> str:
    host_header = str(handler.headers.get("Host") or "").split(",", 1)[0].strip()
    if host_header and "/" not in host_header and "\\" not in host_header and host_without_port(host_header) in allowed_auth_hosts():
        return f"http://{host_header}"
    port = server_port(handler.server.server_address)
    return f"http://127.0.0.1:{port}" if port else "http://127.0.0.1"


def allowed_auth_hosts() -> set[str]:
    hosts = {"localhost", "127.0.0.1", "::1"}
    configured_host = settings.default_host.strip().lower()
    if configured_host and configured_host != "0.0.0.0":
        hosts.add(configured_host)
    lan_ip = local_ip()
    if lan_ip:
        hosts.add(lan_ip.lower())
    hosts.update(host_without_port(host) for host in settings.auth.allowed_hosts)
    return {host for host in hosts if host}


def allowed_cors_origin(origin: str, port: int) -> str:
    origin = origin.strip()
    if not origin or port <= 0:
        return ""
    try:
        parsed = urlsplit(origin)
        origin_port = parsed.port
    except ValueError:
        return ""
    if parsed.scheme != "http" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        return ""
    if origin_port is None:
        origin_port = 80
    if origin_port != port:
        return ""
    host = (parsed.hostname or "").lower()
    if host not in allowed_auth_hosts():
        return ""
    return origin


def original_file_media_type(cached: dict[str, Any]) -> str:
    kind = str(cached.get("kind") or "").lower()
    raw_type = str(cached.get("type") or "").split(";", 1)[0].strip().lower()
    if kind == "pdf" or raw_type == "application/pdf":
        return "application/pdf"
    if kind == "image" and raw_type.startswith("image/") and raw_type not in {"image/svg+xml"}:
        return raw_type
    if raw_type.startswith("text/") and raw_type != "text/html":
        return f"{raw_type}; charset=utf-8"
    if kind in {"txt", "text", "md", "csv", "json", "xml", "log", "py", "js", "ts", "css"}:
        return "text/plain; charset=utf-8"
    if raw_type in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }:
        return raw_type
    return "application/octet-stream"


def content_disposition_header(disposition: str, filename: str) -> str:
    safe_name = clean_filename(filename)
    ascii_name = safe_name.encode("ascii", errors="ignore").decode("ascii") or "document"
    ascii_name = ascii_name.replace('"', "")
    return f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(safe_name)}'


def auth_token_from_headers(authorization: str, cookie_header: str) -> str:
    prefix = "bearer "
    authorization = authorization.strip()
    if authorization.lower().startswith(prefix):
        return authorization[len(prefix) :].strip()

    if cookie_header:
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get("auth_token")
        if morsel is not None:
            return morsel.value
    return ""


def redact_sensitive_query(value: str) -> str:
    placeholders: list[tuple[str, str]] = []

    def replace_url(match: re.Match[str]) -> str:
        url = match.group(0)
        parsed = urlsplit(url)
        if not parsed.query:
            return url
        query = parse_qs(parsed.query, keep_blank_values=True)
        if "token" not in query:
            return url
        query["token"] = ["[redacted]"]
        redacted = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query, doseq=True), parsed.fragment))
        placeholder = f"__deepseek_redacted_url_{len(placeholders)}__"
        placeholders.append((placeholder, redacted))
        return placeholder

    value = re.sub(r"https?://[^\s\"']+", replace_url, value)

    def replace_path(match: re.Match[str]) -> str:
        path = match.group(0)
        parsed = urlsplit(path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if "token" not in query:
            return path
        query["token"] = ["[redacted]"]
        return urlunsplit(("", "", parsed.path, urlencode(query, doseq=True), parsed.fragment))

    value = re.sub(r"/[^\s\"']*\?[^ \t\"']*token=[^ \t\"']*", replace_path, value)
    for placeholder, redacted in placeholders:
        value = value.replace(placeholder, redacted)
    return value
