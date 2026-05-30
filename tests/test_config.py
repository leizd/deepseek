from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from deepseek_mobile.core.config import (
    DEFAULT_HOST,
    FILE_CACHE_DIR,
    FILE_CHUNK_CHARS,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_FILE_BYTES,
    MODEL_ALIASES,
    MULTI_AGENT_TIMEOUT_SECONDS,
    SEARCH_RESULT_LIMIT,
    SEARCH_TOTAL_RESULT_LIMIT,
    Settings,
    AGENT_RUNS_DIR,
    AUTH_TOKEN_FILE,
    load_or_create_auth_token,
    settings,
)


class ConfigTests(unittest.TestCase):
    def test_nested_settings_back_compat_constants_match(self) -> None:
        self.assertEqual(settings.app_version, "1.6.6")
        self.assertEqual(settings.default_host, "127.0.0.1")
        self.assertEqual(DEFAULT_HOST, settings.default_host)
        self.assertEqual(MULTI_AGENT_TIMEOUT_SECONDS, settings.multi_agent_timeout_seconds)
        self.assertEqual(settings.multi_agent_timeout_seconds, 3900)
        self.assertEqual(SEARCH_RESULT_LIMIT, settings.search.result_limit)
        self.assertEqual(SEARCH_TOTAL_RESULT_LIMIT, settings.search.total_result_limit)
        self.assertEqual(FILE_CHUNK_CHARS, settings.files.chunk_chars)
        self.assertEqual(FILE_CACHE_DIR, settings.file_cache_dir)
        self.assertEqual(AGENT_RUNS_DIR, settings.agent_runs_dir)
        self.assertEqual(AUTH_TOKEN_FILE, settings.auth_token_file)
        self.assertEqual(MAX_UPLOAD_FILE_BYTES, 200_000_000)
        self.assertEqual(MAX_UPLOAD_BYTES, 220_000_000)

    def test_model_aliases_are_read_only(self) -> None:
        self.assertEqual(MODEL_ALIASES.get("fast"), "deepseek-v4-flash")
        with self.assertRaises(TypeError):
            settings.model_aliases["new"] = "deepseek-v4-pro"  # type: ignore[index]

    def test_env_settings_parse_host_auth_and_ocr(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "HOST": "0.0.0.0",
                "PORT": "8012",
                "AUTH_DISABLED": "1",
                "AUTH_TOKEN": "fixed-token",
                "AUTH_ALLOWED_HOSTS": "phone.local, 192.168.1.10",
                "OCR_ENABLED": "1",
                "DEEPSEEK_TIMEOUT_SECONDS": "222",
                "MULTI_AGENT_TIMEOUT_SECONDS": "333",
                "TAVILY_TIMEOUT_SECONDS": "33",
                "UPLOAD_FILE_MAX_BYTES": "123456",
                "UPLOAD_MAX_BYTES": "234567",
            },
            clear=True,
        ):
            loaded = Settings.from_env()

        self.assertEqual(loaded.default_host, "0.0.0.0")
        self.assertEqual(loaded.default_port, 8012)
        self.assertFalse(loaded.auth.enabled)
        self.assertEqual(loaded.auth.token, "fixed-token")
        self.assertEqual(loaded.auth.allowed_hosts, ("phone.local", "192.168.1.10"))
        self.assertTrue(loaded.ocr.enabled)
        self.assertEqual(loaded.deepseek_timeout_seconds, 222)
        self.assertEqual(loaded.multi_agent_timeout_seconds, 333)
        self.assertEqual(loaded.tavily_timeout_seconds, 33)
        self.assertEqual(loaded.files.upload_file_max_bytes, 123456)
        self.assertEqual(loaded.files.upload_max_bytes, 234567)

    def test_invalid_timeout_env_values_fall_back_to_defaults(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "DEEPSEEK_TIMEOUT_SECONDS": "not-a-number",
                "MULTI_AGENT_TIMEOUT_SECONDS": " ",
                "TAVILY_TIMEOUT_SECONDS": "",
            },
            clear=True,
        ):
            loaded = Settings.from_env()

        self.assertEqual(loaded.deepseek_timeout_seconds, 180)
        self.assertEqual(loaded.multi_agent_timeout_seconds, 3900)
        self.assertEqual(loaded.tavily_timeout_seconds, 45)

    def test_multi_agent_token_budget_defaults_and_env_override(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(Settings.from_env().multi_agent_token_budget, 2_000_000)
        with patch.dict("os.environ", {"MULTI_AGENT_TOKEN_BUDGET": "500000"}, clear=True):
            self.assertEqual(Settings.from_env().multi_agent_token_budget, 500_000)
        with patch.dict("os.environ", {"MULTI_AGENT_TOKEN_BUDGET": "not-a-number"}, clear=True):
            self.assertEqual(Settings.from_env().multi_agent_token_budget, 2_000_000)

    def test_agent_models_default_to_pro(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            loaded = Settings.from_env()

        self.assertEqual(
            dict(loaded.agent_models),
            {
                "planner": "deepseek-v4-pro",
                "researcher": "deepseek-v4-pro",
                "coder": "deepseek-v4-pro",
                "reasoner": "deepseek-v4-pro",
                "critic": "deepseek-v4-pro",
            },
        )

    def test_agent_model_env_overrides_per_role_with_fallback(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "AGENT_MODEL_PLANNER": "flash",
                "AGENT_MODEL_CRITIC": "deepseek-v4-flash",
                "AGENT_MODEL_CODER": "gpt-9",
            },
            clear=True,
        ):
            loaded = Settings.from_env()

        self.assertEqual(loaded.agent_models["planner"], "deepseek-v4-flash")
        self.assertEqual(loaded.agent_models["critic"], "deepseek-v4-flash")
        # 未识别的值回退到默认 pro，不会把脏值塞进配置
        self.assertEqual(loaded.agent_models["coder"], "deepseek-v4-pro")
        self.assertEqual(loaded.agent_models["researcher"], "deepseek-v4-pro")
        self.assertEqual(loaded.agent_models["reasoner"], "deepseek-v4-pro")

    def test_auth_token_persists_across_settings_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            root = Path(tmp)
            with self.subTest("create"):
                first = Settings.from_env(root=root)
            with self.subTest("reuse"):
                second = Settings.from_env(root=root)

        self.assertEqual(first.auth.token, second.auth.token)

    def test_android_packaging_paths_can_be_overridden_by_env(self) -> None:
        with tempfile.TemporaryDirectory() as root_tmp, tempfile.TemporaryDirectory() as static_tmp:
            with patch.dict(
                "os.environ",
                {
                    "DEEPSEEK_MOBILE_ROOT": root_tmp,
                    "DEEPSEEK_MOBILE_STATIC_DIR": static_tmp,
                    "AUTH_TOKEN": "android-token",
                },
                clear=True,
            ):
                loaded = Settings.from_env()

                self.assertEqual(loaded.root, Path(root_tmp).resolve())
                self.assertEqual(loaded.static_dir, Path(static_tmp).resolve())
                self.assertEqual(loaded.auth.token, "android-token")

    def test_load_or_create_auth_token_reuses_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".auth-token").write_text("fixed-local-token\n", encoding="utf-8")

            self.assertEqual(load_or_create_auth_token(root), "fixed-local-token")


if __name__ == "__main__":
    unittest.main()

