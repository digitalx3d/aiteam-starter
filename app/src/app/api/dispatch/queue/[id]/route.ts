import { cancel } from "@/lib/dispatch-queue";
import { cancelBoardTask, queueEnv } from "@/lib/dispatch-queue-effects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * DELETE /api/dispatch/queue/:id  (`dispatch.mjs --cancel <ticketId>`)
 * Remove a job that is still waiting (or waiting on a failed job). Works with
 * the queue switched off. A job that already started is a normal ticket and is
 * refused here. Anything queued after the cancelled job turns "waiting on a
 * failed job" on the next sweep (within 30 seconds) and says so in the chat.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  let res;
  try {
    res = cancel(queueEnv(), id);
  } catch (err) {
    res = { ok: false as const, error: `the dispatch queue could not be updated: ${(err as Error).message}` };
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ error: res.error }), {
      status: "notFound" in res && res.notFound ? 404 : 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  await cancelBoardTask(res.job);
  console.log(`[dispatch-queue] cancelled ${res.job.id} (${res.job.agent})`);
  return new Response(JSON.stringify({ cancelled: res.job.id, agent: res.job.agent, project: res.job.project }), {
    headers: { "Content-Type": "application/json" },
  });
}
