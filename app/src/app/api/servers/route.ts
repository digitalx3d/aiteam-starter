import { getServersSnapshot } from "@/lib/servers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/servers — status of our local servers. Read-only; there is no POST. */
export async function GET() {
  const snap = await getServersSnapshot();
  return new Response(JSON.stringify(snap), {
    headers: { "Content-Type": "application/json" },
  });
}
