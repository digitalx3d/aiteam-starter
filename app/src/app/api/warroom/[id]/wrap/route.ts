import { getSession, requestCancel, requestWrap } from "@/lib/warroom-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/warroom/:id/wrap
 * Body: { save?: boolean }  (default true)
 * save=true  -> finish the current round, then synthesize + save the plan.
 * save=false -> cancel the session (kills in-flight agents, no plan written).
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

  let save = true;
  try {
    const body = (await request.json()) as { save?: boolean };
    if (typeof body.save === "boolean") save = body.save;
  } catch {
    /* default save=true */
  }

  if (save) requestWrap(id);
  else requestCancel(id);

  return new Response(JSON.stringify({ ok: true, save }), {
    headers: { "Content-Type": "application/json" },
  });
}
