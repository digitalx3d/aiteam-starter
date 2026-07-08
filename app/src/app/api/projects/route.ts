import { discoverProjects, getProjectsRoot } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const projects = await discoverProjects();
  return new Response(JSON.stringify({ root: getProjectsRoot(), projects }), {
    headers: { "Content-Type": "application/json" },
  });
}
