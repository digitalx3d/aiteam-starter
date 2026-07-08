import { discoverAgents } from "@/lib/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const agents = await discoverAgents();
  return new Response(JSON.stringify({ agents }), {
    headers: { "Content-Type": "application/json" },
  });
}
