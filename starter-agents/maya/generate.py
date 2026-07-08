"""Maya — image generator for blog articles.

Generates hero + inline images via Gemini Flash Image, converts
PNG -> WebP, saves to the project's blog images folder, logs spend,
never modifies article markdown (humans review images before they get
inlined).

Usage:
  python generate.py <article-slug>           # uses default 1 hero + 2 inline
  python generate.py <article-slug> --hero-only
  python generate.py --list                   # list articles missing images

Env (all optional except the API keys):
  AITEAM_DIR         path to the aiTeam repo. Its .env file supplies
                     OPENAI_API_KEY / GEMINI_API_KEY. Defaults to the
                     current working directory.
  AGENTS_DIR         agent-persona root. Defaults to ~/.claude/agents.
  BLOG_ARTICLES_DIR  the project's article markdown folder.
                     Defaults to <cwd>/landing/blog/articles.
  BLOG_IMAGES_DIR    the project's image output folder.
                     Defaults to <cwd>/landing/blog/images.
  BRAND_NAME         your product's brand name (the only brand string
                     the model may render). Defaults to "YourBrand".
  BRAND_ACCENT_HEX   optional brand accent hex (e.g. "#4a89dc") woven
                     into Style B palette guidance.
  GEMINI_API_KEY / OPENAI_API_KEY
                     read from the environment first, then from the
                     aiTeam repo's .env at <AITEAM_DIR>/.env.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import requests
from PIL import Image

# ---- Path resolution (environment-driven; the setup script exports these) ----
# ROOT is only used to locate the .env holding the API keys.
ROOT = Path(os.environ.get("AITEAM_DIR", os.getcwd()))
# Canonical persona home (agent location rule: personas live under the
# user-level agents dir, never inside a project repo).
MAYA = Path(os.environ.get("AGENTS_DIR", str(Path.home() / ".claude" / "agents"))) / "maya"
ARTICLES_DIR = Path(os.environ.get("BLOG_ARTICLES_DIR", str(Path.cwd() / "landing" / "blog" / "articles")))
IMAGES_DIR = Path(os.environ.get("BLOG_IMAGES_DIR", str(Path.cwd() / "landing" / "blog" / "images")))
REJECTED_DIR = MAYA / "rejected"
SPEND_LOG = MAYA / "spend-log.json"
COMPLETED_LOG = MAYA / "completed.md"

# The only brand name the model is allowed to render inside images.
_OUR_BRAND = os.environ.get("BRAND_NAME", "YourBrand")
# Optional accent hex used in Style B palette guidance.
_BRAND_ACCENT = os.environ.get("BRAND_ACCENT_HEX", "").strip()

GEMINI_MODEL = "gemini-3.1-flash-image-preview"  # Nano Banana 3.1 (sharper, better text)
GEMINI_ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
GEMINI_COST_USD = 0.04

OPENAI_MODEL = "gpt-image-1"
OPENAI_ENDPOINT = "https://api.openai.com/v1/images/generations"
OPENAI_COST_USD_SQUARE = 0.042       # 1024x1024 medium
OPENAI_COST_USD_LANDSCAPE = 0.063    # 1536x1024 medium

# Provider order: try Gemini first (cheaper, prompt brief is tuned for it),
# fall back to OpenAI on quota / model errors.
DEFAULT_PROVIDER_ORDER = ("gemini", "openai")


# ---------- Auth ----------

def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def get_credentials() -> dict[str, str | None]:
    """Return {'gemini': key_or_None, 'openai': key_or_None}.
    Reads from os.environ first, then <AITEAM_DIR>/.env (the aiTeam
    repo's .env is where OPENAI_API_KEY / GEMINI_API_KEY live).
    """
    env = {**_load_env_file(ROOT / ".env"), **os.environ}
    return {
        "gemini": env.get("GEMINI_API_KEY") or None,
        "openai": env.get("OPENAI_API_KEY") or None,
    }


# ---------- Article reading ----------

@dataclass
class Article:
    slug: str
    md_path: Path
    title: str
    publish_date: str | None
    category: str | None
    body: str

    @property
    def is_stub(self) -> bool:
        # Heuristic: real articles have substantial body. Stubs are < 600 chars.
        return len(self.body.strip()) < 600


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_article(md_path: Path) -> Article:
    raw = md_path.read_text(encoding="utf-8")
    title = md_path.stem
    pub = None
    cat = None
    body = raw
    m = _FRONTMATTER_RE.match(raw)
    if m:
        for line in m.group(1).splitlines():
            line = line.strip()
            if line.startswith("title:"):
                title = line.split(":", 1)[1].strip().strip('"').strip("'")
            elif line.startswith("publishDate:") or line.startswith("date:"):
                pub = line.split(":", 1)[1].strip().strip('"').strip("'")
            elif line.startswith("category:") or line.startswith("tag:"):
                cat = line.split(":", 1)[1].strip().strip('"').strip("'")
        body = m.group(2)
    return Article(
        slug=md_path.stem, md_path=md_path,
        title=title, publish_date=pub, category=cat, body=body,
    )


def list_articles_missing_images() -> list[Article]:
    out: list[Article] = []
    if not ARTICLES_DIR.is_dir():
        return out
    for md in sorted(ARTICLES_DIR.glob("*.md")):
        a = parse_article(md)
        hero = IMAGES_DIR / a.slug / "hero.webp"
        if not hero.exists():
            out.append(a)
    return out


# ---------- Style decision ----------

# Per agents/maya/style-brief.md: Style A (UI mockup) for product comparisons,
# Style B (editorial illustration) for human-context.
STYLE_A_HINTS = (
    "vs", "alternative", "review", "comparison", "competitor",
    "pricing", "switching", "stop using",
)


def pick_style(article: Article) -> str:
    title_low = article.title.lower()
    slug_low = article.slug.lower()
    if any(h in title_low or h in slug_low for h in STYLE_A_HINTS):
        return "A"
    return "B"


_TEXT_CONSTRAINT = (
    "NO readable text, letters, numbers, or characters anywhere — no signs, "
    "banners, posters, headlines, labels, captions, license plates, books, or "
    "papers with legible writing. No 'pseudo-text' (squiggles that look "
    "word-like). Decorative abstract shapes on bags or packaging are FINE as "
    "long as they don't read as letters."
)

# Style B is editorial illustration of real-world scenes with people, cars,
# environments. These constraints exist because that's where the model fails:
# anatomy, physics, spatial coherence, accidental logos.
_STYLE_B_CONSTRAINTS = [
    "anatomy must be plausible: no extra or missing limbs, no half-bodies clipping through windshields or walls, no fused hands, no extra fingers, no faces with missing features",
    "physics must be plausible: no floating objects, no tailgates or doors in impossible orientations, no items merging unnaturally with each other, no objects clipping through solid surfaces",
    "spatial relationships must be coherent: people stand on ground, not inside vehicle roofs; cars are intact, not exploded views; hands hold things from a believable angle",
    "no watermarks. No large explicit real-world logos (a clearly-readable Nike swoosh on the front of a t-shirt, a McDonald's golden arches sign, a giant Coca-Cola bottle). Subtle suggestions of generic athletic-apparel patterns (small side stripes, generic chevrons, simple stitching detail) are FINE — we're going for editorial realism, not corporate paranoia.",
    "DEAD white margins are forbidden — meaning a uniform untouched white border the model left because it gave up filling the canvas. INTENTIONAL negative space is welcome — meaning the artwork uses empty area as composition (a subject extending into open sky, a tailgate raised into a quieter zone, a road receding into uncluttered distance). The test: does the negative space feel chosen, or feel like the model ran out of ideas? The first is good editorial craft. The second is what we're rejecting.",
    "device orientation rule: when any character holds a phone, tablet, laptop, watch, or any device with a screen, the screen MUST face the character who is using it (toward their face/eyes). The screen must NOT face the viewer of the illustration. We see the back or edge of the device, not its display, unless the scene specifically requires the viewer to read the screen — in which case still avoid showing readable text on it.",
]

# Style A is UI mockup / infographic / studio-lit product imagery. Different
# failure modes than Style B — text invention, JSON-leak, dead canvas. Drops
# all the human/scene constraints; adds text-discipline guards.
_STYLE_A_CONSTRAINTS = [
    "the image will be inserted into a white website, so pixels near the edges should also be white",
    "render ONLY the readable text strings explicitly named in this prompt — do NOT invent additional words, table rows, captions, slogans, feature names, or pseudo-text. If you cannot render a specified text string cleanly and legibly, leave that area empty rather than approximating with garbled letters.",
    "do NOT render JSON keys, field names, hex color codes, or any prompt metadata as visible text inside the image. The prompt's color guidance is for your color choices, not for display.",
    f"no large explicit real-world brand logos (no Nike swoosh, no Coca-Cola, no McDonald's). {_OUR_BRAND} is the only brand name that may appear, and only where the prompt names it.",
    "no decorative background shapes, blobs, or patterns unless the prompt asks for them. Keep the canvas clean and primarily white.",
]


def get_constraints(allow_text: bool = False) -> list[str]:
    """Return the Style B constraint list, with the text rule included unless suppressed.

    Style A uses _STYLE_A_CONSTRAINTS directly via the prose path — it does NOT
    go through this function.
    """
    if allow_text:
        return list(_STYLE_B_CONSTRAINTS)
    return [_TEXT_CONSTRAINT] + list(_STYLE_B_CONSTRAINTS)


# Kept for back-compat with code that referenced it
UNIVERSAL_CONSTRAINTS = get_constraints(allow_text=False)


# Heading-keyword → concrete visual metaphor for Style A inline images.
# Tune these keyword→metaphor pairs to your product domain; these defaults
# cover common SaaS/app blog themes.
_INLINE_METAPHORS_A: list[tuple[str, str]] = [
    ("pric",      "a clean price-comparison table or a price tag with dollar amounts visible — explicit numerical contrast between two pricing options"),
    ("cost",      "a wallet, coins, or a price tag with a clear amount visible"),
    ("feature",   "a vertical feature checklist with checkmarks and X-marks, two columns visible side by side for comparison"),
    ("compare",   "a side-by-side split panel with one option on each side, clear visual contrast between left and right"),
    ("vs",        "a side-by-side split panel with one option on each side, clear visual contrast between left and right"),
    ("calendar",  "a clean calendar grid with day labels visible (Mon, Tue, Wed) and a few highlighted cells"),
    ("schedul",   "a clean calendar grid or week-view with day labels visible and a few highlighted cells"),
    ("driver",    "a stylized car silhouette with driver/passenger profile icons indicating who's driving"),
    ("notif",     "a phone with a notification banner appearing at the top of the screen"),
    ("review",    "a star-rating row (5 stars or 4-and-a-half stars) above an app icon"),
    ("rating",    "a star-rating row above an app icon"),
    ("setup",     "a numbered step list (1, 2, 3) with simple icons next to each step"),
    ("getting started", "a numbered step list (1, 2, 3) with simple icons next to each step"),
    ("safety",    "a shield icon overlapping a smartphone, indicating protection"),
    ("invite",    "a phone with a 'share' or 'invite' UI element visible — a card with profile icons and an arrow"),
    ("famil",     "a profile-grid showing a parent and 2-3 child icons connected by lines"),
    ("household", "a profile-grid showing a parent and 2-3 child icons connected by lines"),
]


def _pick_inline_metaphor_a(scene_theme: str) -> str:
    """Match the section heading to a concrete visual metaphor."""
    low = scene_theme.lower()
    for keyword, metaphor in _INLINE_METAPHORS_A:
        if keyword in low:
            return metaphor
    return (
        "a small flat-design product-illustration vignette that visually "
        "communicates the theme — choose ONE clear central element (a phone, "
        "an icon, a card, a chart) rather than a busy composition"
    )


def _extract_competitors(title: str) -> list[str]:
    """Pull competitor names out of an article title for Style A prompts.

    Patterns:
      - 'X vs Y'   → [X, Y]
      - 'Best X Alternatives ...' → [X]
      - 'X Review ...' → [X]
      - 'X Pricing Explained ...' → [X]
    """
    out: list[str] = []
    m = re.search(r"^(.+?)\s+vs\s+(.+?)(?:\s*[:?]|$)", title, re.I)
    if m:
        return [m.group(1).strip(), m.group(2).strip()]
    m = re.search(r"best\s+(.+?)\s+alternatives", title, re.I)
    if m:
        return [m.group(1).strip()]
    m = re.search(r"^(.+?)\s+(?:review|pricing|features)", title, re.I)
    if m:
        return [m.group(1).strip()]
    return out


_STYLE_A_VISUAL_LANGUAGE = (
    "Visual style: clean modern flat-design vector illustration. Crisp shapes, "
    "soft drop shadows beneath solid objects, primarily white background, no "
    "decorative blobs or background patterns. Reads as a polished product-blog "
    "infographic — NOT photorealistic, NOT a screenshot, NOT cartoony. "
    "Color palette: subdued muted blue for the favored brand's accents (a calm "
    "sky-blue, not saturated), neutral grays for the comparison element, sage "
    "green only for positive checkmarks or 'savings' callouts. Backgrounds and "
    "card bodies are white or near-white."
)


def _style_a_hero_prose(article: Article) -> str:
    """Build a prose-only Style A hero prompt. No JSON brief.

    Style A heroes for comparison-style articles use a 3-phone layout. We
    name the brands explicitly and constrain the text strings the model may
    render, since Gemini 3.1 will otherwise invent feature names and leak
    JSON metadata into the image.

    The screen contents below (route map, weekly schedule) are a template —
    tune them to whatever your own app's core screens actually show.
    """
    competitors = _extract_competitors(article.title)
    has_us = bool(competitors) and _OUR_BRAND.lower() in (c.lower() for c in competitors)
    other = (next(c for c in competitors if c.lower() != _OUR_BRAND.lower())
             if has_us else (competitors[0] if competitors else "a competing app"))

    body = f"""Create a clean modern flat-design infographic showing three smartphones arranged in a horizontal row with a slight isometric tilt and gentle drop shadows beneath each device. The image is a hero illustration for a blog article comparing two apps.

PHONE 1 (left): The screen displays the "{other}" app. The header bar at the top contains exactly the single word: "{other}" in subdued dark-gray text on a light-gray background. Below the header, render a simple route-map illustration with two location pins connected by a winding gray road. No additional text on this screen.

PHONE 2 (middle, drawn slightly larger and lifted with a stronger drop shadow): The screen displays the "{_OUR_BRAND}" app. The header bar contains exactly the phrase: "{_OUR_BRAND}" in white text on a muted blue background. Below the header, render a clean weekly-schedule layout: five rows running top to bottom, with the day abbreviations "Mon", "Tue", "Wed", "Thu", "Fri" running down the left edge of those rows, and a small circular profile-photo icon (faceless silhouette) placed in each row beside the day. No additional text.

PHONE 3 (right): The screen displays a small comparison summary. Two horizontal rows. Top row: a green checkmark icon followed by exactly the text "{_OUR_BRAND} ✓". Bottom row: a gray X-mark icon followed by exactly the text "{other} ✗". No other text.

{_STYLE_A_VISUAL_LANGUAGE}

The ONLY readable text strings allowed in the image are exactly: "{other}", "{_OUR_BRAND}", "Mon", "Tue", "Wed", "Thu", "Fri", "{_OUR_BRAND} ✓", and "{other} ✗". If you cannot render any of those strings cleanly and legibly, leave that area empty rather than approximating with garbled letters."""
    return body


def _style_a_inline_prose(article: Article, heading: str) -> str:
    """Build a prose-only Style A inline prompt for a section heading.

    Falls back to a generic vignette if no heading-keyword metaphor matches.
    """
    scene_theme = _concept_to_scene_phrase(heading)
    metaphor = _pick_inline_metaphor_a(scene_theme)
    competitors = _extract_competitors(article.title)
    competitor_clause = (
        f" The article compares {competitors[0]} and {_OUR_BRAND}; treat {_OUR_BRAND} as the favored option visually."
        if competitors and _OUR_BRAND.lower() in (c.lower() for c in competitors)
        else ""
    )

    return f"""Create a clean modern flat-design infographic illustrating the theme: "{scene_theme}". This is an inline blog illustration — a single focused vignette, NOT three smartphones (that's the hero treatment).

Concrete visual: {metaphor}.{competitor_clause}

{_STYLE_A_VISUAL_LANGUAGE}

Render only labels and numbers that you can produce cleanly and that are clearly meaningful for this theme — generic placeholder lines (thin gray bars representing unspecified text) are preferred over inventing feature names, fake currency amounts, or fictional product copy. If a label needs a specific value and the value isn't given to you, leave it as a placeholder line rather than making one up. The "{_OUR_BRAND}" brand name is the only product name you may render; do not invent competing app names."""


def _style_b_descriptor(article: Article, *, for_hero: bool = False) -> dict:
    # EDIT the "subject" and "environment" strings to describe YOUR
    # audience's everyday world — the scenes your readers actually live in.
    # The rest of the descriptor is style guidance and travels well as-is.
    accent = "hints of the brand accent color used sparingly in clothing or small props"
    if _BRAND_ACCENT:
        accent = f"hints of the brand accent color ({_BRAND_ACCENT}) used sparingly in clothing or small props"
    composition = (
        "focal point in the left two-thirds; right third stays compositionally lighter "
        "(softer-focus background, sky, foliage, distance) to leave room for an OG-card "
        "headline overlay — but the right third is STILL filled with environmental "
        "content, not blank canvas"
        if for_hero
        else "subject and environment fill the canvas edge-to-edge with no blank zones; "
             "single clear focal point centered or just off-center; surrounding context "
             "(ground, sky, foliage, walls, vehicles) fills every corner"
    )
    return {
        "subject": "a friendly real-world scene with people in the everyday context this product serves — a home, neighborhood, workplace, or community moment that reads as a believable slice of life",
        "style": "painterly editorial illustration with visible brushwork and grain texture; reads as hand-painted not vector; NOT flat-design, NOT Pixar/animation, NOT photorealistic",
        "lighting": "warm morning or golden-hour light",
        "color_palette": {
            "saturation": "vibrant but not oversaturated",
            "base": "muted earth tones",
            "accent": accent,
        },
        "characters": "diverse and authentic-looking faces, varied ages and backgrounds; expressions are warm but not exaggerated",
        "environment": "include place-setting context: buildings, streets, trees, interiors — whatever grounds the scene in a real place",
        "composition": composition,
    }


ARTICLE_BRIEFS_DIR = MAYA / "article_briefs"


def _load_article_brief(slug: str) -> dict:
    """Load per-article prompt overrides from agents/maya/article_briefs/<slug>.json.

    Schema (all fields optional):
      {
        "hero": { "prompt": "full prose..." },
        "inline": { "<role-slug>": { "prompt": "full prose..." }, ... }
      }
    Returns {} if no file exists.
    """
    path = ARTICLE_BRIEFS_DIR / f"{slug}.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _wrap_with_constraints(prose: str, constraints: list[str]) -> str:
    bullets = "\n".join(f"- {c}" for c in constraints)
    return f"{prose}\n\nNon-negotiable constraints:\n{bullets}"


def hero_prompt(article: Article, style: str, allow_text: bool = False) -> str:
    # Per-article override wins outright when present.
    brief = _load_article_brief(article.slug)
    override = (brief.get("hero") or {}).get("prompt")
    if override:
        return override

    if style == "A":
        return _wrap_with_constraints(_style_a_hero_prose(article), _STYLE_A_CONSTRAINTS)

    # Style B keeps the JSON brief — it's been working well there.
    descriptor = _style_b_descriptor(article, for_hero=True)
    payload = {
        "task": "generate one editorial blog hero image",
        "aspect_ratio": "1200x630 (Open Graph card)",
        "purpose": f"hero image for a blog article whose subject is: {article.title}",
        "descriptor": descriptor,
        "constraints": get_constraints(allow_text=allow_text),
        "rendering_directives": {
            "compose_image_to_match_descriptor": True,
            "respect_every_constraint_strictly": True,
            "if_constraint_conflicts_with_descriptor_constraint_wins": True,
        },
    }
    if allow_text:
        payload["text_handling"] = (
            "Text in the image IS ALLOWED for this generation. Use it where "
            "it improves communication — labels on UI mockups, headers in "
            "comparison tables, calendar day names, app names. Keep it "
            "purposeful, not decorative."
        )
    return (
        "Generate the image specified by this JSON brief. Read every field. "
        "The constraints array is non-negotiable.\n\n"
        + json.dumps(payload, indent=2, ensure_ascii=False)
    )


def inline_prompts(article: Article, style: str, n: int = 2, allow_text: bool = False) -> list[tuple[str, str]]:
    headings = re.findall(r"^#{2,3}\s+(.+)$", article.body, re.M)
    headings = [h.strip().rstrip(":") for h in headings if h.strip()]
    seen = set()
    picks = []
    for h in headings:
        key = h.lower()[:40]
        if key in seen:
            continue
        seen.add(key)
        picks.append(h)
        if len(picks) >= n:
            break
    while len(picks) < n:
        picks.append(article.title)

    brief = _load_article_brief(article.slug)
    inline_overrides = brief.get("inline") or {}

    out = []
    for i, heading in enumerate(picks):
        scene_theme = _concept_to_scene_phrase(heading)
        role = _slug_from_heading(heading, i)

        # Per-article override for this role wins outright when present.
        role_override = (inline_overrides.get(role) or {}).get("prompt")
        if role_override:
            out.append((role, role_override))
            continue

        if style == "A":
            prompt = _wrap_with_constraints(
                _style_a_inline_prose(article, heading), _STYLE_A_CONSTRAINTS
            )
            out.append((role, prompt))
            continue

        # Style B keeps the existing JSON-brief path.
        descriptor = _style_b_descriptor(article, for_hero=False)
        purpose = (
            f"inline illustration for a blog section. Theme: {scene_theme}"
            if allow_text
            else f"inline illustration for a blog section. Theme to communicate "
                 f"VISUALLY (no text in the image): {scene_theme}"
        )
        instruction = (
            "Translate the theme into a clear scene. Use text labels where "
            "they improve communication — comparison tables, UI mockups, "
            "calendar grids, price tags. Keep text purposeful, never "
            "decorative scribble."
            if allow_text
            else "Translate the theme into a concrete scene with body language, "
                 "objects, and setting. Do NOT depict the theme as written words "
                 "on a sign, banner, or screen — communicate it purely through "
                 "the image."
        )
        payload = {
            "task": "generate one square inline blog illustration",
            "aspect_ratio": "1024x1024 (square)",
            "purpose": purpose,
            "descriptor": descriptor,
            "instruction": instruction,
            "constraints": get_constraints(allow_text=allow_text),
        }
        prompt = (
            "Generate the image specified by this JSON brief. Read every field. "
            "The constraints array is non-negotiable.\n\n"
            + json.dumps(payload, indent=2, ensure_ascii=False)
        )
        out.append((role, prompt))

    # Extra inlines defined ONLY in the brief — generate them too. Lets a brief
    # target an arbitrary back-half H2 by its slug (e.g. role 'common-problems-and-how-to-solve-them')
    # without bumping --inline N high enough to wastefully cover every heading
    # between the auto-picks and the target.
    #
    # Spec accepts either:
    #   - "prompt": full prompt string (used as-is, caller is responsible for constraints)
    #   - "theme": short prose description of the section's visual theme (we wrap it
    #              in the style-appropriate template + constraints)
    existing_role_slugs = {role for role, _ in out}
    for extra_role, spec in inline_overrides.items():
        if extra_role in existing_role_slugs:
            continue
        spec = spec or {}
        extra_prompt = spec.get("prompt")
        if not extra_prompt:
            theme = spec.get("theme")
            if not theme:
                continue
            extra_prompt = _build_extra_inline_prompt(article, style, extra_role, theme, allow_text)
        out.append((extra_role, extra_prompt))

    return out


def _build_extra_inline_prompt(article: Article, style: str, role: str, theme: str, allow_text: bool) -> str:
    """Wrap a brief's `theme` description in the style-appropriate template + constraints.

    For Style A: emit a prose prompt with the Style-A constraint block appended.
    For Style B: emit a JSON brief in the same format the default loop uses.
    """
    if style == "A":
        prose = (
            f"Create a clean modern flat-design infographic illustrating: {theme}. "
            f"This is an inline blog illustration — a single focused vignette, NOT three smartphones (that's the hero treatment).\n\n"
            f"{_STYLE_A_VISUAL_LANGUAGE}\n\n"
            f"Render only labels and numbers that are clearly meaningful for this theme. "
            f"Generic placeholder lines (thin gray bars representing unspecified text) are preferred over inventing feature names, "
            f"fake currency amounts, or fictional product copy. The \"{_OUR_BRAND}\" brand name is the only product name you may render; "
            f"do not invent competing app names."
        )
        return _wrap_with_constraints(prose, _STYLE_A_CONSTRAINTS)

    # Style B JSON-brief path
    descriptor = _style_b_descriptor(article, for_hero=False)
    purpose = (
        f"inline illustration for a blog section. Theme: {theme}"
        if allow_text
        else f"inline illustration for a blog section. Theme to communicate "
             f"VISUALLY (no text in the image): {theme}"
    )
    instruction = (
        "Translate the theme into a clear scene. Use text labels where "
        "they improve communication. Keep text purposeful, never decorative scribble."
        if allow_text
        else "Translate the theme into a concrete scene with body language, "
             "objects, and setting. Do NOT depict the theme as written words "
             "on a sign, banner, or screen — communicate it purely through "
             "the image."
    )
    payload = {
        "task": "generate one square inline blog illustration",
        "aspect_ratio": "1024x1024 (square)",
        "purpose": purpose,
        "descriptor": descriptor,
        "instruction": instruction,
        "constraints": get_constraints(allow_text=allow_text),
    }
    return (
        "Generate the image specified by this JSON brief. Read every field. "
        "The constraints array is non-negotiable.\n\n"
        + json.dumps(payload, indent=2, ensure_ascii=False)
    )


_STEP_PREFIX = re.compile(r"^(step\s*\d+\s*[:.\-]?\s*|chapter\s*\d+\s*[:.\-]?\s*|\d+\s*[:.\-]\s*)", re.I)
_PARENS = re.compile(r"\([^)]*\)")


def _concept_to_scene_phrase(heading: str) -> str:
    """Strip enumerations and parentheticals so the heading reads as a *theme*,
    not a literal title to render. Helps prevent the model from drawing the
    heading text on a banner inside the image.
    """
    s = _STEP_PREFIX.sub("", heading).strip()
    s = _PARENS.sub("", s).strip()
    s = s.rstrip(":.,!?").strip()
    return s.lower()


_SLUG_MAX = 64


def _slug_from_heading(heading: str, idx: int) -> str:
    """Build a clean slug from a heading: drop step prefixes, keep meaningful nouns.

    Trims at a word boundary instead of mid-word — so a long heading like
    "why-readers-are-switching-to-a-new-tool" stays whole rather than being
    cut mid-word at a hard character cap. Falls back to a hard cut if a
    single word genuinely exceeds the cap.
    """
    s = _concept_to_scene_phrase(heading)
    raw = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-")
    if not raw:
        return f"inline-{idx+1}"
    if len(raw) <= _SLUG_MAX:
        return raw
    cut = raw[:_SLUG_MAX]
    last_dash = cut.rfind("-")
    if last_dash > _SLUG_MAX // 2:
        cut = cut[:last_dash]
    return cut.rstrip("-")


# ---------- Provider calls ----------

_GEMINI_ASPECTS = (
    # (label, ratio_w_over_h)
    ("1:1",  1.0),
    ("3:2",  1.5),
    ("2:3",  2/3),
    ("4:3",  4/3),
    ("3:4",  3/4),
    ("5:4",  5/4),
    ("4:5",  4/5),
    ("16:9", 16/9),
    ("9:16", 9/16),
    ("21:9", 21/9),
)


def _target_size_to_gemini_aspect(target: tuple[int, int]) -> str:
    w, h = target
    target_ratio = w / h
    return min(_GEMINI_ASPECTS, key=lambda c: abs(target_ratio - c[1]))[0]


def call_gemini(prompt: str, api_key: str, aspect_ratio: str | None = None) -> bytes:
    """Generate via Gemini 3.1 Flash Image. Returns raw image bytes.

    If `aspect_ratio` is provided (e.g., "16:9"), it's passed via
    generationConfig.imageConfig.aspectRatio. At the default 1K imageSize,
    16:9 → 1376x768, 3:2 → 1264x848, 1:1 → 1024x1024.
    Note: the model occasionally ignores aspect_ratio (per Google's own bug
    reports) — caller should defensively check returned dimensions.
    """
    gen_cfg: dict = {"responseModalities": ["IMAGE", "TEXT"]}
    if aspect_ratio:
        gen_cfg["imageConfig"] = {"aspectRatio": aspect_ratio}
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": gen_cfg,
    }
    r = requests.post(
        GEMINI_ENDPOINT, params={"key": api_key},
        json=body, headers={"Content-Type": "application/json"},
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini API {r.status_code}: {r.text[:600]}")
    data = r.json()
    for c in (data.get("candidates") or []):
        for part in c.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise RuntimeError(f"Gemini: no image in response: {json.dumps(data)[:600]}")


def _openai_size_for(target_size: tuple[int, int]) -> str:
    """Pick the closest gpt-image-1-supported size to our target aspect."""
    w, h = target_size
    aspect = w / h
    # Supported: 1024x1024 (1.0), 1536x1024 (1.5), 1024x1536 (0.667)
    if aspect >= 1.25:
        return "1536x1024"
    if aspect <= 0.8:
        return "1024x1536"
    return "1024x1024"


def call_openai(prompt: str, api_key: str, target_size: tuple[int, int]) -> tuple[bytes, str, float]:
    """Generate via OpenAI gpt-image-1. Returns (bytes, size_used, cost_usd)."""
    size = _openai_size_for(target_size)
    body = {
        "model": OPENAI_MODEL,
        "prompt": prompt,
        "size": size,
        "quality": "medium",
        "n": 1,
    }
    r = requests.post(
        OPENAI_ENDPOINT, json=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=180,
    )
    if r.status_code != 200:
        raise RuntimeError(f"OpenAI API {r.status_code}: {r.text[:600]}")
    data = r.json()
    if not data.get("data"):
        raise RuntimeError(f"OpenAI: no image in response: {json.dumps(data)[:600]}")
    b64 = data["data"][0].get("b64_json")
    if not b64:
        raise RuntimeError(f"OpenAI: no b64_json in first data entry: {json.dumps(data['data'][0])[:300]}")
    cost = OPENAI_COST_USD_SQUARE if size == "1024x1024" else OPENAI_COST_USD_LANDSCAPE
    return base64.b64decode(b64), size, cost


def _generate_once(
    prompt: str,
    target_size: tuple[int, int],
    creds: dict[str, str | None],
    order: tuple[str, ...],
    aspect_ratio: str | None = None,
) -> tuple[bytes, dict]:
    """Single generation attempt across providers in order. No review."""
    attempts: list[dict] = []
    aspect = aspect_ratio or _target_size_to_gemini_aspect(target_size)
    for provider in order:
        if provider == "gemini" and creds.get("gemini"):
            try:
                img = call_gemini(prompt, creds["gemini"], aspect_ratio=aspect)
                return img, {
                    "provider": "gemini",
                    "model": GEMINI_MODEL,
                    "aspect_ratio": aspect,
                    "cost_usd": GEMINI_COST_USD,
                    "attempts": attempts,
                }
            except Exception as e:
                attempts.append({"provider": "gemini", "error": str(e)[:300]})
        elif provider == "openai" and creds.get("openai"):
            try:
                img, size_used, cost = call_openai(prompt, creds["openai"], target_size)
                return img, {
                    "provider": "openai",
                    "model": OPENAI_MODEL,
                    "size_generated": size_used,
                    "cost_usd": cost,
                    "attempts": attempts,
                }
            except Exception as e:
                attempts.append({"provider": "openai", "error": str(e)[:300]})
    raise RuntimeError(f"All providers failed: {attempts}")


REVIEW_MODEL = "gpt-5.5"
REVIEW_ENDPOINT = "https://api.openai.com/v1/chat/completions"
REVIEW_COST_USD = 0.01  # rough; image-input chat completion at gpt-5.5 scale


def review_image(image_bytes: bytes, openai_key: str, allow_text: bool = False) -> dict:
    """Cross-vendor QA. Returns {pass: bool, issues: [str], reviewer_notes: str}.

    Uses OpenAI vision so the generator (Gemini/OpenAI image)
    cannot bless its own slop.

    When allow_text=True the reviewer skips the text-presence check entirely —
    used for UI-mockup style images where labels/numbers are appropriate.
    """
    b64 = base64.b64encode(image_bytes).decode("ascii")
    system = (
        "You are a strict image QA reviewer for a marketing blog. Reject "
        "anything that would embarrass a publisher who cares about craft. "
        "Be skeptical and look closely. Return JSON only."
    )
    text_clause = (
        "1. (TEXT CHECK SKIPPED — text is allowed in this image; do not flag any presence of letters/numbers/words)\n"
        if allow_text
        else "1. READABLE text / letters / numbers anywhere (signs, banners, papers, books, screens). Decorative non-letter shapes on bags or fabric are FINE.\n"
    )
    rubric = (
        "Examine this generated illustration. You are reviewing for clear "
        "obvious craft failures, NOT minor stylistic choices. Be strict on "
        "the failure modes below; be lenient on subjective composition.\n\n"
        "FAIL ON (clear, obvious problems):\n"
        + text_clause +
        "2. Anatomy errors: extra or missing limbs, partial bodies clipping "
        "through windshields or walls, fused hands, extra fingers, missing "
        "facial features, impossibly twisted poses.\n"
        "3. Physics/spatial errors: floating objects, tailgates or doors in "
        "impossible orientations, items merging unnaturally, objects clipping "
        "through solid surfaces, people standing inside car roofs, gear "
        "balancing impossibly.\n"
        "4. Hands and feet: extra fingers, fused fingers, claw-shaped hands, "
        "feet pointing the wrong direction.\n"
        "5. LARGE EXPLICIT real-world logos (a giant Coca-Cola bottle, a "
        "clearly-readable McDonald's sign, a Nike swoosh dominating the "
        "front of a shirt). Small subtle athletic-stripe suggestions are "
        "FINE — that's editorial realism.\n"
        "6. DEVICE ORIENTATION: a phone, tablet, laptop, or watch held by a "
        "character with the screen pointed AT THE VIEWER instead of toward "
        "the character's own face. The screen should face the holder.\n\n"
        "DO NOT FAIL ON:\n"
        "- Intentional negative space (e.g. subjects extending into sky or a "
        "quieter zone — that's editorial composition).\n"
        "- Subtle brand-suggestion patterns (small side stripes, generic "
        "chevrons, plain stitching detail).\n"
        "- Stylization choices (slightly cartoony proportions, painterly "
        "abstraction, exaggerated colors).\n"
        "- Image-edge framing or aspect-ratio decisions.\n\n"
        "Return JSON: "
        '{"pass": boolean, "issues": [array of specific concrete problems — empty if pass=true], '
        '"reviewer_notes": "one short sentence overall impression"}'
    )
    body = {
        "model": REVIEW_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": rubric},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            },
        ],
        "response_format": {"type": "json_object"},
        # GPT-5.x are reasoning models — token budget covers reasoning + visible output.
        # 500 was too tight; bump to 4000 so reasoning has room and the JSON answer survives.
        "max_completion_tokens": 4000,
        # Keep reasoning shallow — image QA against an explicit rubric isn't a hard problem.
        # Valid for gpt-5.x: none / low / medium / high / xhigh. Using 'low' for fast
        # rubric-based judgement without burning the entire token budget on reasoning.
        "reasoning_effort": "low",
    }
    r = requests.post(
        REVIEW_ENDPOINT, json=body,
        headers={"Authorization": f"Bearer {openai_key}", "Content-Type": "application/json"},
        timeout=120,
    )
    if r.status_code != 200:
        return {
            "pass": True,
            "issues": [],
            "reviewer_notes": f"reviewer unreachable ({r.status_code}): {r.text[:300]}",
            "reviewer_skipped": True,
        }
    try:
        raw = r.json()
        content = raw["choices"][0]["message"]["content"]
        if not content or not content.strip():
            finish = raw["choices"][0].get("finish_reason", "?")
            usage = raw.get("usage", {})
            return {
                "pass": True,
                "issues": [],
                "reviewer_notes": f"reviewer returned empty content (finish={finish}, usage={usage}); skipped",
                "reviewer_skipped": True,
            }
        parsed = json.loads(content)
    except Exception as e:
        return {
            "pass": True,
            "issues": [],
            "reviewer_notes": f"reviewer returned malformed JSON ({e}); skipped",
            "reviewer_skipped": True,
        }
    parsed.setdefault("pass", True)
    parsed.setdefault("issues", [])
    parsed.setdefault("reviewer_notes", "")
    return parsed


def _retry_prompt_with_feedback(original_prompt: str, issues: list[str]) -> str:
    """Augment the original JSON prompt with reviewer-flagged issues so the
    second attempt explicitly avoids the problems the first hit.
    """
    retry_block = {
        "previous_attempt_failed_review": True,
        "issues_to_avoid_this_time": issues,
        "directive": "Regenerate from scratch. The issues above are critical. Do not repeat them.",
    }
    return original_prompt + "\n\n" + json.dumps(retry_block, indent=2, ensure_ascii=False)


def generate_with_fallback(
    prompt: str,
    target_size: tuple[int, int],
    creds: dict[str, str | None],
    order: tuple[str, ...] = DEFAULT_PROVIDER_ORDER,
    enable_review: bool = True,
    allow_text: bool = False,
    aspect_ratio: str | None = None,
) -> tuple[bytes, dict]:
    """Generate, review, retry-on-fail (max 1 retry). Returns (bytes, metadata)."""
    img, gen_meta = _generate_once(prompt, target_size, creds, order, aspect_ratio=aspect_ratio)
    review_meta: dict = {}
    review_cost = 0.0
    if enable_review and creds.get("openai"):
        review = review_image(img, creds["openai"], allow_text=allow_text)
        review_cost += REVIEW_COST_USD if not review.get("reviewer_skipped") else 0.0
        review_meta = {"review_attempt_1": review}
        if not review.get("pass"):
            retry_prompt = _retry_prompt_with_feedback(prompt, review.get("issues") or [])
            try:
                img2, gen_meta2 = _generate_once(retry_prompt, target_size, creds, order, aspect_ratio=aspect_ratio)
                review2 = review_image(img2, creds["openai"], allow_text=allow_text)
                review_cost += REVIEW_COST_USD if not review2.get("reviewer_skipped") else 0.0
                review_meta["review_attempt_2"] = review2
                if review2.get("pass"):
                    img = img2
                    gen_meta["cost_usd"] += gen_meta2["cost_usd"]
                    gen_meta["retried"] = True
                else:
                    # Both attempts failed review. Keep the second one but flag.
                    img = img2
                    gen_meta["cost_usd"] += gen_meta2["cost_usd"]
                    gen_meta["retried"] = True
                    gen_meta["review_failed_twice"] = True
            except Exception as e:
                review_meta["retry_error"] = str(e)[:300]
    gen_meta["review"] = review_meta
    gen_meta["review_cost_usd"] = round(review_cost, 4)
    gen_meta["cost_usd"] = round(gen_meta["cost_usd"] + review_cost, 4)
    return img, gen_meta


# ---------- Save / convert ----------

def save_webp(png_bytes: bytes, dest: Path, target_size: tuple[int, int] | None = None) -> None:
    """Save the model's image bytes as a WebP. Avoids destructive cropping when
    the source aspect ratio already matches the target — only resizes. Falls
    back to a center-crop only when aspects genuinely diverge (legacy gpt-image-1
    paths where size choices are coarse), and warns when it does.
    """
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    if target_size:
        tw, th = target_size
        sw, sh = img.size
        target_ratio = tw / th
        source_ratio = sw / sh
        # 2% tolerance — Gemini's nominal sizes (1376x768 = 1.792 vs 16:9 = 1.778)
        # are within 1% of canonical, so this catches "intentionally same aspect".
        if abs(source_ratio - target_ratio) / target_ratio > 0.02:
            print(
                f"WARN save_webp: source {sw}x{sh} (ratio {source_ratio:.3f}) "
                f"differs from target {tw}x{th} (ratio {target_ratio:.3f}) — "
                f"center-cropping. If this image lost important content, request "
                f"a matching aspect_ratio from the provider."
            )
            if source_ratio > target_ratio:
                new_w = int(sh * target_ratio)
                x = (sw - new_w) // 2
                img = img.crop((x, 0, x + new_w, sh))
            else:
                new_h = int(sw / target_ratio)
                y = (sh - new_h) // 2
                img = img.crop((0, y, sw, y + new_h))
        if img.size != (tw, th):
            img = img.resize((tw, th), Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "WEBP", quality=85, method=6)


# ---------- Spend log ----------

def archive_existing(out_webp: Path, sidecar: Path, slug: str, role: str) -> dict | None:
    """Move an existing image (and its sidecar) to rejected/<slug>/ with a timestamp.

    Called before regenerating an image so we never silently overwrite prior
    output. Returns metadata about what was archived, or None if there was
    nothing to move.
    """
    if not out_webp.exists():
        return None
    ts = time.strftime("%Y%m%d-%H%M%S")
    target_dir = REJECTED_DIR / slug
    target_dir.mkdir(parents=True, exist_ok=True)
    archived_webp = target_dir / f"{role}-{ts}.webp"
    archived_json = target_dir / f"{role}-{ts}.prompt.json"
    out_webp.rename(archived_webp)
    record = {"archived_webp": str(archived_webp), "archived_at": ts}
    if sidecar.exists():
        sidecar.rename(archived_json)
        record["archived_sidecar"] = str(archived_json)
    return record


def append_spend(entry: dict) -> None:
    SPEND_LOG.parent.mkdir(parents=True, exist_ok=True)
    log = []
    if SPEND_LOG.exists():
        try:
            log = json.loads(SPEND_LOG.read_text(encoding="utf-8") or "[]")
        except json.JSONDecodeError:
            log = []
    log.append(entry)
    SPEND_LOG.write_text(json.dumps(log, indent=2), encoding="utf-8")


def write_completed_line(slug: str, count: int, cost: float, style: str) -> None:
    COMPLETED_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M')} | {slug} | {count} images (style {style}) | ${cost:.2f}\n"
    with COMPLETED_LOG.open("a", encoding="utf-8") as f:
        f.write(line)


# ---------- Main ----------

def _style_default_routing(style: str) -> tuple[tuple[str, ...], bool]:
    """Default provider order and allow_text flag for a given style.

    Both styles route to Gemini 3.1 Flash. Style A still permits text in the
    image (UI labels, price tags, comparison headers); Style B forbids text.
    Note: Style A previously used gpt-image-1, but Gemini 3.1 produces better
    output across the board. Will revisit Style-A→OpenAI once gpt-image-2 opens up.
    """
    if style == "A":
        return ("gemini",), True
    return ("gemini",), False


def generate_one_article(
    slug: str,
    hero_only: bool,
    dry_run: bool,
    n_inline: int,
    skip_existing: bool = False,
    enable_review: bool = True,
    provider_order: tuple[str, ...] | None = None,
    allow_text: bool | None = None,
) -> dict:
    md_path = ARTICLES_DIR / f"{slug}.md"
    if not md_path.exists():
        raise SystemExit(f"Article not found: {md_path}")
    article = parse_article(md_path)
    if article.is_stub:
        raise SystemExit(
            f"Article '{slug}' looks like a stub ({len(article.body.strip())} chars). "
            f"Skipping per Maya's rule. Re-run with --force to override."
        )

    style = pick_style(article)
    # Resolve style-aware defaults, but let explicit overrides win.
    style_provider, style_allow_text = _style_default_routing(style)
    if provider_order is None:
        provider_order = style_provider
    if allow_text is None:
        allow_text = style_allow_text
    creds = get_credentials() if not dry_run else {"gemini": None, "openai": None}

    # Per-article brief can override target size + aspect ratio per role.
    brief = _load_article_brief(article.slug)
    hero_brief = brief.get("hero") or {}
    inline_briefs = brief.get("inline") or {}

    def _job_size_aspect(role: str, default_size: tuple[int, int]) -> tuple[tuple[int, int], str | None]:
        spec = hero_brief if role == "hero" else (inline_briefs.get(role) or {})
        size = tuple(spec.get("target_size") or default_size)
        aspect = spec.get("aspect_ratio")
        return size, aspect

    hero_size, hero_aspect = _job_size_aspect("hero", (1200, 630))
    jobs: list[tuple[str, str, tuple[int, int], str | None]] = [
        ("hero", hero_prompt(article, style, allow_text=allow_text), hero_size, hero_aspect)
    ]
    if not hero_only:
        for role, prompt in inline_prompts(article, style, n=n_inline, allow_text=allow_text):
            size, aspect = _job_size_aspect(role, (1024, 1024))
            jobs.append((role, prompt, size, aspect))

    results = []
    total_cost = 0.0
    for role, prompt, size, aspect in jobs:
        # Per-article subfolder structure: <slug>/<role>.webp
        out_webp = IMAGES_DIR / slug / f"{role}.webp"
        sidecar = IMAGES_DIR / slug / f"{role}.prompt.json"
        out_webp.parent.mkdir(parents=True, exist_ok=True)
        record: dict = {
            "slug": slug, "role": role,
            "size_target": list(size), "aspect_ratio_requested": aspect,
            "style": style,
            "prompt": prompt, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "out_path": str(out_webp),
        }
        if skip_existing and out_webp.exists():
            record["status"] = "skipped (already exists)"
            record["provider"] = None
            record["model"] = None
            record["cost_usd"] = 0.0
            results.append(record)
            continue
        if dry_run:
            record["status"] = "dry-run"
            record["provider"] = "n/a"
            record["model"] = "n/a"
            record["cost_usd"] = 0.0
            results.append(record)
            continue
        try:
            img_bytes, meta = generate_with_fallback(
                prompt, size, creds,
                order=provider_order,
                enable_review=enable_review,
                allow_text=allow_text,
                aspect_ratio=aspect,
            )
            archived = archive_existing(out_webp, sidecar, slug, role)
            if archived:
                record["archived_previous"] = archived
            save_webp(img_bytes, out_webp, target_size=size)
            record.update(meta)
            sidecar.write_text(json.dumps(record, indent=2), encoding="utf-8")
            append_spend(record)
            total_cost += meta["cost_usd"]
            record["status"] = "ok"
            record["bytes"] = len(img_bytes)
        except Exception as e:
            record["status"] = "error"
            record["error"] = str(e)[:600]
        results.append(record)

    if not dry_run:
        ok_count = sum(1 for r in results if r["status"] == "ok")
        write_completed_line(slug, ok_count, total_cost, style)

    return {
        "slug": slug, "title": article.title,
        "style": style, "is_stub": article.is_stub,
        "results": results, "total_cost_usd": total_cost,
    }


def main():
    ap = argparse.ArgumentParser(description="Maya — generate blog images")
    ap.add_argument("slug", nargs="?", help="Article slug (filename without .md)")
    ap.add_argument("--list", action="store_true", help="List articles missing hero images")
    ap.add_argument("--hero-only", action="store_true")
    ap.add_argument("--inline", type=int, default=2, help="Number of inline images (default 2)")
    ap.add_argument("--dry-run", action="store_true", help="Print plan, don't call API or write files")
    ap.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip generating any image whose .webp already exists. Useful for retrying just the failed images from a prior run.",
    )
    ap.add_argument(
        "--no-review",
        action="store_true",
        help="Skip the cross-vendor vision-review pass. Faster and slightly cheaper but ships without a sanity check.",
    )
    ap.add_argument(
        "--provider",
        choices=["auto", "gemini", "openai"],
        default="auto",
        help=(
            "Image generator provider. 'auto' = style-aware default "
            "(currently Gemini for both styles). 'gemini' or 'openai' forces single provider."
        ),
    )
    ap.add_argument(
        "--allow-text",
        dest="allow_text",
        action="store_const",
        const=True,
        default=None,
        help="Force text allowed (override style default).",
    )
    ap.add_argument(
        "--no-text",
        dest="allow_text",
        action="store_const",
        const=False,
        help="Force text forbidden (override style default).",
    )
    args = ap.parse_args()

    if args.list:
        missing = list_articles_missing_images()
        for a in missing:
            stub_tag = " [STUB]" if a.is_stub else ""
            print(f"  {a.slug}{stub_tag}  ({len(a.body.strip())} chars)")
        print(f"\nTotal missing hero images: {len(missing)} (including stubs)")
        return 0

    if not args.slug:
        ap.error("provide a slug or --list")

    # 'auto' means "let the article's style decide" — pass None down so generate_one_article applies _style_default_routing.
    provider_order: tuple[str, ...] | None = {
        "auto": None,
        "gemini": ("gemini",),
        "openai": ("openai",),
    }[args.provider]

    report = generate_one_article(
        args.slug, args.hero_only, args.dry_run, args.inline,
        args.skip_existing,
        enable_review=not args.no_review,
        provider_order=provider_order,
        allow_text=args.allow_text,  # already None when not explicitly set
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
