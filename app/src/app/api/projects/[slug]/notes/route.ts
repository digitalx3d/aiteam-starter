import { listNotes, createNote } from "@/lib/notes";
import { resolveExistingProjectCwd } from "@/lib/projects";

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
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);
  const notes = await listNotes(slug);
  return new Response(JSON.stringify({ notes }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return jsonError("project not found", 404);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("invalid json");
  }

  const title = typeof body.title === "string" ? body.title : "";
  const text = typeof body.body === "string" ? body.body : "";
  const image = typeof body.image === "string" ? body.image : null;
  if (!title.trim() && !text.trim() && !image) {
    return jsonError("note must have a title, body, or image");
  }

  const note = await createNote(slug, { title, body: text, image });
  if (!note) return jsonError("failed to create note", 500);
  return new Response(JSON.stringify({ note }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
