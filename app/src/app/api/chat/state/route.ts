import { readChatState } from "@/lib/chat-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const project = url.searchParams.get("project") || null;
  const state = await readChatState(project);
  return new Response(JSON.stringify({ state, project }), {
    headers: { "Content-Type": "application/json" },
  });
}
