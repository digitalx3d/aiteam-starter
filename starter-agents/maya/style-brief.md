# Visual style brief — for Maya

This is the source of truth for what [your project]'s imagery looks like. Anchor every image you generate against the reference styles below. When in doubt, pick the style that lets your reader see themselves in the picture.

> **Setup note for the owner:** this file ships as a template. Everything in [brackets] is a slot you fill in for your own brand. The craft rules (composition, iteration discipline, what-to-avoid, quality gate) are battle-tested defaults — keep them unless you have a reason not to.

## What changed (most recent on top)

Keep a dated changelog here. Every time a style rule changes — a palette shift, a routing change, a new anchor image — add a line at the top: `**YYYY-MM-DD** — what changed and why.` This is how Maya stays consistent across sessions.

Standing technical decisions inherited from the starter (durable; not brand-specific):

- **Routing runs on Gemini 3.1 Flash Image** for both Style A and Style B (`gemini-3.1-flash-image-preview`). gpt-image-1 was removed for quality reasons; revisit Style A routing only when `gpt-image-2` lands (do NOT switch back to gpt-image-1).
- **Style A uses prose-only prompts, not JSON briefs.** Gemini 3.1 renders JSON keys (`primary_accent`, `color_palette`, hex codes) as literal pixels inside images. Style B keeps the JSON-brief format — it's been clean there.
- **Aspect ratio is requested from Gemini directly** via `generationConfig.imageConfig.aspectRatio`. Without it, Gemini returns 1024×1024 regardless of `target_size` and `save_webp` silently center-crops. Match `target_size` to a supported Gemini ratio.
- **Per-article briefs** live at `{{AGENTS_DIR}}\maya\article_briefs\<slug>.json`. Use briefs for high-stakes articles where prices, product names, and layout need exactness.
- **No PIL post-processing of model output.** Edge-blend behavior is prompt-side only ("This image will be inserted into a white website, so pixels near the edges should also be white"). If text is wrong, regenerate.
- **Slugs cap at 64 chars with word-boundary trimming.** No mid-word filename cuts.
- **Reviewer model is `gpt-5.5` at `reasoning_effort: "low"`**, ~$0.01/call.
- **Image path convention is per-article subfolders**: `images/<slug>/<role>.webp` plus a `<role>.prompt.json` sidecar. Do not regress to flat `<slug>-<role>.webp` naming.
- **Two chart paths exist**: the Recharts pipeline (`{{AGENTS_DIR}}\maya\charts\`, entry `_test_recharts_v2.py`) for accuracy-first data charts, and Gemini structured-prompt 3D editorial charts for wow-factor.

## Style anchors (do NOT skip these)

Before generating, look at the existing reference images. New images either match one of the anchor styles or have a strong reason to do otherwise (and that reason is logged in the changelog as a new entry under "Style C, D, etc.").

> **Owner: fill these in.** After your first approved batch, list 2-4 images per style here with a one-line note on what each one demonstrates. Mark which are primary (preferred direction) and which are secondary (older, kept for context).

### Primary anchors (preferred direction)
- `[path to reference image 1]` — **Style B reference.** [One line: what scene, what lighting, why it's the brand.]
- `[path to reference image 2]` — **Style B reference.** [One line.]

### Secondary anchors (older; useful context, weaker direction)
- `[path]` — [why it's secondary, e.g. "good color temperature, but feel is too flat".]

### Style A anchors
- `[path to reference image]` — **Style A.** [e.g. "Phone mockups in a row, clean line-drawn UI, muted accents, white background, slight isometric tilt."]

## Two-style system

### Style A — UI mockup / info-graphic
**Use when** the article's subject is the *product* — feature comparisons, "how the app works", competitor reviews, how-to guides where the app screens are the point.

Visual cues:
- Phone or device mockups, often in groups of 2–4, slight isometric tilt
- Line-drawn UI elements, no real screenshots
- Solid white or near-white background, with edge pixels that fade into the surrounding webpage
- [Primary accent color] and [secondary accent color] as accent colors only (avoid saturated brights)
- Flat or near-flat design, soft drop shadows beneath each device
- A "favored" device (when comparing) is drawn slightly larger and lifted with a stronger shadow
- Text inside mockups is allowed but strictly enumerated — only the strings explicitly named in the prompt

Prompt pattern (PROSE — do not use JSON-brief format for Style A):
- Open with the canvas: "Create a clean modern flat-design infographic showing [N] smartphones arranged in a horizontal row with a slight isometric tilt and gentle drop shadows."
- Add the safety guard: "ALL [N] PHONES MUST BE FULLY VISIBLE WITHIN THE CANVAS. Leave at least 6% margin on every side; no phone may be cropped at any edge."
- Describe each phone (1, 2, 3...) one at a time, naming exactly which strings appear in the header bar and below. Mark the favored device explicitly.
- Lock the palette in plain English ("[muted primary accent] for X, neutral grays for Y, [secondary accent] only for the savings checkmark").
- Add the white-edge line verbatim: "The image will be inserted into a white website, so pixels near the edges of the canvas should also be white."
- Close with the text-discipline clause: "The ONLY readable text strings allowed in the image are exactly: [list]. Do NOT invent any additional words, captions, feature labels, table rows, slogans, or pseudo-text. Do NOT render JSON keys, field names, hex color codes, or prompt metadata anywhere in the image. If you cannot render any of the listed strings cleanly and legibly, leave that area empty rather than approximating with garbled letters."

Why prose, not JSON-brief: Gemini 3.1 reads JSON keys (`primary_accent`, `color_palette`, hex strings) and renders them as visible pixels inside the image. Prose hides the structure from the model. Look at `_style_a_hero_prose()` and `_style_a_inline_prose()` in `generate.py` for the canonical phrasing.

### Style B — Editorial illustration
**Use when** the article's subject is the *people* — human topics, community, etiquette, emotional content, "what to do when X happens".

Visual cues:
- Real-world scenes drawn from [your audience's everyday world — e.g. kitchen tables, workplaces, neighborhood streets, the settings your readers actually live in]
- People of mixed ages and mixed backgrounds
- Painterly textures, visible brushwork or grain — not flat-vector
- Warm color temperature, [preferred lighting — e.g. autumn / morning / golden-hour] common
- Vibrant but not oversaturated; muted earth tones with [brand accent color] accents
- Background context ([the buildings, streets, or interiors of your audience's world]) gives the scene a place

Prompt pattern:
> Warm editorial illustration of [scene description with your audience's people and props], painterly storybook style with visible brushwork, [time of day] lighting, [seasonal palette] with hints of [brand accent], friendly and authentic faces (diverse people), grounded composition with environmental context, stylized like a thoughtful magazine editorial — not Pixar, not flat-vector, not stock-photo

## Brand palette (hex)

Pull these directly into prompts when needed. **Owner: replace with your brand's palette.**

| Role | Hex | Notes |
|---|---|---|
| Primary accent | `[#______]` | For accents, never as sole color |
| Dark heading / anchor | `[#______]` | Dark text/anchor color; use instead of pure black |
| Secondary accent | `[#______]` | Positive callouts, checkmarks |
| Tertiary accents | `[#______]` | Occasional; sparingly |
| Off-white bg | `[#______]` | Footer/section background |

Avoid pure black (`#000`); use your dark heading color for "black" feel. Avoid pure red.

## Composition rules

### Form follows function — match aspect ratio to display intent

The aspect ratio of an image should match how it will be displayed in the article. Mismatch produces awkward layouts:

- **Full-width display (figure-full):** image must be wide format, **at least 2:1** aspect ratio (1200×630, 1536×768, 1920×900, etc.). A 1:1 square at full width takes up too much vertical space and forces excessive scrolling. A vertical image at full width is even worse.
- **Centered ~65% display (figure-default):** square (1024×1024) or moderate landscape (3:2, 4:3) reads well. Avoid extreme aspects.
- **Float-right or float-left (figure-right / figure-left):** square (1024×1024) or vertical (3:4, 1024×1280) works best — narrower images leave more room for text to wrap around them. Wide-format images at this size become tiny and unreadable.

When generating an inline image, **decide the display intent first**, then pick the aspect ratio. If the article role is "hero" or the image will be `figure-full`, generate at 16:9 or wider. If the image is float-positioned alongside text, generate square or vertical.

### Other composition rules

- **Hero images:** 1200×630 (Open Graph card aspect). Focal point in left third; right third should be relatively quiet so headline text overlay reads if used. Subjects looking left or center, not into the deep right edge.
- **Inline images:** sized per the form-follows-function rule above. Clear focal point, no busy edges.
- **No text in images** unless it's part of a stylized UI mockup AND the article wiring will use the `--allow-text` mode. Headlines live in HTML, not in the picture.
- **No watermarks, no logos** unless explicitly requested for branded asset work.
- **Crop-safe area:** assume the bottom 80px and top 80px of hero images may be covered by overlays in some contexts. Don't put the eyes/face in those zones.

### When the article cites real numbers

When an article makes a numerical claim (e.g., "[$X] vs [$Y]/year," "[N]% savings," "[N] of [M] features"), the image should show those *exact* numbers — not stand-ins. Otherwise the image and prose contradict each other and a reader notices instantly.

Three paths:
- **Per-article brief** (preferred for high-stakes articles). Drop a JSON file at `{{AGENTS_DIR}}\maya\article_briefs\<slug>.json` with hand-tuned prose prompts that bake the real numbers, product names, and layout in. Schema:
  ```
  {
    "hero":   { "target_size": [w,h], "aspect_ratio": "16:9", "prompt": "..." },
    "inline": { "<role-slug>": { "target_size": [...], "aspect_ratio": "...", "prompt": "..." } }
  }
  ```
  If a brief exists for a slug, its prompts override the default templates. Good briefs spell out exact dollar amounts, exact product names, and the precise list of allowed text strings. [Add your first brief examples here as you create them.]
- **Default Style A template with `allow_text=True`** — for routine product articles where the numbers are simple and the layout is generic. Less control but no per-article authoring overhead.
- **Recharts chart pipeline** (`{{AGENTS_DIR}}\maya\charts\`, `_test_recharts_v2.py`) — accuracy-first React/Playwright path for in-article supporting charts where the data must be exact. Use Recharts when the chart's *job* is the data; use a Gemini structured-prompt 3D editorial chart when the chart's job is the *wow*. Both tools live in the toolkit; pick by intent.

## What to avoid (non-negotiable)

These are the rules the cross-vendor vision reviewer enforces on every output. If an image violates any of them, the reviewer fails it and we regenerate.

### Anatomy
- No extra or missing limbs.
- No half-bodies clipping through windshields, walls, or other surfaces.
- No fused hands or fingers; no extra fingers; no claw shapes.
- No missing facial features. No impossibly twisted poses.

### Physics / spatial coherence
- No floating objects.
- No tailgates, doors, or roofs in impossible orientations.
- No items merging unnaturally with other items.
- No objects clipping through solid surfaces.
- People stand on ground. Not on car roofs, not inside cars they're not riding in. Not standing in driver's seats with their upper body through the roof.
- Cars are intact, not exploded views.
- Hands hold things from believable angles.

### AI-image traps
- **Generic AI-image look** — over-rendered skin, weirdly perfect symmetry, melting hands, the "uncanny valley friendly face" trope. If an image triggers this reaction, regenerate.
- **Stock-photo clichés** — handshake-over-laptop, business-people-in-meeting, family laughing while looking at phone screen, white teeth too white.
- **Pixar / Disney cartoon look** — children with oversized heads, exaggerated features, big watery eyes. We are editorial-illustration, not animation.
- **Sterile corporate aesthetic** — gray gradients, geometric polygons, abstract networks of nodes-and-lines. We're warm, not enterprise.

### Text and branding
- **Style B (editorial illustration): zero readable text in images.** No signs, banners, posters, headlines, labels, captions, license plates with legible writing, books or papers with visible words, screens displaying real strings, pseudo-text squiggles that look word-like. Style B keeps the JSON-brief format and forbids text outright.
- **Style A (UI mockup) with `allow_text=True`: render only the text strings explicitly named in the prompt.** Never invent feature names. Never render JSON keys, field names, or hex codes. If the model can't render a named string cleanly, leave that area empty rather than approximating with garbled letters. The constraints list for Style A (`_STYLE_A_CONSTRAINTS` in `generate.py`) drops the anatomy/physics/spatial rules (irrelevant for UI mockups) and adds these text-discipline guards.
- **No large explicit real-world brand logos** — no Nike swoosh on the front of a shirt, no McDonald's arches sign, no giant Coca-Cola bottle. Vehicles are generic; buildings are generic.
- **Subtle brand-suggestion is FINE.** Small side stripes on athletic shorts, generic chevrons on a sleeve, plain stitching detail — that's editorial realism. We're not paranoid about it.
- The test for brand stuff: would a casual reader pause and read a logo? If yes, it's too much. If they'd just register "athletic clothing" without naming a brand, fine.

### Canvas usage — negative space is craft, not failure
The distinction matters:

- **DEAD margins** — uniform untouched white borders the model leaves because it gave up filling the canvas. These are unacceptable. Symptom: a clean rectangular white frame around all four edges, the artwork floating in the middle.
- **INTENTIONAL negative space** — empty zones the artwork USES as composition. A subject extending into open sky. A raised tailgate reaching into a quieter zone. A road receding into uncluttered distance. The negative space *engages* with the subject. **This is good. Keep it.**

The test: does the empty area feel *chosen*, or feel like the model *ran out of ideas*? The first is good editorial craft (and often makes the image more powerful). The second is what we reject. When in doubt, ship — well-used negative space engages with the article space on a higher level.

For **hero images (1200×630)**: the right third can be compositionally lighter (softer-focus distance, sky, foliage) to leave room for headline overlay — environmental content, not blank canvas.
For **inline images (square or near-square)**: subject can extend into negative space. Don't force every corner to have content if the composition reads better with breathing room.

### Devices in scenes
- **Phones, tablets, laptops, watches, any device with a screen:** the screen MUST face the character holding it (toward their face/eyes). The screen MUST NOT face the viewer of the illustration. We see the back or edge of the device, not its display.
- This is a realism rule. People look at their devices; they do not show them off to the camera. Showing the screen toward the viewer reads as unnatural posing every time.
- Exception: if the scene specifically requires the viewer to read the screen (rare for editorial illustration), still avoid putting any readable text on it — show abstract UI shapes only, and treat it as an explicit deliberate choice not the default.

## Quality gate

Every generated image is checked by `gpt-5.5` at `reasoning_effort: "low"` (cross-vendor — generator can't bless its own slop) against this rubric. If the review fails, the script regenerates once with the issues as additional negative constraints. If the second attempt still fails, the file is saved but flagged in the spend log with `review_failed_twice: true` so the owner can review manually instead of trusting it.

Reviewer cost: ~$0.01 per call. Still cheap relative to a regenerate, and `low` reasoning is the right setting — `minimal` is invalid for gpt-5.x and `medium`+ wastes the budget on reasoning over what's an explicit-rubric judgment.

## When you're unsure

- Use Style B (editorial illustration) as the default for ambiguous topics. It's safer for emotional resonance and harder to make look generic.
- Pull from the closest existing reference image (image-to-image with Gemini's edit mode) rather than generate from scratch. Style consistency matters more than novelty.
- If you've iterated 3+ times on the same image and aren't satisfied, escalate to {{OWNER_FIRST}} before burning more budget. Say what you tried and what's not landing.

## Output conventions

- File format: `.webp`
- Quality: 85 (libwebp default for web)
- Path: per-article subfolder — `[project blog images dir]\<slug>\<role>.webp` (the exact directory lives in each project's `.aiteam/agents/maya.md`). Do not regress to flat `<slug>-<role>.webp` naming.
- Role: `hero` for the lead image, then descriptive role-slugs for inline (e.g. `pricing-the-biggest-difference`, `why-readers-are-switching`). The role-slug is generated from the H2/H3 heading the image anchors; capped at 64 chars with word-boundary trimming (hard mid-word cuts produce garbage filenames).
- Sidecar: `<role>.prompt.json` next to the webp, containing the prompt, model, generation parameters, and cost.

### Aspect-ratio / target-size pairings

`call_gemini()` accepts an `aspect_ratio` parameter and forwards it via `generationConfig.imageConfig.aspectRatio`. Without it Gemini returns 1024×1024 regardless of `target_size`, and `save_webp()` silently center-crops. `save_webp()` only crops when source/target diverge by >2% (and logs a WARN); otherwise it just resizes.

Supported Gemini 3.1 ratios and their default 1K pixel dimensions:

| Ratio | Pixels (default 1K) | Typical use |
|---|---|---|
| `1:1` | 1024×1024 | square inline, 2x2 grids |
| `3:2` | 1264×848 | landscape inline (matches 1536×1024 targets) |
| `4:3` | 1200×896 | landscape inline (matches 1200×896 targets) |
| `16:9` | 1376×768 | hero (matches 1200×630 targets) |
| `9:16` | 768×1376 | vertical mobile-first |
| `2:3`, `3:4`, `4:5`, `5:4`, `21:9` | — | available, used rarely |

**Rule:** match `target_size` to a Gemini-supported ratio. Otherwise the model returns square and we crop.

## Iteration discipline

- First attempt: generate from prompt + style anchor. If it lands, ship.
- Second attempt: if first miss is *style*, switch styles or adjust palette specifics. If first miss is *composition*, use Gemini's image-edit mode with the first attempt as input.
- Third attempt: explicitly cite an existing reference image and use image-to-image.
- Fourth+: stop, log the failure mode, ask {{OWNER_FIRST}}.
