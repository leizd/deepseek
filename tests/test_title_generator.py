from __future__ import annotations

import unittest
from unittest.mock import patch

from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services import title_generator
from deepseek_mobile.services.title_generator import _sanitize_title, generate_title_payload


class TitleGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        title_generator._TITLE_RATE_LIMITS.clear()

    def test_sanitize_title_strips_quotes_prefixes_and_punctuation(self) -> None:
        self.assertEqual(_sanitize_title('"标题：DeepSeek API 调用。"'), "DeepSeek API 调用")
        self.assertEqual(_sanitize_title("标题: 中文测试。"), "中文测试")
        self.assertEqual(_sanitize_title("Multiline\ntitle"), "Multiline title")
        self.assertEqual(len(_sanitize_title("一" * 50)), 24)

    def test_generate_title_returns_empty_for_blank_user_message(self) -> None:
        self.assertEqual(generate_title_payload({"apiKey": "fake", "userMessage": "   "}), {"title": ""})

    def test_title_rate_limit_uses_429(self) -> None:
        with patch.object(title_generator, "TITLE_RATE_LIMIT_COUNT", 2), patch.object(title_generator, "TITLE_RATE_LIMIT_WINDOW_SECONDS", 60):
            title_generator.check_title_rate_limit("key")
            title_generator.check_title_rate_limit("key")
            with self.assertRaises(AppError) as cm:
                title_generator.check_title_rate_limit("key")

        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(cm.exception.code, ErrorCode.RATE_LIMITED)


if __name__ == "__main__":
    unittest.main()
