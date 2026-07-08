import { getUsage } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/usage — live Claude subscription usage (5-hour + weekly windows).
 *  Cached ~60s server-side. Returns { ok:false } gracefully if unavailable. */
export async function GET() {
  const data = await getUsage();
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
