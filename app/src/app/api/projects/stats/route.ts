import { discoverProjects } from "@/lib/projects";
import { getProjectStats, earliestDay } from "@/lib/project-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spend / tokens / engaged time for every project, from the accumulating store.
 *
 * Served separately from the projects page rather than rendered with it: the very
 * first call has to parse the whole transcript archive (~460 MB) and takes a
 * minute or two. Every call after that is fast, because only changed transcripts
 * are re-read. Keeping it on its own endpoint lets the page paint immediately and
 * fill these numbers in when they arrive.
 */
export async function GET() {
  const projects = await discoverProjects();
  const stats = await getProjectStats(
    projects.map((p) => ({ slug: p.slug, cwd: p.path }))
  );
  return new Response(
    JSON.stringify({ projects: stats, since: earliestDay(stats) }),
    { headers: { "Content-Type": "application/json" } }
  );
}
