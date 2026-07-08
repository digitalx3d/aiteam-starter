import {
  readBig5,
  writeBig5,
  type Big5Item,
  type CompletedItem,
} from "@/lib/big5";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await readBig5();
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(request: Request) {
  let body: { active?: Big5Item[]; completed?: CompletedItem[] };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const active: Big5Item[] = Array.isArray(body?.active)
    ? body.active
        .filter((it) => it && typeof it === "object")
        .map((it) => ({
          text: typeof it.text === "string" ? it.text : "",
          done: Boolean(it.done),
        }))
    : [];

  const completed: CompletedItem[] = Array.isArray(body?.completed)
    ? body.completed
        .filter((it) => it && typeof it === "object")
        .map((it) => ({
          text: typeof it.text === "string" ? it.text : "",
          completedAt:
            typeof it.completedAt === "string" ? it.completedAt : "",
        }))
        .filter((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.completedAt))
    : [];

  try {
    await writeBig5({ active, completed });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ ok: true, active, completed }), {
    headers: { "Content-Type": "application/json" },
  });
}
