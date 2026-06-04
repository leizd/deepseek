from __future__ import annotations

import unittest
import unittest.mock
import tempfile
from pathlib import Path

from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.services import generated_files, presentations
from deepseek_mobile.services.presentations import (
    create_presentation,
    infer_presentation_title,
    resolve_generated_file,
    save_generated_file_to_downloads,
    slides_from_outline_text,
)
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

    def test_larger_deck_gets_agenda_and_rich_layouts(self) -> None:
        result = create_presentation(
            "Product Roadmap",
            [
                {"title": "核心观点", "bullets": ["把复杂流程拆成三条主线"]},
                {"title": "关键能力", "bullets": ["洞察：统一指标", "执行：标准流程", "反馈：闭环复盘"]},
                {"title": "实施流程", "bullets": ["调研", "试点", "推广", "复盘"]},
                {"title": "方案对比", "bullets": ["自建：控制力强", "采购：上线快", "混合：风险均衡"]},
                {"title": "总结与下一步", "bullets": ["先跑 MVP", "两周后复盘", "明确负责人"]},
            ],
        )

        self.assertEqual(result["slideCount"], 7)
        self.assertIn("layout", result["outline"][0])
        self.assertEqual(result["outline"][2]["layout"], "process")
        path = resolve_generated_file(result["fileId"])
        self.assertIsNotNone(path)
        assert path is not None
        path.unlink(missing_ok=True)

    def test_resolve_blocks_path_traversal_and_bad_ids(self) -> None:
        self.assertIsNone(resolve_generated_file("../../etc/passwd"))
        self.assertIsNone(resolve_generated_file("not-hex-id"))
        self.assertIsNone(resolve_generated_file(""))
        self.assertIsNone(resolve_generated_file("0" * 31))  # 长度不足 32

    def test_save_generated_file_to_downloads_returns_exact_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            generated_dir = Path(tmp) / ".generated"
            downloads_dir = Path(tmp) / "Downloads"
            with unittest.mock.patch.object(generated_files, "GENERATED_DIR", generated_dir):
                result = create_presentation("路径测试", [{"title": "页", "bullets": ["内容"]}])
                saved = save_generated_file_to_downloads(result["fileId"], filename="路径测试.pptx", downloads_dir=downloads_dir)

            self.assertTrue(Path(saved["path"]).is_file())
            self.assertEqual(Path(saved["path"]).name, "路径测试.pptx")

    def test_create_presentation_requires_title_and_slides(self) -> None:
        with self.assertRaises(AppError) as cm:
            create_presentation("", [{"title": "x", "bullets": ["a"]}])
        self.assertEqual(cm.exception.code, ErrorCode.INVALID_PAYLOAD)
        with self.assertRaises(AppError):
            create_presentation("有标题", [])

    def test_create_pptx_registered_as_tool(self) -> None:
        tools = available_tool_definitions()
        names = [tool["function"]["name"] for tool in tools]
        self.assertIn("create_pptx", names)
        create_pptx = next(tool for tool in tools if tool["function"]["name"] == "create_pptx")
        self.assertIn("slides", create_pptx["function"]["description"])
        self.assertIn("PowerPoint-style presentations", create_pptx["function"]["description"])
        slide_schema = create_pptx["function"]["parameters"]["properties"]["slides"]["items"]
        self.assertIn("layout", slide_schema["properties"])
        self.assertIn("layout", slide_schema["required"])

    def test_text_fallback_marks_slides_skill_route(self) -> None:
        with unittest.mock.patch.object(presentations, "create_presentation", return_value={"ok": True}) as mocked:
            result = presentations.create_presentation_from_text("帮我做一个 Git PPT", "1. 封面 - Git\n2. 工作流")

        self.assertEqual(result, {"ok": True})
        self.assertIn("slides skill", mocked.call_args.kwargs["subtitle"])

    def test_outline_text_can_seed_presentation_slides(self) -> None:
        title = infer_presentation_title("帮我做一个介绍 git 的 PPT")
        slides = slides_from_outline_text(
            """
            关于 Git 的 PPT 大纲：
            1. 封面 - Git 介绍
            2. 什么是版本控制？
            3. Git 的核心概念
            4. 常用命令
            """,
            topic=title,
        )

        self.assertEqual(title, "Git 介绍")
        self.assertEqual(slides[0]["title"], "什么是版本控制？")
        self.assertGreaterEqual(len(slides), 3)


if __name__ == "__main__":
    unittest.main()
