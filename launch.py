"""Double-clickable entry point.

Without arguments this opens the GUI launcher. When the bundled PyInstaller
executable re-invokes itself with ``--server`` (see
``deepseek_mobile.launcher.runtime.server_command``) it runs the HTTP server
inside the same one-file binary instead of opening a window.
"""

from __future__ import annotations

import sys


def main() -> None:
    if "--server" in sys.argv[1:]:
        from deepseek_mobile.app import main as run_server

        run_server()
        return
    from deepseek_mobile.launcher.gui import main as run_gui

    run_gui()


if __name__ == "__main__":
    main()
