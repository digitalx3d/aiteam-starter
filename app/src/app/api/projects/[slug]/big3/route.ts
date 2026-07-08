import {
  readBig3,
  writeBig3,
  BIG3_SLOT_COUNT,
  type Big3Item,
  type Big3CompletedItem,
} from "@/lib/big3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string }>;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(_request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const data = await readBig3(slug);
  if (!data) return jsonError("project not found", 404);
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;

  let body: { active?: unknown; completed?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid json", 400);
  }

  const active: Big3Item[] = Array.isArray(body?.active)
    ? body.active
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .map((it) => ({
          text: typeof it.text === "string" ? it.text : "",
          done: Boolean(it.done),
        }))
        .slice(0, BIG3_SLOT_COUNT)
    : [];

  const completed: Big3CompletedItem[] = Array.isArray(body?.completed)
    ? body.completed
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .map((it) => ({
          text: typeof it.text === "string" ? it.text : "",
          completedAt:
            typeof it.completedAt === "string" ? it.completedAt : "",
        }))
        .filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.completedAt))
    : [];

  try {
    const ok = await writeBig3(slug, { active, completed });
    if (!ok) return jsonError("project not found", 404);
  } catch (err) {
    return jsonError((err as Error).message, 500);
  }

  return new Response(JSON.stringify({ ok: true, active, completed }), {
    headers: { "Content-Type": "application/json" },
  });
}
