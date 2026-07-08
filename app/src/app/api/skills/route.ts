import { discoverAllSkills } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const skills = await discoverAllSkills();
  return new Response(JSON.stringify({ skills }), {
    headers: { "Content-Type": "application/json" },
  });
}
