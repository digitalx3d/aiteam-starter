import path from "node:path";
import { spawnClaude } from "@/lib/claude-spawn";
import { buildVonBraunSystemPrompt } from "@/lib/claude-persona";
import { buildCvbHookSettings } from "@/lib/cvb-hooks";
import {
  getOrCreateSessionId,
  healSessionStateForCwd,
  markSessionStarted,
} from "@/lib/chat-state";
import { resolveProjectCwd } from "@/lib/projects";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequest {
  message: string;
  model?: string;
  /** Optional project slug. When set, the chat is scoped to that project (its own session, its own cwd). */
  project?: string;
  /** Permission mode for Claude CLI. Default: acceptEdits. */
  permissionMode?: "acceptEdits" | "bypassPermissions";
  /** Tool names to auto-approve for this turn (passed to --allowedTools). */
  allowedTools?: string[];
}

function sseFrame(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body?.message || typeof body.message !== "string") {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resolve project scope. Default = aiTeam Dashboard chat (no slug).
  const slug = body.project?.trim() || null;
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
    // CVB's default chat runs in app/ instead of the project root so its session
    // pool (~/.claude/projects/Z--GitHub-aiTeam-app/) doesn't collide with
    // Cursor's pool (~/.claude/projects/Z--GitHub-aiTeam/). See investigation
    // 2026-05-20: a shared cwd caused Cursor to auto-resume CVB's session.
    cwd = path.join(getConfig().aiteamDir, "app");
  }

  const rawState = await getOrCreateSessionId(slug);
  const state = await healSessionStateForCwd(rawState, cwd, slug);
  const sessionId = state.sessionId;
  const resume = state.started;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (frame: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };

      safeEnqueue(
        sseFrame(
          JSON.stringify({
            type: "session",
            sessionId,
            cwd,
            resume,
            project: slug,
          })
        )
      );

      // Bake the Claude Von Braun persona into newly-created sessions. Resumes inherit
      // the system prompt from the create turn, so re-passing it on resume would only
      // bloat context. The persona builder also layers in the rolling primer from the
      // previous ended session in this scope, if one exists.
      const scope = slug ? `project:${slug}` : "default";
      const appendSystemPrompt = resume
        ? undefined
        : (await buildVonBraunSystemPrompt(cwd, { scope })) ?? undefined;

      // VB needs Bash for operational glue (git, dev-server checks) and for
      // calling the dispatch helper script. Merge it in unconditionally so the
      // dashboard UI doesn't have to know about it.
      const mergedAllowedTools = Array.from(
        new Set([...(body.allowedTools ?? []), "Bash"])
      );

      let result;
      try {
        result = spawnClaude({
          cwd,
          sessionId,
          resume,
          message: body.message,
          model: body.model,
          permissionMode: body.permissionMode,
          allowedTools: mergedAllowedTools,
          // Block built-in tools that don't fit the dashboard's non-interactive
          // spawned-process model:
          //  - Task(): runs a subagent synchronously, blocking the chat — CVB
          //    must use the async dispatch.mjs instead.
          //  - AskUserQuestion: needs an interactive picker the dashboard has no
          //    channel for, so it resolves without John ever seeing the question
          //    (CVB ends up answering for him). CVB should ask in plain chat text.
          disallowedTools: ["Task", "AskUserQuestion"],
          appendSystemPrompt,
          // CVB's guard (blocks hand-rolling deliverables) + clock (injects current
          // time). Passed every turn — including resumes — so enforcement can't erode
          // mid-session. Only CVB's chat sessions get this; workers never do.
          settings: buildCvbHookSettings(),
        });
      } catch (err) {
        safeEnqueue(
          sseFrame(
            JSON.stringify({
              type: "error",
              message: `failed to spawn claude: ${(err as Error).message}`,
            })
          )
        );
        controller.close();
        closed = true;
        return;
      }

      const { child, exitPromise } = result;

      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          safeEnqueue(sseFrame(line));
        }
      });

      child.on("error", (err) => {
        safeEnqueue(
          sseFrame(
            JSON.stringify({
              type: "error",
              message: `subprocess error: ${err.message}`,
            })
          )
        );
      });

      const abort = () => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
      };
      request.signal.addEventListener("abort", abort);

      const { code, stderr } = await exitPromise;
      request.signal.removeEventListener("abort", abort);

      if (buffer.trim()) {
        safeEnqueue(sseFrame(buffer.trim()));
      }

      if (code !== 0) {
        safeEnqueue(
          sseFrame(
            JSON.stringify({
              type: "error",
              message: `claude exited with code ${code}`,
              stderr: stderr.slice(-2000),
            })
          )
        );
      } else if (!resume) {
        // First successful turn — mark the session as started so later turns use --resume
        try {
          await markSessionStarted(sessionId, slug);
        } catch {
          /* best-effort */
        }
      }

      safeEnqueue(sseFrame(JSON.stringify({ type: "done", code })));
      controller.close();
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
