import { findLatestArchive } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/last-archive?project=<slug>
 *
 * Returns the most recently archived transcript for a chat scope, read
 * straight from the vault. The dashboard's "archived conversation" banner
 * fetches this fresh on every mount instead of trusting browser-cached
 * messages, which is what let stale/incomplete content silently show (or
 * get wiped by an unrelated reconcile) in the earlier version of this feature.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("project");
  const scope = slug ? `project:${slug}` : "default";

  const archive = await findLatestArchive(scope);
  if (!archive) {
    return new Response(JSON.stringify({ archive: null }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ archive }), {
    headers: { "Content-Type": "application/json" },
  });
}
