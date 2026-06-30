# Skill System

Applicable version: v2.6.2.

DeepSeek Infra v2.6.2 defines a Skill as:

```text
Skill = Prompt + Tools + Input Schema + Output Schema + Memory Policy + Artifact Policy + Project Binding
```

A Skill is not just a prompt template. It has an explicit tool grant, validates input and output, can bind to a project, and can persist outputs into the local workspace.

## Layout

```text
deepseek_infra/infra/skills/
  schema.py        # Skill config and input/output schema validation
  registry.py      # built-in + custom Skill registry
  permissions.py   # Skill allowedTools -> ToolPolicy
  runner.py        # Skill execution and project/artifact persistence
  templates.py     # prompt and offline output helpers
  evidence.py      # Skill artifact index and release evidence

skills/builtin/
  document_reader.json
  research_brief.json
  paper_writer.json
  ppt_generator.json
  code_review.json
  study_tutor.json
```

User-created Skills are stored in runtime state under `.skills/custom/` and must not be committed.

## Registry

The registry supports listing built-in and custom Skills, creating and editing custom Skills, disabling or deleting Skills, importing and exporting Skill JSON, and validating policies.

HTTP entrypoint:

```text
POST /api/skills
POST /api/skills/{skill_id}/run
```

Common actions: `list`, `builtin`, `get`, `create`, `update`, `disable`, `enable`, `delete`, `import`, `export`, `run`.

## Runner

The Skill Runner flow is:

```text
select Skill
  -> validate inputSchema
  -> load project context when projectBinding.enabled
  -> inject systemPrompt + Skill contract
  -> pass allowedTools into the existing Tool Policy path
  -> run LLM/tool loop or offline smoke path
  -> validate outputSchema
  -> save Skill output, artifacts, project history, and evidence metadata
```

The runner never bypasses Tool Policy. `allowedTools` narrows the tools included in the DeepSeek payload and also narrows the `ToolPolicy` grant used by execution.

## Project Binding

Project Skill state is stored in `.projects/<projectId>/project.json`:

```json
{
  "skills": {
    "enabledSkills": ["skill_study_tutor"],
    "defaultSkill": "skill_study_tutor",
    "recentSkills": ["skill_research_brief"]
  },
  "skillRuns": [],
  "savedItems": [],
  "artifacts": []
}
```

Project export includes Skill bindings, Skill run history, saved Skill outputs, and Skill artifact metadata.

## Skill Workbench UI

v2.6.2 adds a local Skill Workbench in the main Web UI:

- Open the `Skills` entry in the sidebar to browse built-in and custom Skills.
- Use the workbench toolbar to search, import Skill JSON, export custom Skills, and enable or disable custom Skills.
- Select `Run` on a Skill to open the Skill Run Panel. The panel maps `inputSchema.properties` into form controls, marks required fields, and submits `projectId`, `offline`, and `persist` parameters through the Skill Web API.
- Open a project to manage `enabledSkills`, `defaultSkill`, and `recentSkills`. Skill runs submitted with a project id update project history and preserve Skill-produced saved items and artifacts.
- After a run, the result preview displays output content, `skillRunId`, linked Saved Items, and linked Artifacts so the output is managed as Workspace data instead of only chat text.

Frontend integration files:

```text
static/index.html
static/modules/skills.js
static/modules/chat.js
static/styles.css
```

## Evidence

Run the local offline checks:

```bash
python scripts/smoke_skills.py --offline
python scripts/smoke_skills_ui.py --offline
python evals/runners/run_skill_eval.py --strict
```

The release evidence file is `docs/evidence/skills-v2.6.2.json`.
The Skill Workbench UI evidence file is `docs/evidence/skills-ui-v2.6.2.json`.

Required checks: `skillApiRoutes`, `builtinSkillsLoad`, `customSkillCreate`, `inputSchemaValidation`, `toolPermissionGate`, `artifactPolicy`, `projectBinding`, and `skillExport`.
