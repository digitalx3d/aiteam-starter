# Projects CVB orchestrates

CVB is cross-project by nature. Every active project is in scope for
dispatch, sequencing, and status. This file lists the projects and
their pointers; project state lives in the vault and in each project's
`.aiteam/project-context.md`.

## Active

### aiTeam — the team home
- The dashboard, the tooling, and the team's own infrastructure.
- Project context: `{{AITEAM_DIR}}\.aiteam\project-context.md`
- Your overrides: `{{AITEAM_DIR}}\.aiteam\agents\claude.md` (create
  when needed)
- Vault overview: `{{VAULT_DIR}}\projects\aiteam.md`
- Task board: `{{AITEAM_DIR}}\.aiteam\tasks\`

[Add one section per active project, using this template. Delete this
instruction block once you've filled in your real projects.]

### <ProjectFolderName> (<friendly name, if different>)
- [One line: what it is and its current state, e.g. "Live with early
  users; marketing push next" or "Pre-launch; landing page in
  progress."]
- Project context: `{{PROJECTS_ROOT}}\<ProjectFolderName>\.aiteam\project-context.md`
- Your overrides: `{{PROJECTS_ROOT}}\<ProjectFolderName>\.aiteam\agents\claude.md`
- Vault overview: `{{VAULT_DIR}}\projects\<slug>.md`
- Task board: `{{PROJECTS_ROOT}}\<ProjectFolderName>\.aiteam\tasks\`

## Held-back

[List projects that exist but are deliberately out of active scope —
they come into scope only when {{OWNER_FIRST}} greenlights them.]

## Cross-project conventions

- **`inbox-shared.md`** lives in aiTeam (`{{AITEAM_DIR}}\inbox-shared.md`)
  and is the team's bulletin board for messages to {{OWNER_FIRST}}.
  Cross-project by design.
- **Vault decisions** apply across all projects unless explicitly
  scoped via `project:` frontmatter.

## You own project-context.md creation

When a project listed above does not yet have `.aiteam/project-context.md`,
you create it. Two triggers:

1. **Before your first dispatch into that project.** Subagents'
   activation procedure reads `<project>/.aiteam/project-context.md`
   at step 6. If it doesn't exist, they have no project context to
   work from. Create the file first; then send the brief.
2. **Proactively when a project enters active scope.** When
   {{OWNER_FIRST}} says a project is about to become active (e.g., a
   pre-launch app entering its marketing prep), draft the
   project-context from `{{VAULT_DIR}}\projects\<name>.md` and tailor
   it for in-repo agent consumption.

If the project repo lacks the `.aiteam/` folder entirely, scaffold
it: `.aiteam/project-context.md`, `.aiteam/agents/`, `.aiteam/tasks/`.

Subagents do NOT create project-context.md themselves. If a subagent
flags a missing project-context in `inbox-shared.md`, that's your
trigger to write it.
