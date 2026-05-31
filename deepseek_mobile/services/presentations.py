"""Generate downloadable .pptx decks from a structured outline.

Exposed to the model as the ``create_pptx`` function-calling tool: the model
passes a title and a list of slides, we render a real PowerPoint file into
``.generated/{id}.pptx`` and hand back a ``downloadUrl`` the model surfaces to
the user as a Markdown link. No frontend changes needed — the chat renderer
already turns Markdown links into clickable anchors.
"""

from __future__ import annotations

import re
import secrets
import time
from pathlib import Path
from typing import Any

from deepseek_mobile.core.config import GENERATED_DIR
from deepseek_mobile.core.errors import AppError, ErrorCode

GENERATED_FILE_MAX_AGE_SECONDS = 6 * 3600  # 生成文件保留 6 小时后清理
MAX_SLIDES = 60
MAX_BULLETS_PER_SLIDE = 24
_ID_RE = re.compile(r"[0-9a-f]{32}")


def _safe_filename(title: str) -> str:
    name = re.sub(r"[^\w一-鿿 -]", "", str(title or "")).strip()
    return (name[:60] or "presentation")


def cleanup_generated_files() -> None:
    """删除过期的生成文件。任何 IO 异常都静默吞掉，不影响主流程。"""
    try:
        if not GENERATED_DIR.exists():
            return
        now = time.time()
        for path in GENERATED_DIR.glob("*.pptx"):
            try:
                if now - path.stat().st_mtime > GENERATED_FILE_MAX_AGE_SECONDS:
                    path.unlink(missing_ok=True)
            except OSError:
                continue
    except OSError:
        pass


def resolve_generated_file(file_id: str) -> Path | None:
    """把下载请求的 id 解析成磁盘路径；只接受 32 位十六进制 id，杜绝路径遍历。"""
    if not _ID_RE.fullmatch(str(file_id or "")):
        return None
    path = GENERATED_DIR / f"{file_id}.pptx"
    return path if path.is_file() else None


def _normalize_bullets(item: dict[str, Any]) -> list[str]:
    bullets = item.get("bullets")
    if isinstance(bullets, list):
        return [str(b).strip() for b in bullets if str(b).strip()]
    content = str(item.get("content") or "").strip()
    if content:
        return [line.strip() for line in content.splitlines() if line.strip()]
    return []


def create_presentation(title: str, slides: Any, *, subtitle: str = "") -> dict[str, Any]:
    """根据大纲生成 .pptx，返回包含 downloadUrl 的结果字典。"""
    try:
        from pptx import Presentation
    except ModuleNotFoundError as exc:
        raise AppError(
            "PPT 生成需要 python-pptx，请先安装：pip install python-pptx",
            code=ErrorCode.INVALID_PAYLOAD,
        ) from exc

    title = str(title or "").strip()
    if not title:
        raise AppError("演示文稿需要一个标题（title）。", code=ErrorCode.INVALID_PAYLOAD)
    if not isinstance(slides, list) or not slides:
        raise AppError("演示文稿至少需要一页内容（slides）。", code=ErrorCode.INVALID_PAYLOAD)

    prs = Presentation()

    # 封面页
    cover = prs.slides.add_slide(prs.slide_layouts[0])
    if cover.shapes.title is not None:
        cover.shapes.title.text = title[:200]
    subtitle = str(subtitle or "").strip()
    if subtitle and len(cover.placeholders) > 1:
        cover.placeholders[1].text = subtitle[:300]

    # 内容页（标题 + 项目符号布局）
    bullet_layout = prs.slide_layouts[1]
    content_pages = 0
    for item in slides[:MAX_SLIDES]:
        if not isinstance(item, dict):
            continue
        slide = prs.slides.add_slide(bullet_layout)
        if slide.shapes.title is not None:
            slide.shapes.title.text = (str(item.get("title") or "").strip() or f"第 {content_pages + 1} 页")[:200]
        bullets = _normalize_bullets(item)
        if len(slide.placeholders) > 1:
            frame = slide.placeholders[1].text_frame
            frame.clear()
            first = True
            for bullet in bullets[:MAX_BULLETS_PER_SLIDE]:
                para = frame.paragraphs[0] if first else frame.add_paragraph()
                para.text = bullet[:500]
                first = False
        content_pages += 1

    if content_pages == 0:
        raise AppError("没有解析到有效的幻灯片内容。", code=ErrorCode.INVALID_PAYLOAD)

    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_generated_files()
    file_id = secrets.token_hex(16)
    prs.save(str(GENERATED_DIR / f"{file_id}.pptx"))

    return {
        "fileId": file_id,
        "filename": f"{_safe_filename(title)}.pptx",
        "slideCount": content_pages + 1,
        "downloadUrl": f"/api/download?id={file_id}",
        "note": (
            "PPT 已生成。请在最终回复中用 Markdown 链接把 downloadUrl 提供给用户，"
            "例如 [下载 PPT](downloadUrl)。下载链接 6 小时内有效。"
        ),
    }
