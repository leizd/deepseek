from __future__ import annotations

import unittest
from unittest.mock import patch

import deepseek_mobile.core.utils as utils
from deepseek_mobile.core.utils import (
    clean_filename,
    clear_local_ip_cache,
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


if __name__ == "__main__":
    unittest.main()


