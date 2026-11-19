import {
  deleteChatMessages,
  ChatEditError,
  chatBackupsDir,
  parseChatSlug,
  requestActor,
} from "@/lib/chat-move";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeleteBody {
  slug?: unknown;
  uuids?: unknown;
}

/**
 * Delete chat messages that belong nowhere.
 *
 * Body: `{ "slug": "BakerySite", "uuids": ["<id>", ...] }`
 * (`null` or absent slug means the default Dashboard chat.)
 *
 * The sibling of /api/chat/move, and deliberately the same shape. Both run the
 * identical surgery on the session log (lib/chat-move.ts); a delete is a move
 * with no destination. The log is copied to backupsDir first, which is the only
 * way back: nothing in the UI undoes this, so the response carries the command
 * that does.
 */
export async function POST(req: Request) {
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const uuids = Array.isArray(body.uuids)
    ? body.uuids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (uuids.length === 0) {
    return Response.json({ error: "uuids must be a non-empty array" }, { status: 400 });
  }

  const scope = await parseChatSlug(body.slug);
  if (!scope.ok) return Response.json({ error: scope.error }, { status: 400 });

  try {
    const result = await deleteChatMessages({
      slug: scope.slug,
      uuids,
      actor: requestActor(req),
    });
    return Response.json({ ...result, backupsDir: chatBackupsDir() });
  } catch (err) {
    if (err instanceof ChatEditError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    // File errors carry absolute paths; keep those in the server log.
    console.error("[api/chat/delete]", err);
    return Response.json({ error: "Delete failed on the server; nothing was changed." }, { status: 500 });
  }
}
