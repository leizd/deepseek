# Design QA

final result: blocked

Date: 2026-06-04 10:31:18 +08:00

Reference: user-provided Doubao document reader screenshot in this thread.
Prototype target: http://127.0.0.1:8000/

Current iteration:
- Implemented DeepSeek-branded document reader translation menus for selected text, text-layer actions, screenshot-region actions, and the top PDF toolbar "translate full document" control.
- Verified source and served assets for the new menu markers.
- Verified automated checks: JavaScript syntax, diff whitespace, and encoding regression tests.

Blocked gate:
- The in-app browser could not initialize for screenshot capture and visual comparison.
- Runtime error seen during capture attempt: `windows sandbox failed: spawn setup refresh`.

Unverified visual items:
- Pixel-level alignment with the Doubao screenshot.
- Open-state placement of the new translation menus.
- Full interactive screenshot comparison for desktop viewport.
