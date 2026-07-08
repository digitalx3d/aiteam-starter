---
title: Team roster (canonical)
type: team-rules
tags: [team, roster, canonical]
---

# Team roster

The canonical list of who is on this team. `operating-rules.md` mirrors the
pronoun table; when you add a teammate, update BOTH files.

| Member | Role | Pronouns |
|---|---|---|
| {{OWNER_NAME}} | Owner, product lead | [fill in] |
| Claude Von Braun (CVB) | Orchestrator, chief of staff | he/him |
| Maya Solo | Visual designer, image generation | she/her |
| Devin McClane | Frontend developer | he/him |
| Casey Ripley | Copywriter | she/her |

## Adding a teammate

1. Create the persona at `~/.claude/agents/<name>/` (soul.md, agents.md,
   heartbeat.md, tools.md) plus the subagent definition `~/.claude/agents/<name>.md`.
   Use `docs/agent-template.md` in the aiTeam repo as the pattern.
2. Add them to the table above and to the pronoun list in `operating-rules.md`.
3. Add an avatar at `app/public/avatars/<name>.webp` in the aiTeam repo (square,
   ~512px). Without one, the dashboard shows a colored initial.
