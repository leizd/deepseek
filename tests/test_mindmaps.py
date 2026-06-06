from __future__ import annotations

import tempfile
import unittest
import unittest.mock
from pathlib import Path

from deepseek_infra.core.errors import AppError, ErrorCode
from deepseek_infra.infra.tool_runtime import generated_files
from deepseek_infra.infra.tool_runtime.generated_files import resolve_generated_file, save_generated_file_to_downloads
from deepseek_infra.infra.tool_runtime.mindmaps import create_mindmap
from deepseek_infra.infra.tool_runtime.tools import available_tool_definitions


SAMPLE_NODES = [
    {
        "label": "Market analysis",
        "children": [
            {"label": "User profile", "children": []},
            {"label": "Competition", "children": [{"label": "Pricing", "children": []}]},
        ],
    },
    {
        "label": "Product strategy",
        "children": [
            {"label": "Core features", "children": []},
            {"label": "Launch rhythm", "children": []},
        ],
    },
]


class MindMapTests(unittest.TestCase):
    def test_create_mindmap_generates_svg_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with unittest.mock.patch.object(generated_files, "GENERATED_DIR", Path(tmp)):
                result = create_mindmap("Growth plan", SAMPLE_NODES, subtitle="2026")
                self.assertEqual(result["format"], "svg")
                self.assertGreaterEqual(result["nodeCount"], 6)
                self.assertTrue(result["downloadUrl"].startswith("/api/download?id="))
                path = resolve_generated_file(result["fileId"])
                self.assertIsNotNone(path)
                assert path is not None
                self.assertEqual(path.suffix, ".svg")
                text = path.read_text(encoding="utf-8")
                self.assertIn("<svg", text)
                self.assertIn("Growth plan", text)

    def test_save_to_downloads_uses_svg_extension(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            generated_dir = Path(tmp) / ".generated"
            downloads_dir = Path(tmp) / "Downloads"
            with unittest.mock.patch.object(generated_files, "GENERATED_DIR", generated_dir):
                result = create_mindmap("Saved mind map", SAMPLE_NODES)
                saved = save_generated_file_to_downloads(result["fileId"], filename="saved-mind-map.pdf", downloads_dir=downloads_dir)
            self.assertTrue(Path(saved["path"]).is_file())
            self.assertEqual(Path(saved["path"]).suffix, ".svg")

    def test_invalid_inputs_raise(self) -> None:
        with self.assertRaises(AppError) as cm:
            create_mindmap("", SAMPLE_NODES)
        self.assertEqual(cm.exception.code, ErrorCode.INVALID_PAYLOAD)
        with self.assertRaises(AppError):
            create_mindmap("Empty", [])

    def test_create_mindmap_registered_as_tool(self) -> None:
        tools = available_tool_definitions()
        names = [tool["function"]["name"] for tool in tools]
        self.assertIn("create_mindmap", names)
        tool = next(item for item in tools if item["function"]["name"] == "create_mindmap")
        params = tool["function"]["parameters"]["properties"]
        self.assertIn("nodes", params)
        node_schema = params["nodes"]["items"]
        self.assertIn("label", node_schema["required"])
        self.assertIn("children", node_schema["required"])


if __name__ == "__main__":
    unittest.main()
