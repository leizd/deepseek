from __future__ import annotations

import unittest
from unittest.mock import patch

import deepseek_mobile.core.utils as utils
from deepseek_mobile.core.utils import (
    clean_filename,
    clear_local_ip_cache,
    format_upstream_error,
    humanize_upstream_error,
    is_content_risk_error,
    is_lan_ip,
    is_rfc1918_ip,
    latest_user_query,
    local_ip,
    normalize_model_name,
    query_tokens,
    score_chunk,
)


class UtilsTests(unittest.TestCase):
    def test_normalize_model_name_accepts_aliases(self) -> None:
        self.assertEqual(normalize_model_name("expert"), "deepseek-v4-pro")
        self.assertEqual(normalize_model_name("deepseek_v4_flash"), "deepseek-v4-flash")

    def test_latest_user_query_uses_last_user_message(self) -> None:
        payload = {
            "messages": [
                {"role": "user", "content": "old"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": " new question "},
            ]
        }
        self.assertEqual(latest_user_query(payload), "new question")

    def test_query_tokens_and_score_chunk_rank_matching_text(self) -> None:
        tokens = query_tokens("DeepSeek request builder")
        self.assertIn("deepseek", tokens)
        self.assertGreater(
            score_chunk("The DeepSeek request builder prepares payloads.", tokens),
            score_chunk("unrelated", tokens),
        )

    def test_query_tokens_extracts_chinese_bigrams_and_lowercases(self) -> None:
        tokens = query_tokens("PYTHON 机器学习入门")

        self.assertIn("python", tokens)
        self.assertNotIn("PYTHON", tokens)
        self.assertIn("机器", tokens)
        self.assertIn("器学", tokens)
        self.assertIn("学习", tokens)

    def test_query_tokens_caps_long_input(self) -> None:
        tokens = query_tokens(" ".join(f"word{index}" for index in range(200)))

        self.assertLessEqual(len(tokens), 80)

    def test_score_chunk_handles_empty_tokens_and_heading_bonus(self) -> None:
        self.assertEqual(score_chunk("anything", []), 0)
        self.assertGreater(score_chunk("python python", ["python"]), score_chunk("python", ["python"]))
        self.assertGreater(score_chunk("# python\nintro", ["python"]), score_chunk("python\nintro", ["python"]))
        self.assertGreater(score_chunk("hello", ["hello"]), score_chunk("ab", ["ab"]))

    def test_clean_filename_strips_directories(self) -> None:
        self.assertEqual(clean_filename(r"C:\tmp\report.md"), "report.md")
        self.assertEqual(clean_filename("../secret.txt"), "secret.txt")

    def test_lan_ip_filters_loopback_and_broadcast_like_addresses(self) -> None:
        self.assertTrue(is_rfc1918_ip("192.168.1.23"))
        self.assertTrue(is_lan_ip("10.0.0.8"))
        self.assertFalse(is_lan_ip("127.0.0.1"))
        self.assertFalse(is_lan_ip("192.168.1.255"))

    def test_local_ip_is_cached(self) -> None:
        clear_local_ip_cache()
        self.addCleanup(clear_local_ip_cache)

        with patch.object(utils, "local_ip_from_ipconfig", return_value="192.168.1.20") as mocked:
            self.assertEqual(local_ip(), "192.168.1.20")
            self.assertEqual(local_ip(), "192.168.1.20")

        self.assertEqual(mocked.call_count, 1)

    def test_local_ip_cache_expires_after_ttl(self) -> None:
        clear_local_ip_cache()
        self.addCleanup(clear_local_ip_cache)

        with (
            patch.object(utils, "LOCAL_IP_CACHE_TTL_SECONDS", 30.0),
            patch.object(utils.time, "monotonic", side_effect=[100.0, 120.0, 131.0]),
            patch.object(utils, "local_ip_from_ipconfig", side_effect=["192.168.1.20", "192.168.1.21"]) as mocked,
        ):
            self.assertEqual(local_ip(), "192.168.1.20")
            self.assertEqual(local_ip(), "192.168.1.20")
            self.assertEqual(local_ip(), "192.168.1.21")

        self.assertEqual(mocked.call_count, 2)

    def test_local_ip_from_ipconfig_hides_windows_console(self) -> None:
        class FakeStartupInfo:
            def __init__(self) -> None:
                self.dwFlags = 0
                self.wShowWindow = 1

        startup_info = FakeStartupInfo()
        output = "IPv4 Address. . . . . . . . . . . : 192.168.1.20"

        with (
            patch.object(utils.os, "name", "nt"),
            patch.object(utils.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
            patch.object(utils.subprocess, "STARTF_USESHOWWINDOW", 1, create=True),
            patch.object(utils.subprocess, "SW_HIDE", 0, create=True),
            patch.object(utils.subprocess, "STARTUPINFO", return_value=startup_info, create=True),
            patch.object(utils.subprocess, "check_output", return_value=output) as check_output,
        ):
            self.assertEqual(utils.local_ip_from_ipconfig(), "192.168.1.20")

        kwargs = check_output.call_args.kwargs
        self.assertEqual(kwargs["creationflags"], 0x08000000)
        self.assertIs(kwargs["startupinfo"], startup_info)
        self.assertEqual(startup_info.dwFlags & 1, 1)
        self.assertEqual(startup_info.wShowWindow, 0)

    def test_format_upstream_error_extracts_message(self) -> None:
        self.assertEqual(
            format_upstream_error('{"error": {"message": "Content Exists Risk"}}'),
            "Content Exists Risk",
        )
        self.assertEqual(format_upstream_error("not json"), "not json")
        self.assertEqual(format_upstream_error(""), "DeepSeek API error")

    def test_is_content_risk_error_detects_moderation_signatures(self) -> None:
        self.assertTrue(is_content_risk_error("Content Exists Risk"))
        self.assertTrue(is_content_risk_error("content_filter triggered"))
        self.assertTrue(is_content_risk_error("内容存在风险"))
        self.assertTrue(is_content_risk_error("内容涉及敏感信息"))
        self.assertFalse(is_content_risk_error("rate limit exceeded"))
        self.assertFalse(is_content_risk_error("Cannot reach DeepSeek API: timed out"))
        self.assertFalse(is_content_risk_error(""))
        self.assertFalse(is_content_risk_error(None))

    def test_humanize_upstream_error_explains_content_risk_only(self) -> None:
        message = humanize_upstream_error("Content Exists Risk")
        self.assertIn("内容安全提示", message)
        self.assertIn("Content Exists Risk", message)
        self.assertIn("联网搜索", message)
        # 非内容拦截类错误原样返回，不被改写
        self.assertEqual(humanize_upstream_error("Rate limit reached"), "Rate limit reached")
        self.assertEqual(humanize_upstream_error(""), "DeepSeek API error")
        self.assertEqual(humanize_upstream_error(None), "DeepSeek API error")


if __name__ == "__main__":
    unittest.main()


