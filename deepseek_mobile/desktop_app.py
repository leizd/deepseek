"""Native desktop shell that embeds the local app in a WebView window."""

from __future__ import annotations

import logging
import sys
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from deepseek_mobile.app import ServerHandle, prepare_and_start, shutdown_handle

APP_TITLE = "DeepSeek Mobile"
DEFAULT_WIDTH = 1180
DEFAULT_HEIGHT = 820
MIN_WIDTH = 760
MIN_HEIGHT = 520

logger = logging.getLogger("deepseek_mobile.desktop_app")


def main() -> int:
    handle: ServerHandle | None = None
    try:
        handle = prepare_and_start(host="127.0.0.1", serve=True)
        open_app_window(webview_entry_url(handle.computer_url))
        return 0
    except Exception as exc:
        logger.exception("desktop_app_failed")
        show_startup_error(exc)
        return 1
    finally:
        if handle is not None:
            shutdown_handle(handle)


def webview_entry_url(url: str) -> str:
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    if not any(key == "desktop" for key, _ in query):
        query.append(("desktop", "1"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))


def open_app_window(url: str) -> None:
    try:
        import webview
    except ModuleNotFoundError as exc:
        raise RuntimeError("Desktop WebView dependency is missing. Install pywebview or rebuild the app package.") from exc

    webview.create_window(
        APP_TITLE,
        url,
        width=DEFAULT_WIDTH,
        height=DEFAULT_HEIGHT,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
    )
    webview.start(debug=False, private_mode=False)


def show_startup_error(exc: BaseException) -> None:
    if sys.stderr is not None:
        print(f"DeepSeek Mobile failed to start: {exc}", file=sys.stderr)
        return

    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        return

    root: Any = None
    try:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("DeepSeek Mobile", f"DeepSeek Mobile failed to start:\n{exc}")
    finally:
        if root is not None:
            root.destroy()


if __name__ == "__main__":
    raise SystemExit(main())
