/**
 * "This message looks like it is about a different project."
 *
 * The owner sometimes types a reply into whichever project chat happens to be open,
 * about a project that is not that one. The message then lands in the wrong
 * project's context and the right project never gets it. We already ship the
 * cure (move, and now delete). This is the cheap warning that fires before the
 * message goes out.
 *
 * The bar it has to clear: a false positive every day is worse than a miss
 * every week. A wrong nag trains people to ignore the thing entirely, and the
 * damage from a miss is one Move click. So this errs hard toward silence:
 *
 *  - Only distinctive names count. Terms are the project's own slug/name plus a
 *    short hand-written alias table; single common words are never derived from
 *    a multi-word project name ("Website Audit" must not match "website").
 *  - Code blocks, inline code, quoted lines, urls and file paths are stripped
 *    before matching, because a path is where a project name legitimately turns
 *    up in a message about something else entirely.
 *  - Naming the CURRENT project anywhere in the message silences it. "Port the
 *    BakerySite login into PodcastLaunch", typed in the PodcastLaunch chat, is a
 *    perfectly good message and must not be second-guessed.
 *  - The Dashboard / Bridge chat never fires at all. Cross-project talk is what
 *    that chat is for.
 *
 * Pure and client-safe: no node imports, so both the composer and a test can
 * call it.
 */

export interface MentionCandidate {
  slug: string;
  name: string;
}

export interface ProjectMention {
  slug: string;
  name: string;
  /** The words in the message that triggered it, for the warning copy. */
  matched: string;
}

/**
 * Extra names you actually use for a project in conversation. Keyed by
 * lowercased slug (the project's folder name). The slug and display name
 * already count on their own; add a nickname here when the warning misses one.
 * Example:
 *
 *   bakerysite: ["bakery site", "the bakery"],
 *
 * Only reasonably distinctive strings belong here. "dashboard" is deliberately
 * absent: it is ordinary English in a team chat.
 */
export const PROJECT_ALIASES: Record<string, string[]> = {
  aiteam: ["ai team", "the bridge"],
};

/** Words that are never a project mention on their own, whatever the slug is. */
const NEVER_ALONE = new Set([
  "app",
  "apps",
  "web",
  "site",
  "website",
  "tool",
  "test",
  "demo",
  "admin",
  "client",
  "server",
  "dashboard",
  "project",
  "vault",
  "audit",
  "setup",
  "deploy",
]);

const MIN_TERM_LENGTH = 5;

/** Lowercase, and flatten every separator to a single space. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Split a name into its words: camelCase humps, hyphens, underscores, spaces. */
function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * The strings that count as naming this project. Both the run-together form
 * ("bakerysite") and the spaced form ("bakery site"), since the message text is
 * normalized to spaces and only one of the two will be present.
 */
export function termsForProject(p: MentionCandidate): string[] {
  const out = new Set<string>();
  const sources = [p.slug, p.name, ...(PROJECT_ALIASES[p.slug.toLowerCase()] ?? [])];
  for (const raw of sources) {
    if (!raw) continue;
    const words = splitWords(raw);
    if (words.length === 0) continue;
    const joined = words.join("").toLowerCase();
    const spaced = words.join(" ").toLowerCase();
    // A single word has to be distinctive on its own; a multi-word name is
    // matched only as the whole phrase, never word by word.
    if (words.length === 1 && NEVER_ALONE.has(joined)) continue;
    if (joined.length >= MIN_TERM_LENGTH) out.add(joined);
    if (spaced.length >= MIN_TERM_LENGTH) out.add(spaced);
  }
  return [...out];
}

const FENCED_BLOCK = /```[\s\S]*?```/g;
const UNCLOSED_FENCE = /```[\s\S]*$/;
const INLINE_CODE = /`[^`\n]*`/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
// C:\Code\BakerySite\... and C:/Code/... alike.
const DRIVE_PATH = /\b[A-Za-z]:[\\/]\S*/g;
// Anything else with two or more path separators in one unbroken run.
const MULTI_SEGMENT_PATH = /\S*[\\/]\S*[\\/]\S*/g;

/**
 * Blank out the places a project name can appear without the message being
 * about that project: fenced and inline code, quoted lines, urls, and anything
 * path-shaped. Replaced with spaces rather than removed so nothing accidentally
 * gets glued into a new word.
 */
export function stripNonProse(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text
    .replace(FENCED_BLOCK, blank)
    .replace(UNCLOSED_FENCE, blank)
    .replace(INLINE_CODE, blank)
    .replace(QUOTED_LINE, blank)
    .replace(URL, blank)
    .replace(DRIVE_PATH, blank)
    .replace(MULTI_SEGMENT_PATH, blank);
}

/** Escape a term so it can sit inside a RegExp as a literal. */
function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
}

/**
 * The first OTHER project this message appears to be about, or null to stay
 * quiet. `currentSlug` is null for the Dashboard / Bridge chat, where naming
 * another project is the normal thing to do and nothing ever fires.
 */
export function detectOtherProject(
  text: string,
  currentSlug: string | null,
  projects: MentionCandidate[]
): ProjectMention | null {
  if (!currentSlug) return null;
  const prose = normalize(stripNonProse(text));
  if (!prose) return null;

  const hit = (term: string): boolean =>
    new RegExp("(?:^| )" + escapeForRegExp(term) + "(?:$| )").test(prose);

  // Talking about this project too? Then it belongs here. Say nothing.
  const current =
    projects.find((p) => p.slug === currentSlug) ??
    ({ slug: currentSlug, name: currentSlug } as MentionCandidate);
  if (termsForProject(current).some(hit)) return null;

  for (const p of projects) {
    if (p.slug === currentSlug) continue;
    for (const term of termsForProject(p)) {
      if (hit(term)) return { slug: p.slug, name: p.name, matched: term };
    }
  }
  return null;
}
