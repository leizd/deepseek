from __future__ import annotations

import os
import sys
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import deepseek_mobile.services.ocr as ocr
from deepseek_mobile.core.errors import AppError, ErrorCode


class OcrTests(unittest.TestCase):
    def test_tesseract_engine_extract_labels_pdf_pages(self) -> None:
        engine = ocr.TesseractEngine.__new__(ocr.TesseractEngine)
        engine._pdf2image = SimpleNamespace(convert_from_bytes=lambda data, dpi, fmt: ["page1", "page2"])
        engine._tesseract = SimpleNamespace(image_to_string=lambda image, lang: f"text from {image}" if image == "page2" else "")

        text = engine.extract(b"%PDF")

        self.assertIn("[PDF 第 2 页 (OCR)]", text)
        self.assertIn("text from page2", text)
        self.assertNotIn("page1", text)

    def test_extract_pdf_ocr_reports_empty_ocr_result(self) -> None:
        fake_engine = SimpleNamespace(name="fake", extract=lambda data: "")

        with patch.object(ocr, "_ocr_engine_candidates", return_value=([fake_engine], [])):
            with self.assertRaises(AppError) as cm:
                ocr.extract_pdf_ocr(b"%PDF")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_EMPTY)
        self.assertEqual(cm.exception.status, 422)

    def test_extract_pdf_ocr_reports_unavailable_engine(self) -> None:
        with patch.object(ocr, "_ocr_engine_candidates", return_value=([], [])):
            with self.assertRaises(AppError) as cm:
                ocr.extract_pdf_ocr(b"%PDF")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_UNAVAILABLE)
        self.assertEqual(cm.exception.status, 415)

    def test_extract_image_ocr_returns_fake_engine_text(self) -> None:
        fake_engine = SimpleNamespace(name="fake", extract_image=lambda data: " 图片文字 ")

        with patch.object(ocr, "_ocr_engine_candidates", return_value=([fake_engine], [])):
            text = ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(text, "图片文字")

    def test_extract_image_ocr_reports_empty_result(self) -> None:
        fake_engine = SimpleNamespace(name="fake", extract_image=lambda data: "")

        with patch.object(ocr, "_ocr_engine_candidates", return_value=([fake_engine], [])):
            with self.assertRaises(AppError) as cm:
                ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_EMPTY)
        self.assertEqual(cm.exception.status, 422)

    def test_extract_image_ocr_reports_unavailable_engine(self) -> None:
        with patch.object(ocr, "_ocr_engine_candidates", return_value=([], [])):
            with self.assertRaises(AppError) as cm:
                ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_UNAVAILABLE)
        self.assertEqual(cm.exception.status, 415)

    def test_extract_image_ocr_falls_back_after_runtime_engine_failure(self) -> None:
        def fail_image(data: bytes) -> str:
            raise AppError("tesseract runtime failed", code=ErrorCode.OCR_UNAVAILABLE, status=415)

        tesseract = SimpleNamespace(name="tesseract", extract_image=fail_image)
        windows = SimpleNamespace(name="windows-ocr", extract_image=lambda data: " windows text ")

        with patch.object(ocr, "_ocr_engine_candidates", return_value=([tesseract, windows], [])):
            text = ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(text, "windows text")

    def test_android_mlkit_engine_uses_java_bridge(self) -> None:
        class FakeBridge:
            @staticmethod
            def isAvailable() -> bool:
                return True

            @staticmethod
            def recognizePdf(data: bytes) -> str:
                return f" pdf {len(data)} "

            @staticmethod
            def recognizeImage(data: bytes) -> str:
                return f" image {len(data)} "

        java_module = ModuleType("java")
        java_module.jclass = lambda name: FakeBridge

        with patch.dict(sys.modules, {"java": java_module}):
            engine = ocr.AndroidMlKitEngine()

        self.assertEqual(engine.extract(b"%PDF"), "pdf 4")
        self.assertEqual(engine.extract_image(b"\x89PNG"), "image 4")

    def test_select_ocr_engine_prefers_android_bridge_in_apk(self) -> None:
        fake_engine = SimpleNamespace(name="android")

        with (
            patch.dict(os.environ, {"DEEPSEEK_ANDROID_APP": "1"}),
            patch.object(ocr, "AndroidMlKitEngine", return_value=fake_engine),
            patch.object(ocr, "TesseractEngine") as tesseract,
        ):
            engine = ocr.select_ocr_engine()

        self.assertIs(engine, fake_engine)
        tesseract.assert_not_called()

    def test_windows_ocr_engine_uses_temp_image_file(self) -> None:
        with (
            patch.object(ocr.os, "name", "nt"),
            patch.object(ocr, "_powershell_path", return_value="powershell.exe"),
            patch.object(ocr, "_run_windows_ocr_file", return_value=" windows text ") as run_ocr,
        ):
            engine = ocr.WindowsOcrEngine()
            text = engine.extract_image(b"\x89PNG\r\n\x1a\nimage")

        self.assertEqual(text, " windows text ")
        temp_path = run_ocr.call_args.args[0]
        self.assertFalse(temp_path.exists())

    def test_powershell_path_uses_windows_system_fallback(self) -> None:
        with (
            patch.object(ocr.os, "name", "nt"),
            patch.dict(ocr.os.environ, {"SystemRoot": r"C:\Windows"}, clear=True),
            patch.object(ocr.shutil, "which", return_value=None),
            patch.object(
                ocr.Path,
                "is_file",
                lambda path: str(path).endswith(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            ),
        ):
            path = ocr._powershell_path()

        self.assertEqual(path, r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")

    def test_select_ocr_engine_falls_back_to_windows_ocr_on_desktop_windows(self) -> None:
        fake_engine = SimpleNamespace(name="windows")

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(ocr.os, "name", "nt"),
            patch.object(
                ocr,
                "TesseractEngine",
                side_effect=AppError("missing tesseract", code=ErrorCode.OCR_UNAVAILABLE, status=415),
            ),
            patch.object(ocr, "WindowsOcrEngine", return_value=fake_engine),
        ):
            engine = ocr.select_ocr_engine()

        self.assertIs(engine, fake_engine)


if __name__ == "__main__":
    unittest.main()
