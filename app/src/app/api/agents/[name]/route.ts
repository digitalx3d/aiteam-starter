import { getAgentDetail } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ name: string }>;
}

export async function GET(_request: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const detail = await getAgentDetail(name);
  if (!detail) {
    return new Response(JSON.stringify({ error: "agent not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ agent: detail }), {
    headers: { "Content-Type": "application/json" },
  });
}
