"""Uploaded file parsing, chunking, cache storage, and attachment retrieval."""

from __future__ import annotations

import hashlib
import html
import io
import json
import re
import zipfile
from datetime import datetime
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import defusedxml.ElementTree as ET
from defusedxml.common import DefusedXmlException

from deepseek_mobile.core.config import (
    FILE_CACHE_DIR,
    FILE_CACHE_MAX_AGE_DAYS,
    FILE_CACHE_MAX_BYTES,
    FILE_CHUNK_CHARS,
    FILE_CHUNK_OVERLAP,
    FILE_CONTEXT_CHAR_BUDGET,
    FILE_CONTEXT_MAX_CHUNKS,
    FILE_FULL_CONTEXT_LIMIT,
    FILE_PREVIEW_CHARS,
    MAX_ZIP_ENTRY_BYTES,
    MAX_ZIP_TOTAL_BYTES,
    PROJECTS_DIR,
    TEXT_EXTENSIONS,
    settings,
)
from deepseek_mobile.core.errors import AppError, ErrorCode
from deepseek_mobile.core.utils import query_tokens, score_chunk
from deepseek_mobile.services.ocr import extract_image_ocr, extract_pdf_ocr


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
EPUB_EXTENSION = ".epub"
PPTX_EXTENSION = ".pptx"
HTML_EXTENSIONS = {".html", ".htm"}
VECTOR_DIMENSIONS = 64
MAX_ZIP_COMPRESSION_RATIO = 100


def build_attachment_context(attachments: list[Any], query: str) -> str:
    sections: list[str] = []
    remaining_budget = FILE_CONTEXT_CHAR_BUDGET
    valid_attachments = [item for item in attachments if isinstance(item, dict)]

    for position, attachment in enumerate(valid_attachments, start=1):
        if remaining_budget <= 0:
            sections.append("[其余附件因上下文预算不足，本轮未发送。]")
            break

        file_id = str(attachment.get("fileId") or "").strip()
        attachments_left = max(1, len(valid_attachments) - position + 1)
        per_file_budget = min(remaining_budget, max(8_000, remaining_budget // attachments_left))
        if file_id:
            try:
                cached = load_cached_file(file_id, project_id=str(attachment.get("projectId") or "").strip() or None)
            except AppError as exc:
                name = attachment.get("name") or file_id
                sections.append(f"--- 文件 {position}: {name} ---\n[文件索引读取失败：{exc}]")
                continue
            section = format_cached_file_context(position, cached, query, char_budget=per_file_budget)
            sections.append(section)
            remaining_budget -= len(section)
            continue

        legacy_text = str(attachment.get("text") or "").strip()
        if legacy_text:
            name = str(attachment.get("name") or f"附件 {position}")
            kind = str(attachment.get("kind") or "text")
            text = legacy_text[:per_file_budget]
            suffix = "\n[旧版附件内容较长，本轮只发送前半部分。建议重新上传以启用分块索引。]" if len(legacy_text) > len(text) else ""
            section = f"--- 文件 {position}: {name} ({kind}) ---\n{text}{suffix}"
            sections.append(section)
            remaining_budget -= len(section)

    if not sections:
        return ""

    return "\n\n".join(
        [
            "[用户上传文件上下文]",
            "说明：文件全文已在本地后端分块索引中保存；本轮会按用户问题选取相关片段送入模型。回答时优先依据这些片段，若片段不足以支持结论，请明确指出需要更具体的问题或更多上下文。引用文件片段时请使用形如 [^F1-2] 的引用标记。",
            *sections,
        ]
    )


def format_cached_file_context(
    index: int,
    cached: dict[str, Any],
    query: str,
    *,
    char_budget: int = FILE_CONTEXT_CHAR_BUDGET,
) -> str:
    name = str(cached.get("name") or f"附件 {index}")
    kind = str(cached.get("kind") or "text")
    char_count = int(cached.get("charCount") or 0)
    cached_chunks = cached.get("chunks")
    chunks = cached_chunks if isinstance(cached_chunks, list) else []
    selected_indices = select_file_chunk_indices(chunks, query, char_budget=char_budget)
    selected_chunks = [chunks[i] for i in selected_indices if 0 <= i < len(chunks)]

    lines = [
        f"--- 文件 {index}: {name} ({kind}) ---",
        f"全文字符数：{char_count}；分块数：{len(chunks)}；本轮选取片段数：{len(selected_chunks)}。",
    ]

    if not selected_chunks:
        lines.append("[未找到可用文本片段]")
        return "\n".join(lines)

    used = 0
    for chunk in selected_chunks:
        text = str(chunk.get("text") or "").strip()
        if not text:
            continue
        remaining = char_budget - used
        if remaining <= 0:
            break
        if len(text) > remaining:
            text = text[:remaining].rstrip()
        used += len(text)
        chunk_index = int(chunk.get("index") or 0) + 1
        start = int(chunk.get("start") or 0)
        end = int(chunk.get("end") or start + len(text))
        lines.append(f"\n[{format_chunk_locator(chunk, chunk_index, len(chunks), start, end)}；引用ID F{index}-{chunk_index}]")
        lines.append(text)

    return "\n".join(lines)


def format_chunk_locator(chunk: dict[str, Any], chunk_index: int, total_chunks: int, start: int, end: int) -> str:
    parts = [f"片段 {chunk_index}/{total_chunks}", f"字符 {start}-{end}"]
    line_start = int(chunk.get("lineStart") or 0)
    line_end = int(chunk.get("lineEnd") or 0)
    if line_start > 0 and line_end >= line_start:
        parts.append(f"行 {line_start}-{line_end}")
    return "；".join(parts)


def select_file_chunk_indices(
    chunks: list[Any],
    query: str,
    *,
    char_budget: int = FILE_CONTEXT_CHAR_BUDGET,
) -> list[int]:
    if not chunks:
        return []

    total_chars = sum(len(str(chunk.get("text") or "")) for chunk in chunks if isinstance(chunk, dict))
    if total_chars <= min(FILE_FULL_CONTEXT_LIMIT, char_budget):
        return list(range(len(chunks)))

    tokens = query_tokens(query)
    broad = is_broad_file_query(query)
    scored: list[tuple[int, int]] = []
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            continue
        text = str(chunk.get("text") or "")
        score = hybrid_chunk_score(chunk, text, tokens, query)
        if score > 0:
            scored.append((score, index))

    scored.sort(key=lambda item: (-item[0], item[1]))

    chosen: list[int] = []
    chosen_set: set[int] = set()
    used = 0

    def add(index: int) -> bool:
        nonlocal used
        if index < 0 or index >= len(chunks):
            return True
        if index in chosen_set:
            return True
        chunk = chunks[index]
        if not isinstance(chunk, dict):
            return True
        text_len = len(str(chunk.get("text") or ""))
        if chosen and (used + text_len > char_budget or len(chosen) >= FILE_CONTEXT_MAX_CHUNKS):
            return False
        chosen.append(index)
        chosen_set.add(index)
        used += text_len
        return True

    if broad:
        add(0)
        step = max(1, len(chunks) // 6)
        for index in range(step, len(chunks), step):
            if not add(index):
                break

    for _, index in scored:
        if len(chosen) >= FILE_CONTEXT_MAX_CHUNKS or used >= char_budget:
            break
        add(index)
        add(index - 1)
        add(index + 1)

    if not chosen:
        step = max(1, len(chunks) // min(FILE_CONTEXT_MAX_CHUNKS, len(chunks)))
        for index in range(0, len(chunks), step):
            if not add(index):
                break

    return sorted(chosen)


def is_broad_file_query(query: str) -> bool:
    return re.search(
        r"(全文|全部|所有|整体|总结|概括|梳理|整理|分类|目录|大纲|这份|这个文件|附件|文档|试卷|题集|知识点|提取|summary|summarize|outline)",
        query,
        flags=re.IGNORECASE,
    ) is not None


def hybrid_chunk_score(chunk: dict[str, Any], text: str, tokens: list[str], query: str) -> int:
    keyword_score = score_chunk(text, tokens)
    query_vector = local_text_vector(query)
    chunk_vector = chunk.get("vector")
    vector_score = cosine_similarity(query_vector, chunk_vector if isinstance(chunk_vector, list) else local_text_vector(text))
    return int(keyword_score * 10 + vector_score * 100)


def local_text_vector(text: str) -> list[float]:
    """Small local semantic-ish vector using hashed words and CJK ngrams.

    This is deliberately dependency-free. It gives project documents a local
    vector index today and can be replaced by a model-backed embedding later.
    """

    vector = [0.0] * VECTOR_DIMENSIONS
    value = str(text or "").lower()
    features = query_tokens(value)
    for feature in features:
        digest = hashlib.blake2b(feature.encode("utf-8", errors="ignore"), digest_size=4).digest()
        number = int.from_bytes(digest, "big")
        index = number % VECTOR_DIMENSIONS
        sign = -1.0 if number & 1 else 1.0
        vector[index] += sign
    norm = sum(item * item for item in vector) ** 0.5
    if norm <= 0:
        return vector
    return [round(item / norm, 6) for item in vector]


def cosine_similarity(left: list[float], right: list[Any]) -> float:
    if not left or not right:
        return 0.0
    total = 0.0
    for left_value, right_value in zip(left, right):
        try:
            total += float(left_value) * float(right_value)
        except (TypeError, ValueError):
            continue
    return max(0.0, total)


def extract_uploaded_file(
    filename: str,
    content_type: str,
    data: bytes,
    *,
    ocr_enabled: bool | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    extension = Path(filename.lower()).suffix
    if not data:
        raise AppError(f"Uploaded file is empty: {filename}")

    if extension == ".docx":
        text = extract_docx_text(data)
        kind = "docx"
    elif extension == ".xlsx":
        text = extract_xlsx_text(data)
        kind = "xlsx"
    elif extension == PPTX_EXTENSION:
        text = extract_pptx_text(data)
        kind = "pptx"
    elif extension == EPUB_EXTENSION:
        text = extract_epub_text(data)
        kind = "epub"
    elif extension == ".pdf":
        text = extract_pdf_text(data, ocr_enabled=ocr_enabled)
        kind = "pdf"
    elif is_image_file(extension, content_type):
        text = extract_image_text(data, ocr_enabled=ocr_enabled)
        kind = "image"
    elif is_text_file(extension, content_type, data):
        text = extract_html_text(data) if extension in HTML_EXTENSIONS else decode_text_file(data)
        kind = extension.lstrip(".") or "text"
    else:
        raise AppError(
            "Unsupported file type. Use txt, md, csv, json, code files, docx, xlsx, pptx, epub, pdf, image, or text-based files.",
            code=ErrorCode.UNSUPPORTED_FILE,
            status=415,
        )

    text = normalize_extracted_text(text)
    if not text:
        raise AppError("No readable text found in this file", status=422)

    chunks = chunk_text(text)
    file_id = cache_file_chunks(filename, content_type, len(data), kind, text, chunks, source_bytes=data, project_id=project_id)

    return {
        "name": filename,
        "type": content_type,
        "size": len(data),
        "kind": kind,
        "fileId": file_id,
        "projectId": project_id or "",
        "text": text[:FILE_PREVIEW_CHARS].rstrip(),
        "preview": text[:FILE_PREVIEW_CHARS].rstrip(),
        "charCount": len(text),
        "chunkCount": len(chunks),
        "chunked": len(chunks) > 1,
        "truncated": False,
    }


def is_image_file(extension: str, content_type: str) -> bool:
    normalized_type = str(content_type or "").split(";", 1)[0].strip().lower()
    return extension in IMAGE_EXTENSIONS or normalized_type.startswith("image/")


def extract_image_text(data: bytes, *, ocr_enabled: bool | None = None) -> str:
    enabled = settings.ocr.enabled if ocr_enabled is None else ocr_enabled
    if not enabled:
        raise AppError(
            "Image OCR requires OCR to be enabled. Enable OCR and retry, or set OCR_ENABLED=1.",
            code=ErrorCode.OCR_REQUIRED,
            status=415,
        )
    return extract_image_ocr(data)


def chunk_text(text: str) -> list[dict[str, Any]]:
    if not text:
        return []

    chunks: list[dict[str, Any]] = []
    start = 0
    text_length = len(text)
    while start < text_length:
        end = min(start + FILE_CHUNK_CHARS, text_length)
        if end < text_length:
            boundary = max(text.rfind("\n\n", start, end), text.rfind("\n", start, end))
            if boundary > start + FILE_CHUNK_CHARS // 2:
                end = boundary
        chunk_body = text[start:end].strip()
        if chunk_body:
            chunks.append(
                {
                    "index": len(chunks),
                    "start": start,
                    "end": end,
                    "lineStart": text.count("\n", 0, start) + 1,
                    "lineEnd": text.count("\n", 0, end) + 1,
                    "text": chunk_body,
                    "vector": local_text_vector(chunk_body),
                }
            )
        if end >= text_length:
            break
        start = max(end - FILE_CHUNK_OVERLAP, start + 1)
    return chunks


def cache_file_chunks(
    filename: str,
    content_type: str,
    size: int,
    kind: str,
    text: str,
    chunks: list[dict[str, Any]],
    *,
    source_bytes: bytes,
    project_id: str | None = None,
) -> str:
    target_dir = project_file_cache_dir(project_id) if project_id else FILE_CACHE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    digest.update(filename.encode("utf-8", errors="ignore"))
    digest.update(b"\0")
    digest.update(len(source_bytes).to_bytes(8, "big"))
    digest.update(b"\0")
    digest.update(source_bytes)
    file_id = digest.hexdigest()[:32]
    payload = {
        "id": file_id,
        "name": filename,
        "type": content_type,
        "size": size,
        "kind": kind,
        "charCount": len(text),
        "chunkCount": len(chunks),
        "chunks": chunks,
    }
    final_path = target_dir / f"{file_id}.json"
    temp_path = target_dir / f"{file_id}.tmp"
    temp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp_path.replace(final_path)
    return file_id


def cleanup_file_cache() -> None:
    if not FILE_CACHE_DIR.exists():
        return

    try:
        files = sorted(FILE_CACHE_DIR.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    except OSError:
        return

    now = datetime.now().timestamp()
    total = 0
    for path in files:
        try:
            stat = path.stat()
        except OSError:
            continue

        age_days = (now - stat.st_mtime) / 86400
        if age_days > FILE_CACHE_MAX_AGE_DAYS or total + stat.st_size > FILE_CACHE_MAX_BYTES:
            try:
                path.unlink()
            except OSError:
                pass
            continue
        total += stat.st_size


def load_cached_file(file_id: str, project_id: str | None = None) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", file_id):
        raise AppError("Invalid file id", code=ErrorCode.INVALID_PAYLOAD, status=400)
    path = project_file_cache_dir(project_id) / f"{file_id}.json" if project_id else FILE_CACHE_DIR / f"{file_id}.json"
    if not path.exists():
        raise AppError("Uploaded file index has expired or is missing", code=ErrorCode.FILE_INDEX_EXPIRED, status=410)
    try:
        mtime_ns = path.stat().st_mtime_ns
    except OSError as exc:
        raise AppError("Uploaded file index is unreadable", code=ErrorCode.INTERNAL, status=500) from exc
    if project_id:
        return _load_cached_file_impl_from_path(path)
    return _load_cached_file_cached(file_id, mtime_ns)


@lru_cache(maxsize=64)
def _load_cached_file_cached(file_id: str, mtime_ns: int) -> dict[str, Any]:
    return _load_cached_file_impl(file_id)


def _load_cached_file_impl(file_id: str) -> dict[str, Any]:
    path = FILE_CACHE_DIR / f"{file_id}.json"
    return _load_cached_file_impl_from_path(path)


def _load_cached_file_impl_from_path(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AppError("Uploaded file index is unreadable", code=ErrorCode.INTERNAL, status=500) from exc
    if not isinstance(data, dict):
        raise AppError("Uploaded file index is invalid", code=ErrorCode.INTERNAL, status=500)
    return data


def project_file_cache_dir(project_id: str | None) -> Path:
    safe_id = str(project_id or "").strip()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{4,64}", safe_id):
        raise AppError("Invalid project id", code=ErrorCode.INVALID_PAYLOAD, status=400)
    return PROJECTS_DIR / safe_id / "files"


def is_text_file(extension: str, content_type: str, data: bytes) -> bool:
    if extension in TEXT_EXTENSIONS:
        return True
    if content_type.startswith("text/"):
        return True
    sample = data[:2048]
    return b"\0" not in sample


def decode_text_file(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract_html_text(data: bytes) -> str:
    parser = HTMLTextExtractor()
    parser.feed(decode_text_file(data))
    parser.close()
    return parser.text()


class HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if tag in {"p", "div", "section", "article", "header", "footer", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")
        if tag == "br":
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = html.unescape(data).strip()
        if text:
            self._parts.append(text)
            self._parts.append(" ")

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", "".join(self._parts))).strip()


def extract_epub_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            validate_zip_size(archive)
            entries = [
                name
                for name in archive.namelist()
                if name.lower().endswith((".xhtml", ".html", ".htm"))
                and not name.lower().endswith(("nav.xhtml", "toc.xhtml"))
            ]
            sections = []
            for name in sorted(entries):
                text = extract_html_text(safe_zip_read(archive, name))
                if text:
                    sections.append(f"[EPUB: {name}]\n{text}")
            return "\n\n".join(sections)
    except zipfile.BadZipFile as exc:
        raise AppError("Invalid epub file", status=422) from exc


def extract_pptx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            validate_zip_size(archive)
            slide_names = sorted(
                (name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml", name)),
                key=slide_sort_key,
            )
            slides = []
            for index, name in enumerate(slide_names, start=1):
                text = extract_presentation_xml_text(safe_zip_read(archive, name))
                if text:
                    slides.append(f"[PPTX 第 {index} 页]\n{text}")
            return "\n\n".join(slides)
    except zipfile.BadZipFile as exc:
        raise AppError("Invalid pptx file", status=422) from exc
    except (ET.ParseError, DefusedXmlException) as exc:
        raise AppError("Invalid pptx XML", status=422) from exc


def slide_sort_key(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def extract_presentation_xml_text(xml_bytes: bytes) -> str:
    root = ET.fromstring(xml_bytes)
    text_nodes = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] == "t" and node.text:
            text_nodes.append(node.text.strip())
    return "\n".join(part for part in text_nodes if part)


def validate_zip_size(archive: zipfile.ZipFile) -> None:
    total = 0
    compressed_total = 0
    for info in archive.infolist():
        total += info.file_size
        compressed_total += info.compress_size
        if info.file_size > MAX_ZIP_ENTRY_BYTES:
            raise AppError(f"File entry is too large: {info.filename}", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
    if total > MAX_ZIP_TOTAL_BYTES:
        raise AppError("Compressed document is too large after extraction", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
    if total > 0 and compressed_total <= 0:
        raise AppError("Compressed document has an unsafe compression ratio", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
    if compressed_total > 0 and total / compressed_total > MAX_ZIP_COMPRESSION_RATIO:
        raise AppError("Compressed document has an unsafe compression ratio", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)


def safe_zip_read(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise AppError(f"Missing file entry: {name}", status=422) from exc
    if info.file_size > MAX_ZIP_ENTRY_BYTES:
        raise AppError(f"File entry is too large: {name}", code=ErrorCode.UPLOAD_TOO_LARGE, status=413)
    return archive.read(name)


def extract_docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            validate_zip_size(archive)
            names = ["word/document.xml"]
            names.extend(sorted(name for name in archive.namelist() if re.match(r"word/(header|footer)\d+\.xml", name)))
            blocks = []
            for name in names:
                if name not in archive.namelist():
                    continue
                blocks.append(extract_word_xml_text(safe_zip_read(archive, name)))
            return "\n\n".join(block for block in blocks if block.strip())
    except zipfile.BadZipFile as exc:
        raise AppError("Invalid docx file", status=422) from exc
    except (ET.ParseError, DefusedXmlException) as exc:
        raise AppError("Invalid docx XML", status=422) from exc


def extract_word_xml_text(xml_bytes: bytes) -> str:
    root = ET.fromstring(xml_bytes)
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    body = root.find(namespace + "body")
    nodes = list(body) if body is not None else list(root)
    lines = []
    for node in nodes:
        local_name = node.tag.rsplit("}", 1)[-1]
        if local_name == "p":
            line = extract_word_paragraph_text(node)
            if line:
                lines.append(line)
        elif local_name == "tbl":
            table_text = extract_word_table_text(node)
            if table_text:
                lines.append(table_text)
    return "\n".join(lines)


def extract_word_paragraph_text(paragraph: ET.Element) -> str:
    parts = []
    for node in paragraph.iter():
        local_name = node.tag.rsplit("}", 1)[-1]
        if local_name == "t" and node.text:
            parts.append(node.text)
        elif local_name == "tab":
            parts.append("\t")
        elif local_name in {"br", "cr"}:
            parts.append("\n")
    return "".join(parts).strip()


def extract_word_table_text(table: ET.Element) -> str:
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    rows = []
    for row in table.iter(namespace + "tr"):
        cells = []
        for cell in row.iter(namespace + "tc"):
            paragraphs = [extract_word_paragraph_text(paragraph) for paragraph in cell.iter(namespace + "p")]
            text = " / ".join(part for part in paragraphs if part)
            cells.append(text)
        if any(cell.strip() for cell in cells):
            rows.append("\t".join(cells).rstrip())
    return "\n".join(rows)


def extract_xlsx_text(data: bytes) -> str:
    try:
        import openpyxl
    except ModuleNotFoundError:
        pass
    else:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                validate_zip_size(archive)
            workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except zipfile.BadZipFile as exc:
            raise AppError("Invalid xlsx file", status=422) from exc
        except AppError:
            raise
        except Exception as exc:
            raise AppError("Invalid xlsx file", status=422) from exc

        sheets = []
        for sheet in workbook.worksheets:
            rows = [f"Sheet: {sheet.title}"]
            for row in sheet.iter_rows():
                cells = []
                row_number = None
                for cell in row:
                    value = "" if cell.value is None else str(cell.value)
                    if value.strip():
                        row_number = row_number or cell.row
                        cells.append(f"{cell.coordinate}={value}")
                if cells:
                    prefix = f"行 {row_number}" if row_number is not None else "行"
                    rows.append(f"{prefix}\t" + "\t".join(cells))
            if len(rows) > 1:
                sheets.append("\n".join(rows))
        return "\n\n".join(sheets)

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            validate_zip_size(archive)
            shared_strings = read_xlsx_shared_strings(archive)
            sheet_entries = read_xlsx_sheet_entries(archive)
            sheets = []
            for index, (title, name) in enumerate(sheet_entries, start=1):
                text = read_xlsx_sheet(safe_zip_read(archive, name), shared_strings)
                if text.strip():
                    sheets.append(f"Sheet: {title or index}\n{text}")
            return "\n\n".join(sheets)
    except zipfile.BadZipFile as exc:
        raise AppError("Invalid xlsx file", status=422) from exc
    except (ET.ParseError, DefusedXmlException) as exc:
        raise AppError("Invalid xlsx XML", status=422) from exc


def read_xlsx_sheet_entries(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    fallback = sorted(name for name in archive.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", name))
    if "xl/workbook.xml" not in archive.namelist() or "xl/_rels/workbook.xml.rels" not in archive.namelist():
        return [(f"Sheet {index}", name) for index, name in enumerate(fallback, start=1)]

    main_namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel_namespace = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    package_rel_namespace = "{http://schemas.openxmlformats.org/package/2006/relationships}"

    rel_root = ET.fromstring(safe_zip_read(archive, "xl/_rels/workbook.xml.rels"))
    rels = {}
    for rel in rel_root.iter(package_rel_namespace + "Relationship"):
        rel_id = rel.attrib.get("Id", "")
        target = rel.attrib.get("Target", "")
        if not rel_id or not target:
            continue
        normalized = target.lstrip("/")
        if not normalized.startswith("xl/"):
            normalized = "xl/" + normalized
        rels[rel_id] = normalized

    workbook_root = ET.fromstring(safe_zip_read(archive, "xl/workbook.xml"))
    entries = []
    for sheet in workbook_root.iter(main_namespace + "sheet"):
        title = sheet.attrib.get("name", "")
        rel_id = sheet.attrib.get(rel_namespace + "id", "")
        path = rels.get(rel_id, "")
        if path in archive.namelist():
            entries.append((title, path))

    return entries or [(f"Sheet {index}", name) for index, name in enumerate(fallback, start=1)]


def read_xlsx_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(safe_zip_read(archive, "xl/sharedStrings.xml"))
    strings = []
    for item in root.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
        strings.append("".join(node.text or "" for node in item.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")))
    return strings


def read_xlsx_sheet(xml_bytes: bytes, shared_strings: list[str]) -> str:
    root = ET.fromstring(xml_bytes)
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rows = []
    for row in root.iter(namespace + "row"):
        cells = []
        for cell in row.iter(namespace + "c"):
            cell_ref = cell.attrib.get("r", "")
            cell_type = cell.attrib.get("t")
            value = ""
            if cell_type == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(namespace + "t"))
            else:
                value_node = cell.find(namespace + "v")
                if value_node is not None and value_node.text is not None:
                    value = value_node.text
                    if cell_type == "s":
                        try:
                            value = shared_strings[int(value)]
                        except (ValueError, IndexError):
                            pass
            if value.strip():
                cells.append(f"{cell_ref}={value}" if cell_ref else value)
        if any(cell.strip() for cell in cells):
            row_ref = row.attrib.get("r", "")
            prefix = f"行 {row_ref}\t" if row_ref else ""
            rows.append(prefix + "\t".join(cells).rstrip())
    return "\n".join(rows)


def extract_pdf_text(data: bytes, *, ocr_enabled: bool | None = None) -> str:
    try:
        return _extract_pdf_text_native(data)
    except AppError as exc:
        if exc.code != ErrorCode.PDF_NO_SELECTABLE_TEXT:
            raise

    enabled = settings.ocr.enabled if ocr_enabled is None else ocr_enabled
    if not enabled:
        raise AppError(
            "Scanned/image-only PDF requires OCR. Enable OCR and retry, or convert it to selectable text first.",
            code=ErrorCode.OCR_REQUIRED,
            status=422,
        )
    return extract_pdf_ocr(data)


def _extract_pdf_text_native(data: bytes) -> str:
    no_text_error: AppError | None = None
    parse_error: Exception | None = None
    for module_name in ("pypdf", "PyPDF2"):
        try:
            module = __import__(module_name)
            reader = module.PdfReader(io.BytesIO(data))
            pages = []
            for page_index, page in enumerate(reader.pages, start=1):
                page_text = page.extract_text() or ""
                if page_text.strip():
                    pages.append(f"[PDF 第 {page_index} 页]\n{page_text.strip()}")
            if pages:
                return "\n\n".join(pages)
            raise AppError(
                "No selectable text found in this PDF. It may be a scanned/image-only PDF and needs OCR.",
                code=ErrorCode.PDF_NO_SELECTABLE_TEXT,
                status=422,
            )
        except ModuleNotFoundError:
            continue
        except AppError as exc:
            if exc.code == ErrorCode.PDF_NO_SELECTABLE_TEXT:
                no_text_error = exc
                continue
            raise
        except Exception as exc:
            parse_error = exc
            continue
    if no_text_error is not None:
        raise no_text_error
    if parse_error is not None:
        raise AppError("Could not extract text from this PDF", status=422) from parse_error
    raise AppError("PDF parsing is not available in this Python environment. Convert it to txt, md, docx, or xlsx first.", status=415)


def normalize_extracted_text(value: str) -> str:
    text = value.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip()
