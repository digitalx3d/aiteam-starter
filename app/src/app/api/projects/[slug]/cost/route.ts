import { getProjectCost } from "@/lib/project-costs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const data = await getProjectCost(slug);
  if (!data) {
    return new Response(JSON.stringify({ error: "project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
