import { getSession, setPaused } from "@/lib/warroom-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/warroom/:id/pause
 * Body: { paused: boolean }
 * paused=true  -> the engine holds at the next round boundary (and before the
 *                 final write-up) so the owner can read and type.
 * paused=false -> resume.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  let paused = true;
  try {
    const body = (await request.json()) as { paused?: boolean };
    if (typeof body.paused === "boolean") paused = body.paused;
  } catch {
    /* default paused=true */
  }

  setPaused(id, paused);
  return new Response(JSON.stringify({ ok: true, paused }), {
    headers: { "Content-Type": "application/json" },
  });
}
