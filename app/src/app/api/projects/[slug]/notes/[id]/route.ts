import { updateNote, deleteNote } from "@/lib/notes";
import { resolveExistingProjectCwd } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ slug: string; id: string }>;
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function PATCH(request: Request, ctx: Ctx) {
  const { slug, id } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("invalid json");
  }

  const title = typeof body.title === "string" ? body.title : undefined;
  const text = typeof body.body === "string" ? body.body : undefined;
  const image =
    body.image === null ? null : typeof body.image === "string" ? body.image : undefined;

  const note = await updateNote(slug, id, { title, body: text, image });
  if (!note) return jsonError("note not found", 404);
  return new Response(JSON.stringify({ note }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const { slug, id } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);
  const ok = await deleteNote(slug, id);
  if (!ok) return jsonError("note not found", 404);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
