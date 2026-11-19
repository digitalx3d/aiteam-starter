import path from "node:path";
import { spawnClaude } from "@/lib/claude-spawn";
import { buildVonBraunSystemPrompt } from "@/lib/claude-persona";
import { buildCvbHookSettings } from "@/lib/cvb-hooks";
import { readParkedMove, clearParkedMove } from "@/lib/chat-move";
import {
  getOrCreateSessionId,
  healSessionStateForCwd,
  markSessionStarted,
  markHeavyWarned,
  readChatState,
} from "@/lib/chat-state";
import { resolveProjectCwd } from "@/lib/projects";
import { getConfig } from "@/lib/config";
import { sessionLogPath } from "@/lib/session-log";
import { markLogLive } from "@/lib/session-log-lock";
import {
  countRealUserTurns,
  getCurrentContextTokens,
  HEAVY_TOKENS,
  MIN_TURNS,
  QUIET_MINUTES,
} from "@/lib/session-heaviness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Normalize a client-supplied effort value. Returns undefined for anything
 *  unrecognized so a bad value falls back to the CLI default instead of being
 *  passed through and erroring the spawn. */
function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? v : undefined;
}

interface ChatRequest {
  message: string;
  model?: string;
  /** Reasoning effort (low|medium|high|xhigh|max). Silently ignored on haiku,
   *  which has no --effort support (guarded in claude-spawn.ts). */
  effort?: string;
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

      // Text moved here from another project chat while this one had no session
      // to append to. It rides along with the next real message so the context
      // arrives without the agent being prompted to act on it on its own.
      let outgoingMessage = body.message;
      const parked = await readParkedMove(slug);
      if (parked) {
        outgoingMessage = `${parked}\n\n---\n\n${body.message}`;
        await clearParkedMove(slug);
      }

      // Tell the log editors (move, delete, worker-report posts) a turn is
      // running against this session, for as long as it runs. They refuse to
      // rewrite the log meanwhile; see lib/session-log-lock.ts.
      const releaseLive = await markLogLive(sessionLogPath(cwd, sessionId));

      let result;
      try {
        result = spawnClaude({
          cwd,
          sessionId,
          resume,
          message: outgoingMessage,
          model: body.model,
          effort: normalizeEffort(body.effort),
          permissionMode: body.permissionMode,
          allowedTools: mergedAllowedTools,
          // Block built-in tools that don't fit the dashboard's non-interactive
          // spawned-process model:
          //  - Task(): runs a subagent synchronously, blocking the chat — CVB
          //    must use the async dispatch.mjs instead.
          //  - AskUserQuestion: needs an interactive picker the dashboard has no
          //    channel for, so it resolves without the owner ever seeing the question
          //    (CVB ends up answering for them). CVB should ask in plain chat text.
          disallowedTools: ["Task", "AskUserQuestion"],
          appendSystemPrompt,
          // CVB's guard (blocks hand-rolling deliverables) + clock (injects current
          // time). Passed every turn — including resumes — so enforcement can't erode
          // mid-session. Only CVB's chat sessions get this; workers never do.
          settings: buildCvbHookSettings(),
        });
      } catch (err) {
        releaseLive();
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

      const { code, stderr } = await exitPromise.finally(releaseLive);
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

      // "Context is getting large" nudge — fires once per session, the turn it
      // first crosses HEAVY_TOKENS, but only once there's enough real back-and-
      // forth (MIN_TURNS) that the auto-archive sweep would actually apply to
      // it. Never blocks or fails the turn.
      if (code === 0) {
        try {
          const logPath = sessionLogPath(cwd, sessionId);
          const tokens = await getCurrentContextTokens(logPath);
          if (tokens >= HEAVY_TOKENS) {
            const currentState = await readChatState(slug);
            if (currentState && !currentState.heavyWarned) {
              const turns = await countRealUserTurns(logPath);
              if (turns >= MIN_TURNS) {
                await markHeavyWarned(currentState, slug);
                safeEnqueue(
                  sseFrame(
                    JSON.stringify({
                      type: "heavy-warning",
                      tokens,
                      turns,
                      quietMinutes: QUIET_MINUTES,
                    })
                  )
                );
              }
            }
          }
        } catch {
          /* best-effort — never block the turn on this */
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
