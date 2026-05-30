"""Runtime settings, compatibility constants, and JSON logging setup."""

from __future__ import annotations

import json
import logging
import os
import secrets
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping


def _runtime_root() -> Path:
    """Directory where writable user data lives (auth token, caches, projects).

    When packaged with PyInstaller we put it next to the executable so the data
    survives across runs; ``sys._MEIPASS`` is a per-invocation temp dir and is
    not safe to write to.
    """
    env_root = os.environ.get("DEEPSEEK_MOBILE_ROOT", "").strip()
    if env_root:
        return Path(env_root).expanduser().resolve()
    if getattr(sys, "frozen", False) and hasattr(sys, "executable"):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _bundled_static_dir() -> Path:
    """Directory where read-only static assets live (frozen bundle vs. repo)."""
    env_static_dir = os.environ.get("DEEPSEEK_MOBILE_STATIC_DIR", "").strip()
    if env_static_dir:
        return Path(env_static_dir).expanduser().resolve()
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "static"
    return _runtime_root() / "static"


ROOT = _runtime_root()


@dataclass(frozen=True, slots=True)
class SearchSettings:
    result_limit: int = 5
    round_limit: int = 3
    content_chars: int = 1200
    raw_content_chars: int = 3500
    context_result_limit: int = 8
    cache_max_age_seconds: int = 1800

    @property
    def total_result_limit(self) -> int:
        return self.result_limit * self.round_limit


@dataclass(frozen=True, slots=True)
class FileSettings:
    upload_file_max_bytes: int = 200_000_000
    upload_max_bytes: int = 220_000_000
    cache_max_age_days: int = 14
    cache_max_bytes: int = 500_000_000
    chunk_chars: int = 6000
    chunk_overlap: int = 400
    full_context_limit: int = 60_000
    context_char_budget: int = 115_000
    context_max_chunks: int = 18
    preview_chars: int = 1800
    max_zip_entry_bytes: int = 20_000_000
    max_zip_total_bytes: int = 120_000_000


@dataclass(frozen=True, slots=True)
class ContextSettings:
    compress_max_input_chars: int = 90_000
    summary_max_chars: int = 12_000
    compress_model: str = "deepseek-v4-flash"


@dataclass(frozen=True, slots=True)
class MemorySettings:
    context_char_budget: int = 8_000
    retrieve_limit: int = 12
    max_items: int = 400


@dataclass(frozen=True, slots=True)
class AuthSettings:
    enabled: bool = True
    token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    allowed_hosts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class OCRSettings:
    enabled: bool = False


@dataclass(frozen=True, slots=True)
class Settings:
    root: Path = ROOT
    app_version: str = "1.6.6"
    deepseek_url: str = "https://api.deepseek.com/chat/completions"
    tavily_url: str = "https://api.tavily.com/search"
    deepseek_timeout_seconds: int = 180
    multi_agent_timeout_seconds: int = 3900
    tavily_timeout_seconds: int = 45
    # 多 Agent 一次运行的累计 token 上限（prompt+completion，跨所有 worker+综合）。默认设
    # 得很高，只作失控保护网，正常运行不会触达；综合阶段永远不受其影响。可经环境变量
    # MULTI_AGENT_TOKEN_BUDGET 收紧；设为 0 表示不限制。
    multi_agent_token_budget: int = 2_000_000
    deepseek_api_key: str = ""
    tavily_api_key: str = ""
    default_host: str = "127.0.0.1"
    default_port: int = 8000
    default_model: str = "deepseek-v4-pro"
    supported_models: tuple[str, ...] = ("deepseek-v4-pro", "deepseek-v4-flash")
    model_routes: Mapping[str, str] = field(
        default_factory=lambda: MappingProxyType({"fast": "deepseek-v4-flash", "expert": "deepseek-v4-pro"})
    )
    model_aliases: Mapping[str, str] = field(
        default_factory=lambda: MappingProxyType(
            {
                "deepseek-v4-pro": "deepseek-v4-pro",
                "deepseekv4pro": "deepseek-v4-pro",
                "v4pro": "deepseek-v4-pro",
                "expert": "deepseek-v4-pro",
                "deepseek-v4-flash": "deepseek-v4-flash",
                "deepseekv4flash": "deepseek-v4-flash",
                "v4flash": "deepseek-v4-flash",
                "flash": "deepseek-v4-flash",
                "fast": "deepseek-v4-flash",
            }
        )
    )
    # 多 Agent 各角色用的模型，默认全部 deepseek-v4-pro（保持历史行为）。可用环境变量
    # AGENT_MODEL_PLANNER / _RESEARCHER / _CODER / _REASONER / _CRITIC 单独降级到
    # deepseek-v4-flash（更便宜更快，但不带 thinking 深度推理）。
    agent_models: Mapping[str, str] = field(
        default_factory=lambda: MappingProxyType(
            {
                "planner": "deepseek-v4-pro",
                "researcher": "deepseek-v4-pro",
                "coder": "deepseek-v4-pro",
                "reasoner": "deepseek-v4-pro",
                "critic": "deepseek-v4-pro",
            }
        )
    )
    search: SearchSettings = field(default_factory=SearchSettings)
    files: FileSettings = field(default_factory=FileSettings)
    context: ContextSettings = field(default_factory=ContextSettings)
    memory: MemorySettings = field(default_factory=MemorySettings)
    auth: AuthSettings = field(default_factory=AuthSettings)
    ocr: OCRSettings = field(default_factory=OCRSettings)

    @property
    def static_dir(self) -> Path:
        return _bundled_static_dir()

    @property
    def search_cache_dir(self) -> Path:
        return self.root / ".search-cache"

    @property
    def file_cache_dir(self) -> Path:
        return self.root / ".file-cache"

    @property
    def memory_dir(self) -> Path:
        return self.root / ".memory"

    @property
    def memory_file(self) -> Path:
        return self.memory_dir / "memories.json"

    @property
    def reminders_dir(self) -> Path:
        return self.root / ".reminders"

    @property
    def reminders_file(self) -> Path:
        return self.reminders_dir / "reminders.json"

    @property
    def projects_dir(self) -> Path:
        return self.root / ".projects"

    @property
    def agent_runs_dir(self) -> Path:
        return self.root / ".agent-runs"

    @property
    def auth_token_file(self) -> Path:
        return self.root / ".auth-token"

    @classmethod
    def from_env(cls, root: Path | None = None) -> "Settings":
        runtime_root = _runtime_root() if root is None else root
        auth_token = os.environ.get("AUTH_TOKEN", "").strip()
        file_defaults = FileSettings()
        return cls(
            root=runtime_root,
            deepseek_timeout_seconds=_env_int("DEEPSEEK_TIMEOUT_SECONDS", 180),
            multi_agent_timeout_seconds=_env_int("MULTI_AGENT_TIMEOUT_SECONDS", 3900),
            tavily_timeout_seconds=_env_int("TAVILY_TIMEOUT_SECONDS", 45),
            multi_agent_token_budget=_env_int("MULTI_AGENT_TOKEN_BUDGET", 2_000_000),
            agent_models=_agent_models_from_env(),
            deepseek_api_key=os.environ.get("DEEPSEEK_API_KEY", "").strip(),
            tavily_api_key=os.environ.get("TAVILY_API_KEY", "").strip(),
            default_host=os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1",
            default_port=_env_int("PORT", 8000),
            auth=AuthSettings(
                enabled=not _env_bool("AUTH_DISABLED", False),
                token=auth_token or load_or_create_auth_token(runtime_root),
                allowed_hosts=_env_tuple("AUTH_ALLOWED_HOSTS"),
            ),
            files=FileSettings(
                upload_file_max_bytes=_env_int("UPLOAD_FILE_MAX_BYTES", file_defaults.upload_file_max_bytes),
                upload_max_bytes=_env_int("UPLOAD_MAX_BYTES", file_defaults.upload_max_bytes),
            ),
            ocr=OCRSettings(enabled=_env_bool("OCR_ENABLED", False)),
        )


def load_or_create_auth_token(root: Path = ROOT) -> str:
    """Keep the local auth token stable across server restarts.

    Without a stable token, a browser tab that already has an HttpOnly
    `auth_token` cookie becomes unauthorized after every process restart.
    """
    token_path = root / ".auth-token"
    try:
        existing = token_path.read_text(encoding="utf-8").strip()
        if existing:
            return existing.splitlines()[0].strip()
    except OSError:
        pass

    token = secrets.token_urlsafe(24)
    try:
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(token + "\n", encoding="utf-8")
    except OSError:
        return token
    return token


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_tuple(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


_AGENT_MODEL_ENV = {
    "planner": "AGENT_MODEL_PLANNER",
    "researcher": "AGENT_MODEL_RESEARCHER",
    "coder": "AGENT_MODEL_CODER",
    "reasoner": "AGENT_MODEL_REASONER",
    "critic": "AGENT_MODEL_CRITIC",
}
_AGENT_MODEL_CHOICES = {
    "pro": "deepseek-v4-pro",
    "flash": "deepseek-v4-flash",
    "deepseek-v4-pro": "deepseek-v4-pro",
    "deepseek-v4-flash": "deepseek-v4-flash",
}


def _env_agent_model(name: str, default: str = "deepseek-v4-pro") -> str:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return _AGENT_MODEL_CHOICES.get(raw, default)


def _agent_models_from_env() -> Mapping[str, str]:
    return MappingProxyType({role: _env_agent_model(env) for role, env in _AGENT_MODEL_ENV.items()})


settings = Settings.from_env()

STATIC_DIR = settings.static_dir
APP_VERSION = settings.app_version
DEEPSEEK_URL = settings.deepseek_url
TAVILY_URL = settings.tavily_url
DEEPSEEK_TIMEOUT_SECONDS = settings.deepseek_timeout_seconds
MULTI_AGENT_TIMEOUT_SECONDS = settings.multi_agent_timeout_seconds
MULTI_AGENT_TOKEN_BUDGET = settings.multi_agent_token_budget
TAVILY_TIMEOUT_SECONDS = settings.tavily_timeout_seconds
TAVILY_API_KEY = settings.tavily_api_key
DEFAULT_HOST = settings.default_host
DEFAULT_PORT = settings.default_port
DEFAULT_MODEL = settings.default_model
SUPPORTED_MODELS = settings.supported_models
MODEL_ROUTES = settings.model_routes
MODEL_ALIASES = settings.model_aliases
AGENT_MODELS = settings.agent_models

SEARCH_RESULT_LIMIT = settings.search.result_limit
SEARCH_ROUND_LIMIT = settings.search.round_limit
SEARCH_TOTAL_RESULT_LIMIT = settings.search.total_result_limit
SEARCH_CONTENT_CHARS = settings.search.content_chars
SEARCH_RAW_CONTENT_CHARS = settings.search.raw_content_chars
SEARCH_CONTEXT_RESULT_LIMIT = settings.search.context_result_limit
SEARCH_CACHE_DIR = settings.search_cache_dir
SEARCH_CACHE_MAX_AGE_SECONDS = settings.search.cache_max_age_seconds

MAX_UPLOAD_FILE_BYTES = settings.files.upload_file_max_bytes
MAX_UPLOAD_BYTES = settings.files.upload_max_bytes
FILE_CACHE_DIR = settings.file_cache_dir
FILE_CHUNK_CHARS = settings.files.chunk_chars
FILE_CHUNK_OVERLAP = settings.files.chunk_overlap
FILE_FULL_CONTEXT_LIMIT = settings.files.full_context_limit
FILE_CONTEXT_CHAR_BUDGET = settings.files.context_char_budget
FILE_CONTEXT_MAX_CHUNKS = settings.files.context_max_chunks
FILE_PREVIEW_CHARS = settings.files.preview_chars
FILE_CACHE_MAX_AGE_DAYS = settings.files.cache_max_age_days
FILE_CACHE_MAX_BYTES = settings.files.cache_max_bytes
MAX_ZIP_ENTRY_BYTES = settings.files.max_zip_entry_bytes
MAX_ZIP_TOTAL_BYTES = settings.files.max_zip_total_bytes

CONTEXT_COMPRESS_MAX_INPUT_CHARS = settings.context.compress_max_input_chars
CONTEXT_SUMMARY_MAX_CHARS = settings.context.summary_max_chars
CONTEXT_COMPRESS_MODEL = settings.context.compress_model

MEMORY_DIR = settings.memory_dir
MEMORY_FILE = settings.memory_file
MEMORY_CONTEXT_CHAR_BUDGET = settings.memory.context_char_budget
MEMORY_RETRIEVE_LIMIT = settings.memory.retrieve_limit
MEMORY_MAX_ITEMS = settings.memory.max_items
REMINDERS_DIR = settings.reminders_dir
REMINDERS_FILE = settings.reminders_file
PROJECTS_DIR = settings.projects_dir
AGENT_RUNS_DIR = settings.agent_runs_dir
AUTH_TOKEN_FILE = settings.auth_token_file

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
    ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php",
    ".rb", ".swift", ".kt", ".sql", ".sh", ".ps1", ".bat", ".log", ".ini",
    ".toml", ".env", ".rtf",
}
TRUSTED_DOMAIN_HINTS = (
    ".gov",
    ".edu",
    "wikipedia.org",
    "github.com",
    "docs.",
    "developer.",
    "support.",
    "learn.microsoft.com",
    "developer.mozilla.org",
)

LOG_RECORD_BUILTINS = set(logging.makeLogRecord({}).__dict__)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in LOG_RECORD_BUILTINS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    root_logger = logging.getLogger()
    if root_logger.handlers:
        for handler in root_logger.handlers:
            handler.setFormatter(JsonLogFormatter())
        root_logger.setLevel(level)
        return

    stream = sys.stderr if sys.stderr is not None else open(os.devnull, "w", encoding="utf-8")
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonLogFormatter())
    root_logger.addHandler(handler)
    root_logger.setLevel(level)




