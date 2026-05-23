"""Optional local OCR extraction for scanned PDFs and images using Tesseract."""

from __future__ import annotations

import io
import os
import shutil
from pathlib import Path
from typing import Protocol

from deepseek_mobile.core.errors import AppError, ErrorCode

_WINDOWS_TESSERACT_CANDIDATES = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    r"D:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Tesseract-OCR\tesseract.exe",
)


def _locate_tesseract() -> str | None:
    override = os.environ.get("TESSERACT_CMD", "").strip()
    if override and Path(override).is_file():
        return override

    found = shutil.which("tesseract")
    if found:
        return found

    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        candidates = list(_WINDOWS_TESSERACT_CANDIDATES)
        if local_app:
            candidates.append(str(Path(local_app) / "Programs" / "Tesseract-OCR" / "tesseract.exe"))
        for candidate in candidates:
            if Path(candidate).is_file():
                return candidate
    return None


def _select_lang(available: set[str]) -> str:
    override = os.environ.get("OCR_LANG", "").strip()
    if override:
        wanted = [part for part in override.replace(",", "+").split("+") if part]
        usable = [part for part in wanted if part in available]
        if usable:
            return "+".join(usable)

    preferred = ["chi_sim", "chi_tra", "eng", "jpn", "kor"]
    picked = [code for code in preferred if code in available]
    if picked:
        return "+".join(picked)
    if available:
        return next(iter(available))
    return "eng"


class OCREngine(Protocol):
    name: str

    def extract(self, pdf_bytes: bytes) -> str:
        ...

    def extract_image(self, image_bytes: bytes) -> str:
        ...


class TesseractEngine:
    name = "tesseract"
    _lang: str = "eng"

    def __init__(self) -> None:
        try:
            import pdf2image
            import pytesseract
        except ModuleNotFoundError as exc:
            raise AppError(
                "OCR dependencies are not installed. Install requirements-ocr.txt and Tesseract.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            ) from exc

        executable = _locate_tesseract()
        if executable is None:
            raise AppError(
                "Tesseract executable not found. Install it (e.g. https://github.com/UB-Mannheim/tesseract/wiki) "
                "and either add it to PATH or set the TESSERACT_CMD environment variable.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            )

        pytesseract.pytesseract.tesseract_cmd = executable

        try:
            available = set(pytesseract.get_languages(config=""))
        except Exception:
            available = set()

        self._pdf2image = pdf2image
        self._tesseract = pytesseract
        self._lang = _select_lang(available)

    def extract(self, pdf_bytes: bytes) -> str:
        images = self._pdf2image.convert_from_bytes(pdf_bytes, dpi=200, fmt="png")
        pages: list[str] = []
        for index, image in enumerate(images, start=1):
            text = self._tesseract.image_to_string(image, lang=self._lang)
            if text.strip():
                pages.append(f"[PDF 第 {index} 页 (OCR)]\n{text.strip()}")
        return "\n\n".join(pages)

    def extract_image(self, image_bytes: bytes) -> str:
        try:
            from PIL import Image, ImageOps
        except ModuleNotFoundError as exc:
            raise AppError(
                "Image OCR dependencies are not installed. Install requirements-ocr.txt and Tesseract.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            ) from exc

        try:
            with Image.open(io.BytesIO(image_bytes)) as image:
                normalized = ImageOps.exif_transpose(image)
                if normalized.mode not in {"RGB", "L"}:
                    normalized = normalized.convert("RGB")
                text = self._tesseract.image_to_string(normalized, lang=self._lang)
        except AppError:
            raise
        except Exception as exc:
            raise AppError("Image OCR failed.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc

        return text.strip()


def select_ocr_engine() -> OCREngine | None:
    try:
        return TesseractEngine()
    except AppError:
        return None


def extract_pdf_ocr(pdf_bytes: bytes) -> str:
    engine = select_ocr_engine()
    if engine is None:
        raise AppError(
            "No OCR engine is available. Install requirements-ocr.txt and Tesseract to read scanned PDFs.",
            code=ErrorCode.OCR_UNAVAILABLE,
            status=415,
        )

    try:
        text = engine.extract(pdf_bytes)
    except AppError:
        raise
    except Exception as exc:
        raise AppError(f"OCR failed with {engine.name}.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc

    if not text.strip():
        raise AppError("OCR did not recognize any text.", code=ErrorCode.OCR_EMPTY, status=422)
    return text


def extract_image_ocr(image_bytes: bytes) -> str:
    engine = select_ocr_engine()
    if engine is None:
        raise AppError(
            "No OCR engine is available. Install requirements-ocr.txt and Tesseract to read image text.",
            code=ErrorCode.OCR_UNAVAILABLE,
            status=415,
        )

    try:
        text = engine.extract_image(image_bytes)
    except AppError:
        raise
    except Exception as exc:
        raise AppError(f"Image OCR failed with {engine.name}.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc

    if not text.strip():
        raise AppError("OCR did not recognize any text in image.", code=ErrorCode.OCR_EMPTY, status=422)
    return text.strip()


