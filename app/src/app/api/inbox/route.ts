import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseInbox } from "@/lib/inbox-parse";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const inboxPath = path.join(getConfig().aiteamDir, "inbox-shared.md");
  try {
    const text = await readFile(inboxPath, "utf8");
    const entries = parseInbox(text);
    return new Response(JSON.stringify({ entries, path: inboxPath }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ entries: [], path: inboxPath, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
