import {
  readBig5,
  writeBig5,
  big5Revision,
  Big5ConflictError,
  type Big5Item,
  type CompletedItem,
} from "@/lib/big5";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await readBig5();
  const revision = await big5Revision();
  return new Response(JSON.stringify({ ...data, revision }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function PUT(request: Request) {
  let body: {
    active?: Big5Item[];
    completed?: CompletedItem[];
    revision?: string;
  };
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

  let revision: string;
  try {
    revision = await writeBig5(
      { active, completed },
      typeof body.revision === "string" ? body.revision : undefined
    );
  } catch (err) {
    // Somebody (a script, another tab, a terminal) wrote the file after this
    // client loaded it. Refuse, and hand back what the file actually says so
    // the caller can show the truth instead of silently winning.
    if (err instanceof Big5ConflictError) {
      return new Response(
        JSON.stringify({
          ok: false,
          conflict: true,
          error: err.message,
          active: err.current.active,
          completed: err.current.completed,
          revision: err.revision,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ ok: true, active, completed, revision }), {
    headers: { "Content-Type": "application/json" },
  });
}
