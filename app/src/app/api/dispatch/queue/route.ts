import { isDispatchQueueEnabled } from "@/lib/config";
import { isActive, listJobs, readTicket } from "@/lib/dispatch-queue";
import { queueEnv } from "@/lib/dispatch-queue-effects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dispatch/queue[?project=<slug>][&all=1]
 * The dispatch queue (`dispatch.mjs --after`): jobs still waiting, and with
 * all=1 also ones released or cancelled in the last day. Each job carries
 * `afterAgent`, the teammate it is waiting on, for "queued after Casey".
 * `project=` with an empty value means project-less (aiTeam) jobs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const all = url.searchParams.get("all") === "1";
  const hasProject = url.searchParams.has("project");
  const project = url.searchParams.get("project") || null;
  const env = queueEnv();
  const everything = listJobs(env);
  const jobs = everything
    .filter((j) => all || isActive(j))
    .filter((j) => !hasProject || j.project === project)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((j) => ({
      ...j,
      afterAgent:
        readTicket(env, j.after)?.agent ?? everything.find((q) => q.id === j.after)?.agent ?? null,
    }));
  return new Response(JSON.stringify({ enabled: isDispatchQueueEnabled(), jobs }), {
    headers: { "Content-Type": "application/json" },
  });
}
