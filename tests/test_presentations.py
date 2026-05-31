from __future__ import annotations

import unittest

from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services.presentations import create_presentation, resolve_generated_file
from deepseek_mobile.services.tools import available_tool_definitions


class PresentationTests(unittest.TestCase):
    def test_create_presentation_generates_file_and_download_url(self) -> None:
        result = create_presentation(
            "测试标题",
            [{"title": "第一页", "bullets": ["要点 A", "要点 B"]}, {"title": "第二页", "bullets": ["要点 C"]}],
            subtitle="副标题",
        )
        # 封面 + 2 内容页
        self.assertEqual(result["slideCount"], 3)
        self.assertTrue(result["downloadUrl"].startswith("/api/download?id="))
        self.assertTrue(result["filename"].endswith(".pptx"))
        path = resolve_generated_file(result["fileId"])
        self.assertIsNotNone(path)
        assert path is not None
        self.assertTrue(path.is_file())
        path.unlink(missing_ok=True)

    def test_content_field_falls_back_to_bullets(self) -> None:
        result = create_presentation("标题", [{"title": "页", "content": "第一行\n第二行"}])
        path = resolve_generated_file(result["fileId"])
        self.assertIsNotNone(path)
        assert path is not None
        path.unlink(missing_ok=True)

    def test_resolve_blocks_path_traversal_and_bad_ids(self) -> None:
        self.assertIsNone(resolve_generated_file("../../etc/passwd"))
        self.assertIsNone(resolve_generated_file("not-hex-id"))
        self.assertIsNone(resolve_generated_file(""))
        self.assertIsNone(resolve_generated_file("0" * 31))  # 长度不足 32

    def test_create_presentation_requires_title_and_slides(self) -> None:
        with self.assertRaises(AppError) as cm:
            create_presentation("", [{"title": "x", "bullets": ["a"]}])
        self.assertEqual(cm.exception.code, ErrorCode.INVALID_PAYLOAD)
        with self.assertRaises(AppError):
            create_presentation("有标题", [])

    def test_create_pptx_registered_as_tool(self) -> None:
        names = [tool["function"]["name"] for tool in available_tool_definitions()]
        self.assertIn("create_pptx", names)


if __name__ == "__main__":
    unittest.main()
