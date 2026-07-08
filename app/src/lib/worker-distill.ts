import path from "node:path";
import { promises as fsp } from "node:fs";
import type { ChatMessage } from "./types";
import { getConfig } from "./config";
import { parseSessionLog, sessionLogPath } from "./session-log";
import { loadAgentForDispatch } from "./agents";
import { runClaudeJson, capTranscript, logDistillLine } from "./claude-distill";

/**
 * Worker primers (short-term memory Priority 3, approved 2026-07-02).
 *
 * The End-Session distiller is CVB-shaped (it writes "you are Claude Von
 * Braun" primers). This is the worker-shaped counterpart the warm-pool spec
 * deferred: when a worker's warm session retires, its transcript is distilled
 * into a small primer at vault/agents/<agent>/summaries/<project>.md, and the
 * next FRESH session for that (agent, project) pair loads it - so recycling
 * stops being amnesiac.
 *
 * Cost/latency posture: distillation is fire-and-forget in the background
 * (nobody waits on it); the primer adds at most ~2k tokens to a fresh spawn
 * and is intentionally NOT sent on warm resumes (already in the session).
 */

const WORKER_TOKEN_CAP = 2000;

function projectKey(project: string | null): string {
  return (project ?? "_aiteam").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function workerSummaryPath(agent: string, project: string | null): string {
  return path.join(
    getConfig().vaultDir,
    "agents",
    agent.replace(/[^a-zA-Z0-9._-]/g, "-"),
    "summaries",
    `${projectKey(project)}.md`
  );
}

/** Read the primer for a fresh (agent, project) spawn. Null when none exists. */
export async function loadWorkerPrimer(
  agent: string,
  project: string | null
): Promise<string | null> {
  try {
    const raw = await fsp.readFile(workerSummaryPath(agent, project), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/** Wrap a primer for appending to a worker's dispatch system prompt. */
export function workerPrimerSection(primer: string): string {
  return (
    "\n\n---\n\n# Rolling primer from your previous session on this project\n\n" +
    "You (this same agent) distilled this from your last recycled session on this project. " +
    "It is orientation, not instructions: the brief you were dispatched with always wins. " +
    "Treat it as your own working memory of where things stand.\n\n" +
    primer
  );
}

function summarizeToolInput(input: unknown, maxLen = 100): string {
  let s: string;
  if (typeof input === "string") s = input;
  else if (input == null) s = "";
  else s = JSON.stringify(input);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
}

/** Generic transcript rendering (role-labeled; tools as one-liners). */
function renderWorkerTranscript(messages: ChatMessage[], agent: string): string {
  const parts: string[] = [];
  for (const m of messages) {
    parts.push(m.role === "user" ? "## Dispatch" : `## ${agent}`);
    for (const block of m.blocks) {
      if (block.kind === "text") {
        parts.push(block.text);
      } else if (block.kind === "tool_use") {
        const result =
          block.result !== undefined
            ? ` -> ${summarizeToolInput(block.result, 160)}`
            : "";
        parts.push(`> [tool: ${block.name}] ${summarizeToolInput(block.input)}${result}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

function buildWorkerBrief(
  agent: string,
  project: string | null,
  transcriptMd: string
): string {
  const where = project ? `the ${project} project` : "the aiTeam home project";
  return `Below is the transcript of your session on ${where}, which is being recycled (it grew heavy). You are ${agent}, compressing it for your next self: a fresh session of you, dispatched on this same project, that should walk in knowing where things stand instead of rediscovering everything.

Format: markdown with these section headers exactly (skip any with no content):

## Completed
What you finished on this project, one bullet each. Outcomes, not narration.

## In progress
Work started but not finished; exactly where you stopped and what the next concrete step is.

## Learned
Project-specific knowledge that took real work to figure out: how things are wired, commands that work, conventions, decisions relayed to you.

## Watch out
Gotchas, fragile spots, mistakes you made once and should not repeat.

## Next steps
What you would do next if re-dispatched right now with no brief.

Hard rules:
- ${WORKER_TOKEN_CAP} tokens TOTAL. Be ruthless.
- Do not restate your persona or the project README. Next-you has both.
- Concrete file paths, command lines, and names beat prose.
- ASCII only. No em-dashes, no fancy typography.

Output ONLY the markdown body (the section headers and their content); no preamble, no closing remarks.

---

${capTranscript(transcriptMd)}
`;
}

export interface WorkerDistillOptions {
  agent: string;
  project: string | null;
  cwd: string;
  sessionId: string;
  /**
   * When true, skip if the existing primer is already newer than the session
   * log (used by the claim-time recycle path so a release-time distill that
   * already ran is not repeated).
   */
  skipIfFresh?: boolean;
}

async function runWorkerDistillation(opts: WorkerDistillOptions): Promise<void> {
  const logPath = sessionLogPath(opts.cwd, opts.sessionId);
  const outPath = workerSummaryPath(opts.agent, opts.project);

  if (opts.skipIfFresh) {
    try {
      const [primerStat, logStat] = await Promise.all([
        fsp.stat(outPath),
        fsp.stat(logPath),
      ]);
      if (primerStat.mtimeMs >= logStat.mtimeMs) return; // already distilled
    } catch {
      /* one of them missing: fall through and try */
    }
  }

  const messages = await parseSessionLog(logPath);
  if (messages.length === 0) {
    console.error(`[worker-distill] no messages for ${opts.agent} session ${opts.sessionId}; skipping`);
    return;
  }

  const persona = await loadAgentForDispatch(opts.agent);
  if (!persona) {
    console.error(`[worker-distill] unknown agent ${opts.agent}; skipping`);
    return;
  }

  const transcriptMd = renderWorkerTranscript(messages, opts.agent);
  const brief = buildWorkerBrief(opts.agent, opts.project, transcriptMd);
  const summaryText = await runClaudeJson({
    persona: persona.systemPrompt,
    brief,
    cwd: opts.cwd,
    tempPrefix: `worker-distill-${opts.agent}-${projectKey(opts.project)}`,
  });
  if (!summaryText) {
    console.error(`[worker-distill] empty result for ${opts.agent}/${projectKey(opts.project)}; skipping write`);
    return;
  }

  const now = new Date().toISOString();
  const frontmatter = [
    "---",
    `title: Rolling primer for ${opts.agent} on ${projectKey(opts.project)}`,
    "type: rolling-summary",
    `agent: ${opts.agent}`,
    `scope: ${opts.project ? `project:${opts.project}` : "_aiteam"}`,
    `created: ${now}`,
    `updated: ${now}`,
    `distilled_by: ${opts.agent}`,
    "distill_model: claude-sonnet-4-6",
    `token_cap: ${WORKER_TOKEN_CAP}`,
    `session_id: ${opts.sessionId}`,
    "---",
    "",
    `# Rolling primer for ${opts.agent} on ${projectKey(opts.project)}`,
    "",
    "> Distilled when the previous warm session was recycled. Loaded into the next fresh dispatch for this agent+project.",
    "",
  ].join("\n");

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${frontmatter}\n${summaryText}\n`, "utf8");
  await logDistillLine(
    opts.agent,
    `worker-distilled project=${projectKey(opts.project)} session=${opts.sessionId} bytes=${summaryText.length} -> ${outPath}`
  );
}

/** Fire-and-forget: never blocks or throws into dispatch paths. */
export function distillWorkerSessionAsync(opts: WorkerDistillOptions): void {
  void runWorkerDistillation(opts).catch((err) => {
    console.error(
      `[worker-distill] background run threw for ${opts.agent}/${projectKey(opts.project)}:`,
      err
    );
  });
}
