import { getMonthlySpend } from "@/lib/monthly-spend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/spend/monthly — this month's token + USD consumption across all
 *  projects and sessions, per model. Cached ~5 min server-side. */
export async function GET() {
  try {
    const data = await getMonthlySpend();
    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
