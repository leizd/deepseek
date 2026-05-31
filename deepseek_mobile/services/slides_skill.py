"""Slides skill guidance for local presentation generation.

The desktop app cannot execute Codex skills directly inside DeepSeek, so this
module keeps the user-provided slides skill as promptable runtime guidance and
routes the actual export through the local ``create_pptx`` tool.
"""

from __future__ import annotations

SLIDES_SKILL_NAME = "slides"
SLIDES_SKILL_DESCRIPTION = (
    "Build, edit and export PowerPoint-style presentations with pptxgenjs or "
    "artifact tool library. Use when creating or modifying presentations or "
    "other visual aids like charts, posters etc."
)

SLIDES_SKILL_REFERENCE = """---
name: slides
description: Build, edit and export PowerPoint-style presentations with pptxgenjs or artifact tool library. Use when creating or modifying presentations or other visual aids like charts, posters etc.,
---

# Slides Skill

Use this skill as reference material when creating or editing presentation slide decks.

## Skill Folder Contents

Contents of the `slides/` skill folder:

- `container_tools/`: Standalone python scripts for slides and relevant asset manipulation.
- `artifact_tool/`: API documentation and coding examples for the artifact tool library.
- `pptxgenjs_helpers/`: JavaScript helpers for PptxGenJS.

## Implementation

You may choose whichever approach you think works best for this task. If it helps, feel free to use a template from the `slide_templates` folder (optional)."""

SLIDES_RUNTIME_GUIDANCE = """DeepSeek Mobile runtime routing:
- Treat user requests to create, modify, export, or polish PPT / PPTX / slides / presentations / posters / visual aids as the `slides` skill.
- For PowerPoint output in this app, the available local export boundary is the `create_pptx` function tool. Call it to create a real downloadable `.pptx`; do not answer with only an outline, Marp, Markdown slides, or a refusal about lacking file-generation ability.
- Build a concrete deck spec before calling the tool: concise title, optional subtitle, and ordered slides. Use slide titles as claims or clear section labels, and keep bullets short enough to fit on slides.
- If the user supplies source material, convert it into editable slide content instead of summarizing the source as prose.
- In the final reply, include the returned Markdown download link and a brief slide inventory."""


def format_slides_skill_context() -> str:
    return f"[Skill: {SLIDES_SKILL_NAME}]\n{SLIDES_SKILL_REFERENCE}\n\n{SLIDES_RUNTIME_GUIDANCE}"
