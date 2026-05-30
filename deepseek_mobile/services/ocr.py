"""Optional local OCR extraction for scanned PDFs and images."""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

from deepseek_mobile.core.errors import AppError, ErrorCode

_WINDOWS_TESSERACT_CANDIDATES = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    r"D:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Tesseract-OCR\tesseract.exe",
)

_WINDOWS_OCR_PS = r"""
param([string]$Path)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq "AsTask" -and
    $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } |
  Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
  $task = $script:asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}
$stream = $null
try {
  $file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    throw "Windows OCR engine is not available for current user languages."
  }
  $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  [Console]::Write($result.Text)
} finally {
  if ($null -ne $stream) {
    $stream.Dispose()
  }
}
"""


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


def _powershell_path() -> str | None:
    found = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh.exe") or shutil.which("pwsh")
    if found:
        return found
    if os.name == "nt":
        system_root = Path(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows")
        for candidate in (
            system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
            system_root / "SysWOW64" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
        ):
            if candidate.is_file():
                return str(candidate)
    return None


def _subprocess_creationflags() -> int:
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0


def _image_suffix(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if image_bytes.startswith(b"\xff\xd8"):
        return ".jpg"
    if image_bytes.startswith(b"RIFF") and image_bytes[8:12] == b"WEBP":
        return ".webp"
    if image_bytes.startswith((b"II*\x00", b"MM\x00*")):
        return ".tif"
    if image_bytes.startswith(b"GIF8"):
        return ".gif"
    if image_bytes.startswith(b"BM"):
        return ".bmp"
    return ".img"


def _run_windows_ocr_file(path: Path) -> str:
    powershell = _powershell_path()
    if not powershell:
        raise AppError("PowerShell is required for Windows OCR.", code=ErrorCode.OCR_UNAVAILABLE, status=415)

    script_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".ps1", encoding="utf-8-sig", delete=False) as script:
            script.write(_WINDOWS_OCR_PS)
            script_path = Path(script.name)
        completed = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script_path),
                str(path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            creationflags=_subprocess_creationflags(),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AppError("Windows OCR timed out.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc
    finally:
        if script_path is not None:
            script_path.unlink(missing_ok=True)

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        message = "Windows OCR failed."
        if detail:
            message = f"{message} {detail[:500]}"
        raise AppError(message, code=ErrorCode.OCR_UNAVAILABLE, status=415)
    return completed.stdout.strip()


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


class WindowsOcrEngine:
    name = "windows-ocr"

    def __init__(self) -> None:
        if os.name != "nt":
            raise AppError("Windows OCR is only available on Windows.", code=ErrorCode.OCR_UNAVAILABLE, status=415)
        if _powershell_path() is None:
            raise AppError("PowerShell is required for Windows OCR.", code=ErrorCode.OCR_UNAVAILABLE, status=415)

    def extract(self, pdf_bytes: bytes) -> str:
        try:
            import pdf2image
        except ModuleNotFoundError as exc:
            raise AppError(
                "PDF OCR on Windows requires pdf2image and pdftoppm.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            ) from exc

        pages: list[str] = []
        try:
            images = pdf2image.convert_from_bytes(pdf_bytes, dpi=200, fmt="png")
            with tempfile.TemporaryDirectory(prefix="deepseek-ocr-") as tmpdir:
                tmp = Path(tmpdir)
                for index, image in enumerate(images, start=1):
                    path = tmp / f"page-{index}.png"
                    image.save(path, "PNG")
                    text = _run_windows_ocr_file(path)
                    if text.strip():
                        pages.append(f"[PDF 第 {index} 页 (OCR)]\n{text.strip()}")
        except AppError:
            raise
        except Exception as exc:
            raise AppError("Windows PDF OCR failed.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc
        return "\n\n".join(pages)

    def extract_image(self, image_bytes: bytes) -> str:
        suffix = _image_suffix(image_bytes)
        path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("wb", suffix=suffix, delete=False) as image_file:
                image_file.write(image_bytes)
                path = Path(image_file.name)
            return _run_windows_ocr_file(path)
        except AppError:
            raise
        except Exception as exc:
            raise AppError("Windows image OCR failed.", code=ErrorCode.OCR_UNAVAILABLE, status=415) from exc
        finally:
            if path is not None:
                path.unlink(missing_ok=True)


class AndroidMlKitEngine:
    name = "android-mlkit"

    def __init__(self) -> None:
        try:
            from java import jclass
        except (ImportError, ModuleNotFoundError) as exc:
            raise AppError(
                "Android OCR bridge is not available outside the APK.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            ) from exc

        bridge = jclass("com.deepseek.mobile.AndroidOcrBridge")
        if not bool(bridge.isAvailable()):
            raise AppError(
                "Android OCR bridge is not initialized.",
                code=ErrorCode.OCR_UNAVAILABLE,
                status=415,
            )
        self._bridge = bridge

    def extract(self, pdf_bytes: bytes) -> str:
        return str(self._bridge.recognizePdf(pdf_bytes)).strip()

    def extract_image(self, image_bytes: bytes) -> str:
        return str(self._bridge.recognizeImage(image_bytes)).strip()


def select_ocr_engine() -> OCREngine | None:
    engines, _errors = _ocr_engine_candidates()
    return engines[0] if engines else None


def _ocr_engine_candidates() -> tuple[list[OCREngine], list[str]]:
    engines: list[OCREngine] = []
    errors: list[str] = []

    if os.environ.get("DEEPSEEK_ANDROID_APP") == "1":
        try:
            engines.append(AndroidMlKitEngine())
            return engines, errors
        except AppError as exc:
            errors.append(f"android-mlkit: {exc}")

    try:
        engines.append(TesseractEngine())
    except AppError as exc:
        errors.append(f"tesseract: {exc}")

    if os.name == "nt":
        try:
            engines.append(WindowsOcrEngine())
        except AppError as exc:
            errors.append(f"windows-ocr: {exc}")

    return engines, errors


def _engine_name(engine: OCREngine) -> str:
    return str(getattr(engine, "name", engine.__class__.__name__))


def _with_error_details(message: str, details: list[str]) -> str:
    cleaned = [detail.strip() for detail in details if detail.strip()]
    if not cleaned:
        return message
    return f"{message} Details: {'; '.join(cleaned[:4])}"


def _extract_with_fallback(
    data: bytes,
    *,
    mode: str,
    no_engine_message: str,
    empty_message: str,
) -> str:
    engines, startup_errors = _ocr_engine_candidates()
    if not engines:
        raise AppError(
            _with_error_details(no_engine_message, startup_errors),
            code=ErrorCode.OCR_UNAVAILABLE,
            status=415,
        )

    runtime_errors: list[str] = []
    saw_empty_result = False
    for engine in engines:
        name = _engine_name(engine)
        try:
            text = engine.extract(data) if mode == "pdf" else engine.extract_image(data)
        except AppError as exc:
            if exc.code == ErrorCode.OCR_EMPTY:
                saw_empty_result = True
                runtime_errors.append(f"{name}: {exc}")
                continue
            if exc.code == ErrorCode.OCR_UNAVAILABLE:
                runtime_errors.append(f"{name}: {exc}")
                continue
            raise
        except Exception as exc:
            runtime_errors.append(f"{name}: {exc}")
            continue

        if text.strip():
            return text.strip()
        saw_empty_result = True
        runtime_errors.append(f"{name}: empty result")

    if saw_empty_result:
        raise AppError(empty_message, code=ErrorCode.OCR_EMPTY, status=422)

    raise AppError(
        _with_error_details(no_engine_message, startup_errors + runtime_errors),
        code=ErrorCode.OCR_UNAVAILABLE,
        status=415,
    )


def extract_pdf_ocr(pdf_bytes: bytes) -> str:
    return _extract_with_fallback(
        pdf_bytes,
        mode="pdf",
        no_engine_message="No OCR engine is available. Install requirements-ocr.txt and Tesseract to read scanned PDFs.",
        empty_message="OCR did not recognize any text.",
    )


def extract_image_ocr(image_bytes: bytes) -> str:
    return _extract_with_fallback(
        image_bytes,
        mode="image",
        no_engine_message="No OCR engine is available. Install requirements-ocr.txt and Tesseract to read image text.",
        empty_message="OCR did not recognize any text in image.",
    )

