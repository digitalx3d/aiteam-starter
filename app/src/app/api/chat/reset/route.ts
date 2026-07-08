import { deleteChatState } from "@/lib/chat-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const project = url.searchParams.get("project") || null;
  try {
    await deleteChatState(project);
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response(JSON.stringify({ ok: true, project }), {
    headers: { "Content-Type": "application/json" },
  });
}
