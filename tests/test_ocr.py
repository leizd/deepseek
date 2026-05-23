from __future__ import annotations

import unittest
from types import SimpleNamespace
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

        with patch.object(ocr, "select_ocr_engine", return_value=fake_engine):
            with self.assertRaises(AppError) as cm:
                ocr.extract_pdf_ocr(b"%PDF")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_EMPTY)
        self.assertEqual(cm.exception.status, 422)

    def test_extract_pdf_ocr_reports_unavailable_engine(self) -> None:
        with patch.object(ocr, "select_ocr_engine", return_value=None):
            with self.assertRaises(AppError) as cm:
                ocr.extract_pdf_ocr(b"%PDF")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_UNAVAILABLE)
        self.assertEqual(cm.exception.status, 415)

    def test_extract_image_ocr_returns_fake_engine_text(self) -> None:
        fake_engine = SimpleNamespace(name="fake", extract_image=lambda data: " 图片文字 ")

        with patch.object(ocr, "select_ocr_engine", return_value=fake_engine):
            text = ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(text, "图片文字")

    def test_extract_image_ocr_reports_empty_result(self) -> None:
        fake_engine = SimpleNamespace(name="fake", extract_image=lambda data: "")

        with patch.object(ocr, "select_ocr_engine", return_value=fake_engine):
            with self.assertRaises(AppError) as cm:
                ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_EMPTY)
        self.assertEqual(cm.exception.status, 422)

    def test_extract_image_ocr_reports_unavailable_engine(self) -> None:
        with patch.object(ocr, "select_ocr_engine", return_value=None):
            with self.assertRaises(AppError) as cm:
                ocr.extract_image_ocr(b"\x89PNG")

        self.assertEqual(cm.exception.code, ErrorCode.OCR_UNAVAILABLE)
        self.assertEqual(cm.exception.status, 415)


if __name__ == "__main__":
    unittest.main()
