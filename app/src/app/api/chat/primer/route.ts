import { promises as fsp } from "node:fs";
import { rollingSummaryPath } from "@/lib/claude-persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/primer?project=<slug>
 *
 * Returns the current rolling primer for a chat scope (the same file CVB's
 * persona silently loads into his system prompt on the next session — see
 * claude-persona.ts). The chat UI polls this after a session ends to know
 * when the "here's where we left off" recap is ready to post, comparing
 * `updatedAt` against the timestamp the session was archived at.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("project");
  const scope = slug ? `project:${slug}` : "default";

  const filePath = rollingSummaryPath(scope);
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(filePath, "utf8"),
      fsp.stat(filePath),
    ]);
    // Strip the frontmatter block — the UI shows the recap prose, not the
    // machine metadata (title/scope/distill_model/etc).
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return new Response(
      JSON.stringify({ text: body || null, updatedAt: stat.mtimeMs }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch {
    return new Response(JSON.stringify({ text: null, updatedAt: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
