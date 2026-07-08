import { randomUUID } from "node:crypto";
import {
  appendMessage,
  getSession,
  queueInterjection,
} from "@/lib/warroom-store";
import { getOwnerName } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

// The human owner. The "john" slug is the stable internal id; the display
// name comes from config.
function ownerMember() {
  return {
    name: "john",
    displayName: getOwnerName().first,
    color: "purple",
    avatarUrl: "/avatars/john.webp" as string | null,
  };
}

/**
 * POST /api/warroom/:id/message
 * Body: { text }
 * John's interjection. Shows immediately as a bubble and is folded into the
 * next round's context for every agent.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { text?: string };
  try {
    body = (await request.json()) as { text?: string };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const text = body.text?.trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "text is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const owner = ownerMember();
  appendMessage(id, {
    id: randomUUID(),
    role: "human",
    agent: owner.name,
    displayName: owner.displayName,
    color: owner.color,
    avatarUrl: owner.avatarUrl,
    text,
    round: session.currentRound,
    ts: Date.now(),
  });
  queueInterjection(id, text);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
