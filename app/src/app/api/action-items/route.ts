import { listActionItems, invalidateActionItems } from "@/lib/action-items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/action-items — every task assigned to the owner, across all
 * project boards. `?fresh=1` skips the short cache, for the page's own
 * re-read right after it changes a task.
 */
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("fresh") === "1") {
    invalidateActionItems();
  }
  const items = await listActionItems();
  return new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json" },
  });
}
