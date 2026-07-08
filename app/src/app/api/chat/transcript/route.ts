import path from "node:path";
import { readChatState } from "@/lib/chat-state";
import { resolveProjectCwd } from "@/lib/projects";
import { parseSessionLog, sessionLogPath } from "@/lib/session-log";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("project") || null;

  const state = await readChatState(slug);
  if (!state?.sessionId) {
    return new Response(
      JSON.stringify({ messages: [], sessionId: null, hasSession: false }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  let cwd: string;
  if (slug) {
    const resolved = resolveProjectCwd(slug);
    if (!resolved) {
      return new Response(
        JSON.stringify({ error: `Unknown project: ${slug}` }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    cwd = resolved;
  } else {
    // Match the chat route: CVB's default chat lives in app/.
    cwd = path.join(getConfig().aiteamDir, "app");
  }

  const logPath = sessionLogPath(cwd, state.sessionId);
  const messages = await parseSessionLog(logPath);

  return new Response(
    JSON.stringify({
      messages,
      sessionId: state.sessionId,
      hasSession: true,
      count: messages.length,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
