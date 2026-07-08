---
name: aiteam-create-tasks
description: Create tasks in an aiTeam project's task board (markdown files at `<project>/.aiteam/tasks/<slug>.md`). Triggers on "create a task", "add task", "add tasks", "populate the tasks", "make these tasks", "task breakdown", "create tasks for X", or any time the user hands you an outline / numbered list / checklist they want saved as real tasks in a project. Single tasks or batches.
user-invocable: false
---

# Creating aiTeam tasks

Tasks are plain markdown files at `<project_root>/.aiteam/tasks/<slug>.md`. The aiTeam dashboard at `{{AITEAM_DIR}}/app` reads them on every page load. Agents (you and Maya/Devin/Casey) read and write them with normal file tools — there is no special API needed.

## When to use this skill

The user is asking you to:
- **Create a single task** for a project ("add a task to my-app: refresh the hero")
- **Create a batch of tasks** from an outline / numbered list / checklist the user paste in
- **Populate the task board** for a project that's empty or sparse
- **Convert a brainstorm into actual tasks** ("turn this into tasks")

## Where to write

The target directory is always `<project_root>/.aiteam/tasks/`.

- If you're running inside the dashboard chat for a project, your CWD is already that project root → write to `./.aiteam/tasks/<slug>.md`
- If the user names a different project ("add to my-app"), the path is `{{PROJECTS_ROOT}}/<project>/.aiteam/tasks/<slug>.md`
- If the user is in the Dashboard (no specific project) chat asking to create tasks "for project X", target X — do NOT default to the aiTeam project unless they explicitly say so

If the project root is ambiguous, ask once: *"Add to current project, or another?"*

## File format

Each task is one markdown file with YAML frontmatter:

```yaml
---
id: t-<8-char hex>
title: Short action-oriented title (no leading numbers)
assignee: Devin       # Maya | Devin | Casey | {{OWNER_FIRST}} | null
status: todo          # todo | in-progress | blocked | done
priority: medium      # low | medium | high
due: null             # YYYY-MM-DD or null
created: 2026-05-13T04:51:35.713Z
updated: 2026-05-13T04:51:35.713Z
---

Description in markdown. Preserve the user's notes / rationale — the assignee will rely on it.
```

## Defaults if the user didn't specify

- **assignee** — infer from domain when possible:
  - Maya → visual design, image generation, brand consistency
  - Devin → frontend code, build scripts, HTML/CSS, performance
  - Casey → blog copy, landing-page copy, email sequences
  - Otherwise: `null` (unassigned) or `{{OWNER_FIRST}}` if it's clearly a human-decision task
- **status** — `todo`
- **priority** — `medium`. Use `high` for blocking/critical/discovery tasks; `low` for polish or contingent items
- **due** — `null` unless the user specified a date

## Filename slug rules

Lowercase the title. Strip everything except `a-z`, `0-9`, spaces, and dashes. Collapse spaces to single dashes. Cap at 60 characters. If the file already exists, append `-2`, `-3`, etc.

Examples:
- `"Recon the payments API surface"` → `recon-the-payments-api-surface.md`
- `` "Implement `projects list`" `` → `implement-projects-list.md`
- `"go build + install to local bin"` → `go-build-install-to-local-bin.md`

## Generating IDs and timestamps

- **id** — 8 random hex chars prefixed with `t-`. Example: `t-a1b2c3d4`. Any unique short hash works.
- **created / updated** — ISO 8601 UTC timestamp. On first write they're equal.

In Bash: `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` and `head -c8 /dev/urandom | xxd -p` (or any equivalent).
In PowerShell: `(Get-Date -AsUTC).ToString("o")` and `[guid]::NewGuid().ToString().Substring(0,8)`.

## Workflow

1. **Confirm target project** if ambiguous (one short clarifying question, then proceed).
2. **Ensure the directory exists** — `<project>/.aiteam/tasks/` (create it if missing — `mkdir -p` or equivalent).
3. **Generate each task file** with the Write tool, one per task.
4. **Report back** with a short summary: `"Created N tasks in <project>: <bulleted list of titles>"`. Don't dump the file contents — the user can see them in the dashboard's Tasks tab.

## Don'ts

- Don't put leading numbers in titles (`"1. Foo"`) — ordering comes from priority/status grouping in the UI, not from the title.
- Don't write outside the target project's `.aiteam/tasks/` folder.
- Don't include attachment fields — the schema doesn't have them. If a task references a file, mention the path in the description.
- Don't modify existing tasks with this skill — that's a separate update flow (just edit the file directly).
- Don't ask for clarification on every field. Apply defaults and move on; the user can tweak in the dashboard.

## Example interaction

**User:** "Add 3 tasks to my-app, all assigned to Maya: refresh the hero image, design a comparison table, build the email opt-in mockup"

**You:**
1. mkdir -p `{{PROJECTS_ROOT}}/my-app/.aiteam/tasks` (if missing)
2. Write `refresh-the-hero-image.md` (assignee: Maya, priority: medium, status: todo)
3. Write `design-a-comparison-table.md` (same)
4. Write `build-the-email-opt-in-mockup.md` (same)
5. Reply: *"Created 3 tasks in my-app, all assigned to Maya: refresh-the-hero-image, design-a-comparison-table, build-the-email-opt-in-mockup."*

## When NOT to use this skill

- The user is asking *about* tasks (status, who's assigned, what's due) — that's a read flow; just `ls` the tasks dir and parse the frontmatter
- The user is updating an existing task — directly edit the file
- The user is using the in-chat dashboard's "+ New task" button — that goes through the API, no skill needed
