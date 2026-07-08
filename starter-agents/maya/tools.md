# Maya — tools and access

## Image generation

### Primary (currently the only image model): Google Gemini 3.1 Flash Image
- Model id: `gemini-3.1-flash-image-preview`
- API: Google Generative AI SDK (REST via `generate.py`)
- Auth: `GEMINI_API_KEY` env var, stored in `{{AITEAM_DIR}}\.env`
  (gitignored).
- Cost: ~$0.04-$0.08 per image depending on size.
- Aspect ratio: pass via `aspect_ratio="16:9"` (etc.) to
  `call_gemini()`; this sets `generationConfig.imageConfig.aspectRatio`.
  Without it the model returns 1024×1024 and `save_webp` will crop.
  Supported: `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:9`,
  `9:16`, `21:9`.
- Capabilities: text-to-image, image-to-image (style transfer / edit),
  multi-image composition. Both Style A (`allow_text=True`) and Style B
  (text forbidden) route through this model.

### gpt-image-1: REMOVED
gpt-image-1 was removed from the toolkit by owner decision (output
quality). Do NOT route to it. When `gpt-image-2` becomes generally
available, revisit Style A routing with the owner — but do not silently
switch back to gpt-image-1 in the meantime.

### Reviewer (cross-vendor quality gate)
- Model id: `gpt-5.5` at `reasoning_effort: "low"`.
- Cost: ~$0.01 per call.
- Why `low` and not `minimal` or `medium`: `minimal` is invalid for
  gpt-5.x; `medium`+ wastes the token budget on reasoning over what's
  an explicit-rubric judgment.

## Local tooling

- **ffmpeg** on PATH (any recent build; e.g. `winget install Gyan.FFmpeg`).
  Used for PNG→WebP conversion:
  `ffmpeg -i in.png -c:v libwebp -quality 85 out.webp`.
- **Python 3.10+** on PATH. Used by `generate.py` and the Recharts
  pipeline.
- **Recharts chart pipeline** at `{{AGENTS_DIR}}\maya\charts\`
  (entry: `_test_recharts_v2.py`). React + Playwright; produces
  accurate data charts. Use when data must be exact. Pair with Gemini
  structured-prompt 3D editorial charts when you want hero-style
  wow-factor.

### No PIL post-processing of model output

Standing team rule: no PIL scripts on model output. That means:
- No edge-feathering passes (no `_fade_edges_to_white()`-style scripts).
- No image surgery for wrong-text fixes — if text is wrong, regenerate.
- The replacement is prompt-side only. The approved phrasing:
  *"This image will be inserted into a white website, so pixels near
  the edges should also be white."* Plain. No "fade to white" language.

PIL is still fine for the genuine pipeline plumbing inside
`generate.py` (resize, center-crop only when aspect diverges by >2%,
webp encode). The ban is on cosmetic post-processing of model output.

## File system access

- **Read**: anywhere under `{{PROJECTS_ROOT}}\` and `{{AGENTS_DIR}}\maya\`.
- **Write (cross-project, role-level)**:
  - `{{AGENTS_DIR}}\maya\` — your own logs, queue,
    completed, spend-log, article_briefs, rejected.
  - `{{AGENTS_DIR}}\<other>\inbox.md` — handoffs.
- **Write (per-project)**: see each project's `.aiteam/agents/maya.md`
  for the project's specific image-output paths and content-edit
  permissions.

## Reporting back so {{OWNER_FIRST}} can see the work in chat

When you finish a dispatched task, your completion summary becomes a
chat bubble in {{OWNER_FIRST}}'s Dashboard. The Dashboard renders
markdown, including image syntax. If you only return a file path,
{{OWNER_FIRST}} has to go open the file. If you return markdown image
references, the images render inline as thumbnails (clickable to a
lightbox).

### Hard rule: every saved image gets a markdown reference in your reply

If you save any image during a task, your final summary MUST embed
that image with markdown image syntax. **Backticks around a path
are not enough** — `` `{{PROJECTS_ROOT}}\someproject\chat-images\foo.png` ``
renders as inline code, not an image, and {{OWNER_FIRST}} sees a path
that has to be opened manually. That's a regression from the way the
Dashboard now handles images. Don't ship reports in that form.

Correct form:

```
**Variation 1**

![first variation]({{PROJECTS_ROOT}}\someproject\chat-images\foo-1.png)

[your description here]
```

Both absolute paths (`{{PROJECTS_ROOT}}\<project>\chat-images\...`)
and project-relative paths (`chat-images/...`) work. The Dashboard's
URL-transform layer rewrites either form to the served URL.

### Where to save

- For images intended to be **shown in the chat** (one-off boards,
  preview tiles, screenshots, anything not destined for a production
  surface like a blog), save to `<project>/chat-images/`. The
  Dashboard's `/api/files` route serves anything in that folder.
  - For dashboard-scope work (no project): `{{AITEAM_DIR}}\chat-images\`.
  - For project-scope work: `{{PROJECTS_ROOT}}\<project>\chat-images\`.
- For images destined for a production surface (a project's blog,
  marketing site, etc.), keep the per-project paths documented in
  `<project>/.aiteam/agents/maya.md`. Those stay where they are.

For blog/production images, you can still link a thumbnail preview
into chat by copying a smaller version into `chat-images/` and
referencing it alongside the canonical path. Use your judgment —
don't double-store huge files for no reason.

## What you cannot do

- Push code to git (Devin handles frontend version control).
- Deploy anything to production.
- Spend money outside the per-month image-gen budget cap.
- Generate adult content, deepfakes, or images depicting real specific
  people.
- Use any model not listed above without a vault decision and
  {{OWNER_FIRST}}'s approval.

## Escalation paths

- **Approval needed**: write to `{{AITEAM_DIR}}\inbox-shared.md`.
- **Frontend dependency**: write to `{{AGENTS_DIR}}\devin\inbox.md`.
- **Urgent notification path**: escalations stay in `inbox-shared.md`
  until the team has a dedicated notification channel.
