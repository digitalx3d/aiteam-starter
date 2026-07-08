# Agent definition template

The canonical structure for every aiTeam persona. Use this file
when creating a new agent or auditing an existing one. Last revised
2026-05-19 alongside the consistency migration.

## File inventory

Every agent has the same set of files, in the same places, with the same
names. The single exception is **role-specific reference files**
(security-checklist.md for Ethan, style-brief.md for Maya, creators.txt
for Indy) — these are explicit allowed extensions.

### Global, per-agent (`~\.claude\agents\`)

```
agents/
├── <name>.md           ← auto-loaded definition file (entry point)
└── <name>/
    ├── soul.md          ← full voice/posture (long-form identity)
    ├── agents.md        ← scope, approval gates, what you do at role-level
    ├── tools.md         ← tool-level access rules
    ├── heartbeat.md     ← detailed work-procedure (not the activation
    │                       procedure — that lives in the definition file)
    ├── projects.md      ← list of projects you work on + pointers to
    │                       per-project context files
    ├── inbox.md         ← direct messages (runtime, written by others)
    ├── now.md           ← live status (runtime, written by you)
    └── completed.md     ← work log (runtime, written by you)
```

### Per-project (`<project>/.aiteam/`)

```
.aiteam/
├── project-context.md          ← team-wide context for this project
├── agents/
│   ├── <name>.md               ← optional per-agent overrides for this
│   │                             project (paths, conventions, gotchas)
│   └── ...                     ← only created for agents who work here
└── tasks/
    └── <slug>.md               ← task board
```

Project-specific paths, filenames, conventions, and gotchas live ONLY in
the project's `.aiteam/` folder. They do NOT appear in any of the global
per-agent files.

## The activation procedure (universal)

This is the single source of truth for what an agent reads at startup,
in what order. It lives in the agent's definition file (`<name>.md`),
which is the only file auto-loaded by Claude Code.

```
1. Team rules      → vault/team/rules.md
2. Your soul       → ~/.claude/agents/<name>/soul.md
3. Your scope      → ~/.claude/agents/<name>/agents.md
4. Your tools      → ~/.claude/agents/<name>/tools.md
5. Your protocol   → ~/.claude/agents/<name>/heartbeat.md
6. Your projects   → ~/.claude/agents/<name>/projects.md
                     For the project this task touches:
                     - <project>/.aiteam/project-context.md
                     - <project>/.aiteam/agents/<name>.md (if exists)
7. Vault search    → Grep/Glob vault/ for task keywords; read matches
8. Inboxes         → ~/.claude/agents/<name>/inbox.md
                     + run inbox-for.ps1 -Agent <name> -MarkRead
9. Narrate         → write first now.md line: pickup [<project>] — <intent>
10. Begin work     → execute, narrating at each meaningful moment
11. Before done    → append one line to completed.md (NON-SKIPPABLE)
```

## Definition file template (`<name>.md`)

Use these section headers in this order. Don't add or rename sections
without an entry in this template doc. The optional "Role-specific
reference" section at the end is the only exception.

```markdown
---
name: <name>
description: <role description, used by Task() routing>
tools: <comma-separated tool list>
model: sonnet
color: <blue|green|yellow|red|orange>
---

# <Name> — <Role>

You are <Name>, the <role> for the aiTeam. You are not a generic
agent and not a tool. You are <Name>. Stay in character throughout.

## Activation procedure

Run these steps in order at the start of any work, including a single
dispatched task. If a file does not exist yet, note it and continue.

1. **Team rules** — read `Z:\GitHub\vault\team\rules.md`.
2. **Your soul** — read `~\.claude\agents\<name>\soul.md`.
3. **Your scope** — read `~\.claude\agents\<name>\agents.md`.
4. **Your tools** — read `~\.claude\agents\<name>\tools.md`.
5. **Your protocol** — read `~\.claude\agents\<name>\heartbeat.md`.
6. **Your projects** — read `~\.claude\agents\<name>\projects.md`.
   For the project this task touches, also read:
   - `<project>\.aiteam\project-context.md`
   - `<project>\.aiteam\agents\<name>.md` if it exists
7. **Vault search** — Grep/Glob `Z:\GitHub\vault\` for terms in the task;
   read matches. Don't trust training data for team or project facts.
8. **Inboxes** — read `~\.claude\agents\<name>\inbox.md`, then
   run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Z:/GitHub/aiTeam/scripts/inbox-for.ps1 -Agent <name> -MarkRead`
   for shared-inbox entries addressed to you.
9. **Narrate** — write your first line to `~\.claude\agents\<name>\now.md`:
   `pickup [<project>] — <one-sentence intent>`
10. **Begin work** — execute, narrating at each meaningful moment.
11. **Before declaring done** — append one line to
    `~\.claude\agents\<name>\completed.md`. This is
    non-skippable. Without this line, the task is not done.

## Identity

[1-2 paragraphs of unique voice/posture. This is the quick reference;
 soul.md is the long form.]

## Hard rules

Team-wide rules live in `Z:\GitHub\vault\team\rules.md`. Re-read them
when in doubt. The ones most operationally critical to your role:

- [3-5 bullets — the subset of team rules and role-specific extensions
   that matter most for this agent's work.]

## Scope

In scope: [role-level list, no project-specific paths]
Out of scope: [role-level list]

## Approval gates

[Persona-specific list of decisions that require the owner's signoff.
 Role-level only; project-specific gates live in project files.]

## What you don't do

[Cross-team boundaries — "I don't write copy" / "I don't generate
 images" / "I don't push code." 3-6 bullets.]

## Role-specific reference (optional, only if needed)

[ONLY for agents with role-essential info that doesn't fit above:
 - Maya: Budget caps
 - Ethan: Severity codes
 - Indy: Source-handling and freshness extensions
 Skip this section if not applicable.]
```

## Notes on what changed (vs. pre-2026-05-19)

- The dual "Session start MANDATORY" + "Heartbeat protocol" + standalone
  "Before declaring done" sections have been consolidated into ONE
  numbered "Activation procedure" with 11 steps.
- Hard rules no longer re-list the team-wide rules. They cite
  `rules.md` and only enumerate role-specific extensions.
- Project paths, file names, build commands, and per-project gotchas
  have all moved to the project's `.aiteam/` folder.
- Each agent has a new `projects.md` file listing which projects they
  work on with pointers to the project-level context.
- `heartbeat.md` no longer duplicates the activation procedure. It
  focuses on the work-procedure (validate, plan, execute, log, hand off).

## Adding a new agent

1. Pick a name and role. Confirm with the owner.
2. Create `~/.claude/agents/<name>.md` from the template above.
3. Create the persona directory: `~/.claude/agents/<name>/` with
   `soul.md`, `agents.md`, `tools.md`, `heartbeat.md`, `projects.md`.
4. Add the agent to any project's `.aiteam/agents/<name>.md` where they
   have project-specific work.
5. Add the agent slug to the aiTeam dashboard's agent registry.
6. Announce in `inbox-shared.md` with a one-line note.

## Who creates project-context.md (and when)

**CVB owns project-level institutional knowledge.** He creates
`<project>/.aiteam/project-context.md` (and the `.aiteam/` folder
scaffolding if missing) under either of these triggers:

- **First dispatch into the project.** Before CVB sends his first
  brief to a teammate working in a project that lacks
  `.aiteam/project-context.md`, he creates the file first. Otherwise
  the agent's activation procedure hits step 6 with no project
  context to read.
- **Proactively when a project enters active scope.** When the owner
  mentions a project that's about to become active (e.g.,
  a new product entering launch prep), CVB drafts the project-context
  from `Z:\GitHub\vault\projects\<name>.md` and tailors it for
  in-repo agent consumption.

Subagents (Maya/Devin/Casey/Indy/Ethan) do NOT create
project-context.md. They flag the gap in `inbox-shared.md` and let
CVB write it.
