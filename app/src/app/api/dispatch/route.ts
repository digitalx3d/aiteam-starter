import path from "node:path";
import { createWriteStream, promises as fsp } from "node:fs";
import { spawnClaude } from "@/lib/claude-spawn";
import { loadAgentForDispatch } from "@/lib/agents";
import { resolveExistingProjectCwd } from "@/lib/projects";
import {
  createTicket,
  updateTicket,
  listOpenTickets,
  registerRunningChild,
  unregisterRunningChild,
} from "@/lib/dispatch-store";
import { createTask, getTask, updateTask } from "@/lib/tasks";
import { summarizeReport } from "@/lib/dispatch-summary";
import {
  extractHandoff,
  isHandoffAllowed,
  isAutoHandoffEnabled,
  MAX_CHAIN_DEPTH,
} from "@/lib/dispatch-handoff";
import { claimWarmSession, releaseWarmSession } from "@/lib/warm-pool";
import {
  distillWorkerSessionAsync,
  loadWorkerPrimer,
  workerPrimerSection,
} from "@/lib/worker-distill";
import { buildWorkerFeedHookSettings } from "@/lib/worker-hooks";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISPATCHES_DIR = path.join(process.cwd(), ".dispatches");

interface DispatchRequest {
  agent: string;
  project?: string | null;
  brief: string;
  /** Optional existing board task to tie this dispatch to. When omitted (or not
   *  found), a new in-progress task is auto-created on the project board. */
  taskId?: string | null;
}

/**
 * POST /api/dispatch
 * Body: { agent, project?, brief }
 * Returns: { ticketId } immediately. The worker runs out-of-band as a top-level
 * claude.exe process. Subscribers to /api/dispatch/events see the lifecycle.
 */
export async function POST(request: Request) {
  let body: DispatchRequest;
  try {
    body = (await request.json()) as DispatchRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body?.agent || typeof body.agent !== "string") {
    return new Response(JSON.stringify({ error: "agent is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!body?.brief || typeof body.brief !== "string") {
    return new Response(JSON.stringify({ error: "brief is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const agent = body.agent.trim();
  const persona = await loadAgentForDispatch(agent);
  if (!persona) {
    return new Response(
      JSON.stringify({ error: `Unknown agent: ${agent}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const slug = body.project?.trim() || null;
  let cwd: string;
  if (slug) {
    const resolved = await resolveExistingProjectCwd(slug);
    if (!resolved) {
      return new Response(
        JSON.stringify({
          error: `Unknown project: ${slug} — no such folder under the projects root. Use the project's exact folder name.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    cwd = resolved;
  } else {
    cwd = getConfig().aiteamDir;
  }

  // Warm pool: reuse this (agent, project)'s durable session if one is hot,
  // else start fresh. `resume` decides --resume vs --session-id and whether the
  // persona is re-injected. `tracked` sessions are released back to the pool on finish.
  const claim = await claimWarmSession(agent, slug, cwd);
  const sessionId = claim.sessionId;
  // A retired session was just recycled: distill it into a worker primer so
  // future fresh sessions inherit its project memory. skipIfFresh makes this
  // a no-op when the release-time distill already ran. Fire-and-forget.
  if (claim.recycled) {
    distillWorkerSessionAsync({
      agent,
      project: slug,
      cwd,
      sessionId: claim.recycled.sessionId,
      skipIfFresh: true,
    });
  }
  const ticket = await createTicket({
    agent,
    project: slug,
    brief: body.brief,
    sessionId,
    cwd,
  });

  // Spawn the worker out-of-band. Do NOT await the exit — we return ticketId now.
  runWorker({
    ticketId: ticket.id,
    agent,
    cwd,
    slug,
    taskId: body.taskId ?? null,
    sessionId,
    brief: body.brief,
    systemPrompt: persona.systemPrompt,
    allowedTools: persona.allowedTools,
    model: persona.model,
    resume: claim.resume,
    warmKey: claim.tracked ? claim.key : null,
  }).catch(async (err) => {
    if (claim.tracked && claim.key) {
      await releaseWarmSession(claim.key, { cwd });
    }
    await updateTicket(ticket.id, {
      status: "failed",
      finishedAt: Date.now(),
      errorMessage: (err as Error).message,
    });
  });

  return new Response(JSON.stringify({ ticketId: ticket.id }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /api/dispatch — list open tickets. */
export async function GET() {
  const open = await listOpenTickets();
  return new Response(JSON.stringify({ tickets: open }), {
    headers: { "Content-Type": "application/json" },
  });
}

interface RunWorkerOpts {
  ticketId: string;
  agent: string;
  cwd: string;
  /** Project slug (null for aiTeam-internal dispatches). Board wiring only runs when set. */
  slug: string | null;
  /** Existing board task to update, or null to auto-create one. */
  taskId: string | null;
  sessionId: string;
  brief: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string | null;
  /** Warm pool: resume an existing session (persona inherited) vs create fresh. */
  resume: boolean;
  /** Warm pool key to release on finish, or null for an untracked/fresh session. */
  warmKey: string | null;
  /** Auto-handoff chain: the ticket that triggered this one, and the hop count. */
  parentTicketId?: string | null;
  chainDepth?: number;
}

async function runWorker(opts: RunWorkerOpts): Promise<void> {
  // Dispatched workers run with bypassPermissions, not the dashboard's
  // acceptEdits default. Reason: acceptEdits only auto-approves file edits
  // inside the cwd, but each agent legitimately needs to write to its own
  // home folder (~/.claude/agents/<name>/now.md, inbox-state.json,
  // completed.md, plan-current.md). Those writes are required by the
  // activation procedure baked into the agent's definition file and would
  // silently fail under acceptEdits. The hard rules that matter
  // (no git push, no other-agent inbox writes, no production code) are
  // already encoded in each agent's persona files; bypassPermissions doesn't
  // change those — it just stops the runtime from blocking legitimate
  // self-state writes.
  // Fresh sessions get the agent's rolling primer for this project appended
  // (its distilled memory from the last recycled session). Warm resumes skip
  // it — the primer is already baked into the session being resumed.
  let systemPrompt = opts.systemPrompt;
  if (!opts.resume) {
    const primer = await loadWorkerPrimer(opts.agent, opts.slug).catch(() => null);
    if (primer) systemPrompt = opts.systemPrompt + workerPrimerSection(primer);
  }

  const { child, exitPromise } = spawnClaude({
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    resume: opts.resume,
    message: opts.brief,
    // On resume the persona is already baked into the session — re-injecting it
    // would bloat context and break the cache prefix. Only inject on a fresh session.
    appendSystemPrompt: opts.resume ? undefined : systemPrompt,
    allowedTools: opts.allowedTools,
    model: opts.model ?? undefined,
    permissionMode: "bypassPermissions",
    // Live Feed enforcement: format guard on now.md posts + 7-minute progress
    // nudge. Passed every spawn (fresh AND warm resume) so it can't erode.
    settings: buildWorkerFeedHookSettings(opts.agent, opts.slug),
  });

  registerRunningChild(opts.ticketId, child);
  const startedAt = Date.now();
  await updateTicket(opts.ticketId, {
    status: "running",
    pid: child.pid ?? null,
    startedAt,
  });

  // Code-driven "pickup" so the Live Feed shows the hand-off the instant it
  // happens, even if the agent never gets to narrate it itself.
  await writeNarration(opts.agent, "pickup", opts.slug, feedIntro(opts.brief));

  // Reflect this dispatch on the project task board (update the referenced task, or
  // auto-create one). Best-effort: a board failure must never break the dispatch.
  const boardTaskId = await startBoardTask(opts);
  if (boardTaskId) {
    await updateTicket(opts.ticketId, { taskId: boardTaskId });
  }

  // Tee the worker's stream-json transcript to disk so we can replay later.
  const transcriptPath = path.join(DISPATCHES_DIR, `${opts.ticketId}.jsonl`);
  const transcript = createWriteStream(transcriptPath, { flags: "a" });
  let lastAssistantText: string | null = null;
  let resultError: string | null = null;
  let buffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    transcript.write(text);
    buffer += text;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const t = extractAssistantText(line);
      if (t) lastAssistantText = t;
      const re = extractResultError(line);
      if (re) resultError = re;
    }
  });

  const { code, stderr } = await exitPromise;
  unregisterRunningChild(opts.ticketId);
  if (buffer.trim()) {
    transcript.write("\n");
    const tail = buffer.trim();
    const t = extractAssistantText(tail);
    if (t) lastAssistantText = t;
    const re = extractResultError(tail);
    if (re) resultError = re;
  }
  transcript.end();

  if (code === 0) {
    const summary = await summarizeReport(lastAssistantText, { cwd: opts.cwd });
    await updateTicket(opts.ticketId, {
      status: "done",
      finishedAt: Date.now(),
      pid: null,
      summary,
    });
    // Code-guaranteed completion post: if the agent didn't post its own "done"
    // during this run, publish one built from its report so the Live Feed always
    // shows the finish — same guarantee as the code-driven pickup.
    if (!(await agentPostedDoneSince(opts.agent, startedAt))) {
      await writeNarration(
        opts.agent,
        "done",
        opts.slug,
        summary ?? `Finished: ${feedIntro(opts.brief)}`
      );
    }
    await finishBoardTask(opts, boardTaskId, "done", summary);
    // Self-handing-off team: if the worker emitted an allowed ===HANDOFF===, and the
    // kill switch is on and we're under the hop cap, auto-dispatch the teammate.
    await maybeAutoHandoff(opts, lastAssistantText);
  } else {
    // Prefer the real reason from the stream-json result event (e.g. "API Error:
    // 529 Overloaded") over a bare "exit code 1" with empty stderr.
    const errorMessage =
      resultError ?? `exit code ${code}: ${stderr.slice(-500)}`;
    await updateTicket(opts.ticketId, {
      status: "failed",
      finishedAt: Date.now(),
      pid: null,
      errorMessage,
    });
    await finishBoardTask(opts, boardTaskId, "blocked", errorMessage);
    // Surface the failure in the Live Feed too (agents that die before their
    // first turn never narrate a blocker themselves).
    await writeNarration(opts.agent, "blocker", opts.slug, `dispatch failed: ${errorMessage}`);
  }

  // Release the warm session back to the pool: clear busy, update the fullness
  // estimate, and mark it for recycle if it crossed the threshold. No-op for
  // untracked (throwaway) sessions. Runs for both success and failure.
  if (opts.warmKey) {
    const rel = await releaseWarmSession(opts.warmKey, { cwd: opts.cwd });
    // Session just crossed the fullness threshold: distill it NOW (in the
    // background) so its primer is ready before the next dispatch recycles it.
    if (rel.retiredNow && rel.sessionId) {
      distillWorkerSessionAsync({
        agent: opts.agent,
        project: opts.slug,
        cwd: opts.cwd,
        sessionId: rel.sessionId,
      });
    }
  }
}

/** First non-empty line of the brief, capped, as a board task title. */
function deriveTitle(brief: string): string {
  const firstLine = brief.split(/\r?\n/).find((l) => l.trim()) ?? brief;
  const t = firstLine.trim().replace(/\s+/g, " ");
  return t.length <= 80 ? t : t.slice(0, 77) + "...";
}

// Feed posts run 20-60 words (the posting contract in
// vault/team/operating-rules.md); code-written narrations honor the same cap.
const MAX_FEED_WORDS = 60;

/** Flatten a brief into feed-ready text: one flowing paragraph, markdown
 *  scaffolding stripped, capped at MAX_FEED_WORDS. Prefers cutting at a
 *  sentence boundary so the pickup post reads as a complete thought instead
 *  of stopping mid-word the way a character cap does. */
function feedIntro(brief: string): string {
  const flat = brief
    .replace(/^[#>*\s-]+/gm, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = flat.split(" ").filter(Boolean);
  if (words.length <= MAX_FEED_WORDS) return flat;
  const head = words.slice(0, MAX_FEED_WORDS).join(" ");
  const stop = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? ")
  );
  if (stop > head.length * 0.5) return head.slice(0, stop + 1);
  return head + " …";
}

/** Mark the board task in-progress on dispatch start. Updates the referenced task
 *  if it exists, else creates a new one. Returns the touched task id, or null (no
 *  slug or board write failed — never throws). */
async function startBoardTask(opts: RunWorkerOpts): Promise<string | null> {
  if (!opts.slug) return null; // only project dispatches touch a board
  try {
    if (opts.taskId) {
      const existing = await getTask(opts.slug, opts.taskId);
      if (existing) {
        await updateTask(opts.slug, opts.taskId, {
          status: "in-progress",
          assignee: opts.agent,
        });
        return opts.taskId;
      }
    }
    const created = await createTask(opts.slug, {
      title: deriveTitle(opts.brief),
      description: opts.brief,
      assignee: opts.agent,
      status: "in-progress",
    });
    return created?.id ?? null;
  } catch {
    return null;
  }
}

/** Flip the board task to done/blocked and append the outcome. Best-effort. */
async function finishBoardTask(
  opts: RunWorkerOpts,
  taskId: string | null,
  status: "done" | "blocked",
  outcome: string | null
): Promise<void> {
  if (!opts.slug || !taskId) return;
  try {
    const existing = await getTask(opts.slug, taskId);
    if (!existing) return;
    const note = outcome ? `\n\n---\n**Outcome (${status}):** ${outcome}` : "";
    await updateTask(opts.slug, taskId, {
      status,
      description: existing.description + note,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * If a finished worker emitted an allowed ===HANDOFF=== directive, auto-dispatch the
 * named teammate to act on it. Bounded by the kill switch, the whitelist, and the hop
 * cap. Anything not whitelisted does NOT auto-fire — it surfaces to CVB as the normal
 * report, and CVB decides. Best-effort: never throws into the completion path.
 */
async function maybeAutoHandoff(
  opts: RunWorkerOpts,
  text: string | null
): Promise<void> {
  try {
    if (!isAutoHandoffEnabled()) return; // kill switch (off by default)
    if (!opts.slug) return; // need a project context to dispatch into
    const depth = opts.chainDepth ?? 0;
    if (depth >= MAX_CHAIN_DEPTH) return; // loop governor
    const h = extractHandoff(text);
    if (!h) return;
    if (!isHandoffAllowed(opts.agent, h.to)) return; // not whitelisted -> CVB routes it

    const brief =
      `Handoff from ${opts.agent}: ${h.why}\n` +
      (h.ref ? `Reference: ${h.ref}\n` : "") +
      `\n(Auto-dispatched via the team handoff chain — parent ticket ${opts.ticketId}, ` +
      `hop ${depth + 1} of max ${MAX_CHAIN_DEPTH}. End with your own ===REPORT===, and a ` +
      `===HANDOFF=== only if a whitelisted next step is genuinely needed.)`;

    await dispatchAgentInternal({
      agent: h.to,
      slug: opts.slug,
      cwd: opts.cwd,
      brief,
      parentTicketId: opts.ticketId,
      chainDepth: depth + 1,
    });
  } catch {
    /* best-effort — a handoff failure must never break the parent's completion */
  }
}

/** Spawn a dispatch for one agent (used by the auto-handoff chain). Mirrors the POST
 *  path but for an already-resolved project cwd. Fire-and-forget. */
async function dispatchAgentInternal(opts: {
  agent: string;
  slug: string;
  cwd: string;
  brief: string;
  parentTicketId: string | null;
  chainDepth: number;
}): Promise<void> {
  const persona = await loadAgentForDispatch(opts.agent);
  if (!persona) return; // unknown agent — skip silently
  const claim = await claimWarmSession(opts.agent, opts.slug, opts.cwd);
  const sessionId = claim.sessionId;
  if (claim.recycled) {
    distillWorkerSessionAsync({
      agent: opts.agent,
      project: opts.slug,
      cwd: opts.cwd,
      sessionId: claim.recycled.sessionId,
      skipIfFresh: true,
    });
  }
  const ticket = await createTicket({
    agent: opts.agent,
    project: opts.slug,
    brief: opts.brief,
    sessionId,
    cwd: opts.cwd,
    parentTicketId: opts.parentTicketId,
    chainDepth: opts.chainDepth,
  });
  runWorker({
    ticketId: ticket.id,
    agent: opts.agent,
    cwd: opts.cwd,
    slug: opts.slug,
    taskId: null,
    sessionId,
    brief: opts.brief,
    systemPrompt: persona.systemPrompt,
    allowedTools: persona.allowedTools,
    model: persona.model,
    resume: claim.resume,
    warmKey: claim.tracked ? claim.key : null,
    parentTicketId: opts.parentTicketId,
    chainDepth: opts.chainDepth,
  }).catch(async (err) => {
    if (claim.tracked && claim.key) {
      await releaseWarmSession(claim.key, { cwd: opts.cwd });
    }
    await updateTicket(ticket.id, {
      status: "failed",
      finishedAt: Date.now(),
      errorMessage: (err as Error).message,
    });
  });
}

/**
 * Pull a human-readable error out of a stream-json `result` event (e.g. an API
 * 529 Overloaded), so a failed ticket shows the real reason instead of a bare
 * "exit code 1" with empty stderr.
 */
function extractResultError(line: string): string | null {
  try {
    const o = JSON.parse(line);
    if (!o || typeof o !== "object") return null;
    if (o.type !== "result" || !o.is_error) return null;
    const msg =
      typeof o.result === "string" && o.result.trim() ? o.result.trim() : null;
    const api = o.api_error_status ? ` (API ${o.api_error_status})` : "";
    const sub = o.subtype && o.subtype !== "success" ? ` [${o.subtype}]` : "";
    return ((msg ?? `worker reported an error${sub}`) + api).slice(0, 400);
  } catch {
    return null;
  }
}

/**
 * Write a live-feed narration post to the agent's now.md in the feed format
 * ("kind [project] — text", capped at the contract's 20-60 word budget). The
 * live-feed watcher picks up now.md changes, so this makes pickups,
 * completions, and failures show up in the Live Feed even when the agent
 * itself doesn't narrate — e.g. it died before its first turn (an API
 * overload), or it skipped a beat. Non-project dispatches are tagged [aiteam]
 * so every post leads with a project name. Best-effort; never throws into
 * dispatch.
 */
async function writeNarration(
  agent: string,
  kind: "pickup" | "blocker" | "done",
  project: string | null,
  text: string
): Promise<void> {
  try {
    const dir = path.join(getConfig().agentsDir, agent);
    await fsp.mkdir(dir, { recursive: true });
    const tag = ` [${project ?? "aiteam"}]`;
    // Keep whole lines while they fit the word budget, so agent-authored
    // summaries keep their shape; a line that busts the budget is cut at a
    // word boundary rather than mid-word.
    const lines: string[] = [];
    let budget = MAX_FEED_WORDS;
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      const words = l.split(/\s+/);
      if (words.length <= budget) {
        lines.push(l);
        budget -= words.length;
      } else {
        if (budget >= 4) lines.push(words.slice(0, budget).join(" ") + " …");
        break;
      }
      if (budget <= 0) break;
    }
    const head = lines.shift() ?? "";
    const body = lines.length ? "\n" + lines.join("\n") : "";
    await fsp.writeFile(
      path.join(dir, "now.md"),
      `${kind}${tag} — ${head}${body}\n`,
      "utf8"
    );
  } catch {
    /* best-effort — a narration write must never break dispatch */
  }
}

/** True if the agent's own now.md already shows a "done" post written after `sinceMs`
 *  (i.e. during this run) — in which case the code-driven completion post would only
 *  overwrite a richer, agent-authored one. Best-effort: any error reads as "no". */
async function agentPostedDoneSince(agent: string, sinceMs: number): Promise<boolean> {
  try {
    const p = path.join(getConfig().agentsDir, agent, "now.md");
    const stat = await fsp.stat(p);
    if (stat.mtimeMs < sinceMs) return false;
    const firstLine = (await fsp.readFile(p, "utf8")).split(/\r?\n/)[0] ?? "";
    return /^done\b/i.test(firstLine.trim());
  } catch {
    return false;
  }
}

/** Pull the latest assistant-message text out of a stream-json line, if any. */
function extractAssistantText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object") return null;
    // stream-json shape: {type:"assistant", message:{content:[{type:"text", text:"..."}, ...]}}
    if (obj.type !== "assistant" || !obj.message) return null;
    const content = obj.message.content;
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") {
        texts.push(c.text);
      }
    }
    const joined = texts.join("\n").trim();
    return joined || null;
  } catch {
    return null;
  }
}
