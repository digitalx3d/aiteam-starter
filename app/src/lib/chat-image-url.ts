const DEFAULT_PROJECT_SLUG = "aiTeam";

/**
 * Convert an image src (from markdown, agent output, anywhere) to a URL the
 * browser can fetch via the /api/files/[...path] route.
 *
 * Pass-through cases: http(s), data:, blob:, and absolute URL paths starting with "/".
 *
 * Recognised local forms:
 *   - "C:\\Code\\<project>\\chat-images\\<file>"  (Windows absolute path)
 *   - "C:/Code/<project>/chat-images/<file>"     (forward-slash absolute)
 *   - "chat-images/<file>"                        (relative — needs project context)
 *   - "<project>/chat-images/<file>"              (project-prefixed relative)
 *
 * Returns the original src untouched if it doesn't match any local form, so
 * unknown sources fall through to the browser's default handling.
 */
export function chatImageSrcToUrl(
  src: string | undefined,
  projectSlug?: string | null
): string {
  if (!src) return "";
  // Already a URL the browser can use directly.
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;

  // react-markdown / micromark URL-encodes backslashes to %5C before urlTransform
  // sees the value, so we have to undo that BEFORE replacing backslashes — both
  // forms (`C:\Code\...` raw and `C:%5CCode%5C...` encoded) must collapse to
  // forward slashes so the winMatch regex below recognises the path shape.
  const normalised = src
    .replace(/%5C/gi, "/")
    .replace(/\\/g, "/");
  const project = projectSlug || DEFAULT_PROJECT_SLUG;

  // Absolute Windows-style path: <drive>:/<...projects root...>/<project>/chat-images/...
  // Anchored on the "chat-images" segment (the segment before it is the project)
  // rather than the projects root's basename, so this module stays client-safe
  // and keeps working whatever the configured projects root is.
  const winMatch = normalised.match(/^[A-Za-z]:\/(.+)$/);
  if (winMatch) {
    const parts = winMatch[1].split("/");
    const ci = parts.indexOf("chat-images");
    if (ci >= 1) {
      const rest = parts.slice(ci - 1); // <project>/chat-images/...
      return "/api/files/" + rest.map(encodeURIComponent).join("/");
    }
    return src;
  }

  // Relative form starting with "chat-images/..." — scope to the chat's project.
  if (normalised.startsWith("chat-images/")) {
    const rest = normalised.split("/");
    return (
      "/api/files/" +
      [project, ...rest].map(encodeURIComponent).join("/")
    );
  }

  // Relative form starting with "<project>/chat-images/..." — use as-is under root.
  const segs = normalised.split("/");
  if (segs.length >= 3 && segs[1] === "chat-images") {
    return "/api/files/" + segs.map(encodeURIComponent).join("/");
  }

  return src;
}
