import { setInboxRead } from "@/lib/inbox-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark shared-inbox entries read or unread.
 *
 * Body: `{ "ids": ["<entry id>", ...], "read": true }`
 *
 * Read state lives on the server (~/.aiteam/inbox-state.json) rather than in
 * browser storage, so marking something read on the phone shows it read on the
 * desktop, and clearing site data no longer resurrects a month of entries.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { ids?: unknown; read?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
      : null;
    if (!ids) {
      return Response.json({ error: "ids must be an array of entry ids" }, { status: 400 });
    }
    if (typeof body.read !== "boolean") {
      return Response.json({ error: "read must be true or false" }, { status: 400 });
    }

    const read = await setInboxRead(ids, body.read);
    return Response.json({ read });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
