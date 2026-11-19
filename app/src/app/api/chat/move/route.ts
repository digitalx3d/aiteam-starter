import { moveChatMessages, MoveError, parseChatSlug, requestActor } from "@/lib/chat-move";

import { getOwnerName } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MoveBody {
  from?: unknown;
  to?: unknown;
  uuids?: unknown;
}

/**
 * Move chat messages posted in the wrong project chat into the right one.
 *
 * Body: `{ "from": "PodcastLaunch", "to": "BakerySite", "uuids": ["<id>", ...] }`
 * (`null` for either slug means the default Dashboard chat.)
 *
 * The ids are the ones the chat UI already renders with: session-log entry
 * uuids. See lib/chat-move.ts for what the move actually does to the logs.
 */
export async function POST(req: Request) {
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
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

  const from = await parseChatSlug(body.from);
  if (!from.ok) return Response.json({ error: from.error }, { status: 400 });
  const to = await parseChatSlug(body.to);
  if (!to.ok) return Response.json({ error: to.error }, { status: 400 });
  const fromSlug = from.slug;
  const toSlug = to.slug;

  try {
    const result = await moveChatMessages(
      { fromSlug, toSlug, uuids, actor: requestActor(req) },
      {
        owner: getOwnerName().first,
        agent: "Claude",
      }
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof MoveError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    // File errors carry absolute paths; keep those in the server log.
    console.error("[api/chat/move]", err);
    return Response.json({ error: "Move failed on the server." }, { status: 500 });
  }
}
