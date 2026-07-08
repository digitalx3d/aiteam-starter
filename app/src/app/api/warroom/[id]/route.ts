import { getSession } from "@/lib/warroom-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/warroom/:id — lightweight existence/status check used to decide
 *  whether a remembered session can be re-joined after a page navigation. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      id: session.id,
      status: session.status,
      currentRound: session.currentRound,
      rounds: session.rounds,
      idea: session.idea,
      objective: session.objective,
      title: session.title,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
