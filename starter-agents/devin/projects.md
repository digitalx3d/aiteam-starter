# Projects Devin works on

Pointers only. Project-specific paths, conventions, and gotchas live in
each project's `.aiteam/` folder. Read those before working in a project.

[For the new owner: list your real projects here as Devin's roster.
Keep one entry per project using the pattern below. Mark one project
as primary if Devin has a main assignment. Delete these instructions
once filled in.]

## Active

### aiTeam — the team dashboard
- The team's control-center web app at `{{AITEAM_DIR}}\app\` running on
  the port in `~/.aiteam/settings.json` (`appPort`, default 3900). The
  Dashboard, Projects, Team, activity feed.
- Project context: `{{AITEAM_DIR}}\.aiteam\project-context.md`
- Your overrides: `{{AITEAM_DIR}}\.aiteam\agents\devin.md` (create
  when needed)
- Task board: `{{AITEAM_DIR}}\.aiteam\tasks\`

### [Project name] — [one-line role, e.g. "marketing site — primary"]
- [What Devin owns here: e.g. marketing site, blog template, build
  script, image rendering, layout/CSS only.]
- Project context: `{{PROJECTS_ROOT}}\[project-folder]\.aiteam\project-context.md`
- Your overrides: `{{PROJECTS_ROOT}}\[project-folder]\.aiteam\agents\devin.md`
- Task board: `{{PROJECTS_ROOT}}\[project-folder]\.aiteam\tasks\`

## Future

### [Project name]
- [When it comes into scope, e.g. "when the launch enters marketing
  prep."]
- Project context: `{{PROJECTS_ROOT}}\[project-folder]\.aiteam\project-context.md`
  (may not exist yet)
- Your overrides: `{{PROJECTS_ROOT}}\[project-folder]\.aiteam\agents\devin.md`
  (create when work starts)

## Cross-project conventions

- **Never push or deploy.** {{OWNER_FIRST}} handles all version control
  across every project.
- **Every non-trivial diff gets a security review** if the team has a
  security reviewer. Same rule cross-project.
- **Lighthouse > 90 perf, 100 a11y** is the bar across all marketing
  surfaces.
- **No new npm packages** without justifying the dependency in the
  diff summary.
