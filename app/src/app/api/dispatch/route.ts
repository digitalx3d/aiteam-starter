import path from "node:path";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnClaude, effectiveEffort } from "@/lib/claude-spawn";
import { loadAgentForDispatch, normalizeEffort, EFFORT_LEVELS } from "@/lib/agents";
import { resolveExistingProjectCwd } from "@/lib/projects";
import {
  createTicket,
  updateTicket,
  listOpenTickets,
  registerRunningChild,
  unregisterRunningChild,
  type DispatchTicket,
} from "@/lib/dispatch-store";
import { createTask, deleteTask, getTask, updateTask } from "@/lib/tasks";
import { summarizeReport } from "@/lib/dispatch-summary";
import { extractReportPath } from "@/lib/report-path";
import { BackgroundTaskTracker, backgroundTaskWarning } from "@/lib/background-tasks";
import { isAutoHandoffEnabled, MAX_CHAIN_DEPTH } from "@/lib/dispatch-handoff";
import { planReviewHandoff, reviewNotStartedLine } from "@/lib/review-gate";
import { claimWarmSession, releaseWarmSession } from "@/lib/warm-pool";
import {
  distillWorkerSessionAsync,
  loadWorkerPrimer,
  workerPrimerSection,
} from "@/lib/worker-distill";
import { buildWorkerFeedHookSettings } from "@/lib/worker-hooks";
import { postReportToChat } from "@/lib/dispatch-chat-post";
import { getConfig, isDispatchQueueEnabled } from "@/lib/config";
import { checkEnqueue, enqueue, type QueuedDispatch } from "@/lib/dispatch-queue";
import {
  blockerPostSince,
  noteBlockerReport,
  createQueuedBoardTask,
  ensureQueueSweeper,
  queueAfterTicket,
  queueEnv,
  runQueueSweep,
} from "@/lib/dispatch-queue-effects";
import { MAX_FEED_WORDS, postedDoneSince, writeNarration, writePostMeta } from "@/lib/feed-posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISPATCHES_DIR = path.join(process.cwd(), ".dispatches");

/**
 * Tools a dispatched worker never uses, hidden from its context.
 *
 * Every tool's schema sits in the prompt on EVERY turn, and a worker averages
 * ~100 turns per dispatch, so an unused tool is not paid for once — it is paid
 * for a hundred times. Measured on 2026-08-19 with an otherwise identical spawn:
 * a worker's starting context is 37,916 tokens by default and 26,759 with this
 * list applied. That is 11,157 tokens off EVERY turn.
 *
 * The list is evidence-based, not a guess: across 400 transcripts (131 of them
 * dispatched-worker sessions) not one of these was ever invoked by a worker.
 *
 * Deliberately KEPT, because workers do use them: Monitor (the right way to wait
 * for something to change, and the alternative to re-reading a file in a loop),
 * TaskOutput and TaskStop (background shell jobs), ToolSearch (loads deferred MCP
 * tools on demand), WebSearch, WebFetch, and Skill.
 *
 * `--allowedTools` does NOT do this: that governs auto-approval, not what the
 * model can see. Removing a tool from context needs --disallowedTools.
 */
const WORKER_DISALLOWED_TOOLS = [
  "Task",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "PushNotification",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "EnterWorktree",
  "ExitWorktree",
  "NotebookEdit",
  "ReportFindings",
  "Artifact",
  "EndConversation",
  "EnterPlanMode",
  "ExitPlanMode",
];

interface DispatchRequest {
  agent: string;
  project?: string | null;
  brief: string;
  /** Optional existing board task to tie this dispatch to. When omitted (or not
   *  found), a new in-progress task is auto-created on the project board. */
  taskId?: string | null;
  /** Per-dispatch model override. Beats the agent's frontmatter default.
   *  Deliberately NOT validated against a list: new aliases ship often and a
   *  stale allowlist here would block them. */
  model?: string | null;
  /** Per-dispatch reasoning-effort override (low|medium|high|xhigh|max).
   *  Beats the agent's frontmatter default. Invalid values are a 400. */
  effort?: string | null;
  /** Ask for a security review on this line of work. Only meaningful from CVB,
   *  who decides when security matters; it is what permits a ===HANDOFF=== to
   *  auto-fire. Absent or false means no review, no matter what the worker
   *  writes in its report. */
  securityReview?: boolean;
  /** Dispatch queue (`dispatch.mjs --after`): start this job only when that
   *  ticket (or queued job) finishes successfully. Absent: start now, exactly as
   *  before the queue existed. */
  after?: string | null;
}

/**
 * POST /api/dispatch
 * Body: { agent, project?, brief, taskId?, model?, effort?, securityReview?, after? }
 * Returns: { ticketId } immediately. The worker runs out-of-band as a top-level
 * claude.exe process. Subscribers to /api/dispatch/events see the lifecycle.
 * With `after`, returns { ticketId, queuedAfter } and the job waits its turn.
 */
export async function POST(request: Request) {
  ensureQueueSweeper(startQueuedJob, rerunLimitedTicket);
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

  // An explicit API caller passing a bad effort deserves to be told, unlike a
  // typo in persona frontmatter (which silently falls through to no flag).
  let requestedEffort: string | null = null;
  if (body.effort !== undefined && body.effort !== null && body.effort !== "") {
    requestedEffort = normalizeEffort(body.effort);
    if (!requestedEffort) {
      return new Response(
        JSON.stringify({
          error: `Invalid effort: ${String(body.effort)}. Expected one of: ${EFFORT_LEVELS.join(", ")}.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }
  const requestedModel =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;

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

  if (typeof body.after === "string" && body.after.trim()) {
    return enqueueDispatch(body, agent, slug, requestedModel, requestedEffort);
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
  // Most specific wins: request body > persona frontmatter > unset (CLI default).
  // Resolved here rather than at the runWorker call so the ticket can record
  // what this worker is actually running on.
  const model = requestedModel ?? persona.model;
  const effort = effectiveEffort(model, requestedEffort ?? persona.effort);

  const securityReview = body.securityReview === true;

  const ticket = await createTicket({
    agent,
    project: slug,
    brief: body.brief,
    sessionId,
    cwd,
    model,
    effort,
    securityReview,
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
    model,
    effort,
    securityReview,
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

/** GET /api/dispatch — list open tickets. Also what instrumentation.ts pings
 *  at boot to start the dispatch queue's sweeper in this process. */
export async function GET() {
  ensureQueueSweeper(startQueuedJob, rerunLimitedTicket);
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
  /** Reasoning effort for the spawn, already normalized. Null → no --effort flag. */
  effort: string | null;
  /** CVB asked for a security review on this line of work. Gates auto-handoff. */
  securityReview?: boolean;
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
    // Keep the orchestration tools out of the worker's context entirely. See
    // WORKER_DISALLOWED_TOOLS: worth ~11k tokens on every turn of every dispatch.
    disallowedTools: WORKER_DISALLOWED_TOOLS,
    model: opts.model ?? undefined,
    effort: opts.effort ?? undefined,
    permissionMode: "bypassPermissions",
    // Live Feed enforcement: format guard on now.md posts + 7-minute progress
    // nudge. Passed every spawn (fresh AND warm resume) so it can't erode.
    // The ticket id gives this worker its own Live Feed post file, so parallel
    // workers of the same agent stop overwriting each other (lib/feed-posts.ts).
    settings: buildWorkerFeedHookSettings(opts.agent, opts.slug, opts.ticketId),
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
  // The label is what tells two parallel slots of the same agent apart in the feed.
  try {
    await writePostMeta({
      ticketId: opts.ticketId,
      agent: opts.agent,
      project: opts.slug,
      label: deriveTitle(opts.brief),
      startedAt,
    });
  } catch {
    /* best-effort: an unlabelled post still shows */
  }
  await writeNarration(opts.agent, "pickup", opts.slug, feedIntro(opts.brief), opts.ticketId);

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
  const backgroundTasks = new BackgroundTaskTracker();
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
      backgroundTasks.observe(line);
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
    backgroundTasks.observe(tail);
  }
  transcript.end();

  if (code === 0) {
    let summary = await summarizeReport(lastAssistantText, {
      cwd: opts.cwd,
      ticketId: opts.ticketId,
    });
    // Where the write-up lives, pulled from the FULL report before the 600-char
    // cap can eat it. This is the fix for reports that told the owner to go read
    // something without saying where it was.
    const reportPath = extractReportPath(lastAssistantText);
    // A long job started in the background died with the session. Say so where
    // CVB reads it: ahead of the summary (so the 600-char cap can't drop it)
    // and at the end of the full report. Added after reportPath so the doc path
    // in the warning is never mistaken for the worker's write-up.
    const bgWarning = backgroundTaskWarning(backgroundTasks.stoppedAtEnd());
    // Start the security review CVB asked for, if he asked for one. Done before
    // the ticket is closed, so a review that can't start is said in the same
    // places, the same way: a gate that fails silently is worse than none.
    const reviewWarning = await startRequestedReview(opts, lastAssistantText);
    for (const warning of [bgWarning, reviewWarning]) {
      if (!warning) continue;
      console.log(`[dispatch] ${opts.ticketId}: ${warning}`);
      summary = summary ? `${warning}\n\n${summary}` : warning;
      lastAssistantText = lastAssistantText ? `${lastAssistantText}\n\n${warning}` : warning;
    }
    // Dispatch queue: a worker whose last feed post is a blocker reported
    // blocked, so nothing queued after it may start. Noted BEFORE the ticket
    // reads "done" (a sweep in between would otherwise release the next job),
    // and read before the done post below can overwrite that post.
    await noteBlockerReport(opts.ticketId, await blockerPostSince(opts.agent, opts.ticketId, startedAt));
    await updateTicket(opts.ticketId, {
      status: "done",
      finishedAt: Date.now(),
      pid: null,
      summary,
      reportPath,
      // Keep the unabridged text. `summary` is capped for the feed and the chat
      // bubble; CVB and the task board both need the whole thing.
      report: lastAssistantText,
    });
    // Code-guaranteed completion post: if the agent didn't post its own "done"
    // during this run, publish one built from its report so the Live Feed always
    // shows the finish — same guarantee as the code-driven pickup.
    if (!(await postedDoneSince(opts.agent, opts.ticketId, startedAt))) {
      await writeNarration(
        opts.agent,
        "done",
        opts.slug,
        summary ?? `Finished: ${feedIntro(opts.brief)}`,
        opts.ticketId
      );
    }
    // Durable delivery into the chat. The client-side bubble only exists if a
    // browser happened to be listening, and vb-notifier only runs if something
    // booted it; this writes the report where the chat reads from on every load.
    // Best-effort by construction: it returns a reason, it never throws. Not
    // awaited: it waits out any reply running in that chat (possibly minutes),
    // and the board and the handoff below must not wait with it.
    void postReportToChat({
      id: opts.ticketId,
      agent: opts.agent,
      project: opts.slug,
      status: "done",
      summary,
      reportPath,
    }).then((posted) => {
      if (!posted.posted) {
        console.log(`[dispatch] chat post skipped for ${opts.ticketId}: ${posted.reason}`);
      }
    });
    // The board gets the FULL report, not the summary. A task file is a durable
    // project record with no length limit — it is the artifact the owner reads months
    // later — so truncating it was pure loss. The short summary stays on the feed
    // and the chat bubble, which is where brevity actually matters.
    await finishBoardTask(opts, boardTaskId, "done", lastAssistantText ?? summary);
  } else {
    // Prefer the real reason from the stream-json result event (e.g. "API Error:
    // 529 Overloaded") over a bare "exit code 1" with empty stderr.
    let errorMessage =
      resultError ?? `exit code ${code}: ${stderr.slice(-500)}`;
    if (opts.securityReview) {
      errorMessage += ` ${reviewNotStartedLine(opts.agent, "the worker failed before finishing")}`;
    }
    await updateTicket(opts.ticketId, {
      status: "failed",
      finishedAt: Date.now(),
      pid: null,
      errorMessage,
    });
    await finishBoardTask(opts, boardTaskId, "blocked", errorMessage);
    // Surface the failure in the Live Feed too (agents that die before their
    // first turn never narrate a blocker themselves).
    await writeNarration(
      opts.agent,
      "blocker",
      opts.slug,
      `dispatch failed: ${errorMessage}`,
      opts.ticketId
    );
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

  // Dispatch queue: release (or stop) whatever was waiting on this ticket.
  // Never throws, and does nothing when nothing is queued.
  await queueAfterTicket(startQueuedJob, opts.ticketId);
}

/** A board task title from the brief, capped at 80 chars. Briefs often open
 *  with their own frontmatter block; its `title:` wins. Otherwise the first
 *  line with real words in it, so a leading `---`, code fence or bare heading
 *  marker never becomes the title (that is how one project got 18 tasks
 *  titled "---" and filed as `--2.md`, `--3.md`...). */
function deriveTitle(brief: string): string {
  const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);
  const cap = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ");
    return t.length <= 80 ? t : t.slice(0, 77) + "...";
  };
  const lines = brief.split(/\r?\n/);
  let start = lines.findIndex((l) => l.trim());
  if (start < 0) return "";

  if (lines[start].trim() === "---") {
    const end = lines.findIndex((l, i) => i > start && l.trim() === "---");
    if (end > start) {
      for (const l of lines.slice(start + 1, end)) {
        const m = l.match(/^title\s*:\s*(.+)$/);
        if (!m) continue;
        const t = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
        if (hasWords(t)) return cap(t);
      }
      start = end + 1;
    }
  }

  let inFence = false;
  for (const l of lines.slice(start)) {
    if (l.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const t = l
      .trim()
      .replace(/^[#>\s]+/, "")
      .replace(/^(\*\*|__)(.*)\1$/, "$2");
    if (hasWords(t)) return cap(t);
  }
  return ""; // createTask turns an empty title into "(untitled)"
}

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
 * If CVB asked for a security review on this dispatch and the worker emitted an
 * allowed ===HANDOFF===, auto-dispatch the named teammate. Bounded by the kill
 * switch, the whitelist and the hop cap (lib/review-gate.ts decides). A
 * project-less dispatch hands off project-less, into the same folder.
 *
 * Returns null when nothing was due or the handoff started, and a one-line
 * "[review check] ... NOT started: <reason>" when a requested review can't
 * start, for any reason. Never throws into the completion path.
 */
async function startRequestedReview(
  opts: RunWorkerOpts,
  text: string | null
): Promise<string | null> {
  const depth = opts.chainDepth ?? 0;
  let plan;
  try {
    plan = planReviewHandoff({
      agent: opts.agent,
      securityReview: opts.securityReview === true,
      chainDepth: depth,
      text,
      autoHandoffEnabled: isAutoHandoffEnabled(),
    });
  } catch (err) {
    return opts.securityReview
      ? reviewNotStartedLine(opts.agent, `the review gate failed: ${(err as Error).message}`)
      : null;
  }
  if (plan.kind === "none") return null;
  if (plan.kind === "not-started") return reviewNotStartedLine(opts.agent, plan.reason);

  const h = plan.handoff;
  const brief =
    `Handoff from ${opts.agent}: ${h.why}\n` +
    (h.ref ? `Reference: ${h.ref}\n` : "") +
    `\n(Auto-dispatched via the team handoff chain; parent ticket ${opts.ticketId}, ` +
    `hop ${depth + 1} of max ${MAX_CHAIN_DEPTH}. End with your own ===REPORT===, and a ` +
    `===HANDOFF=== only if a whitelisted next step is genuinely needed.)`;
  try {
    const started = await dispatchAgentInternal({
      agent: h.to,
      slug: opts.slug,
      cwd: opts.cwd,
      brief,
      parentTicketId: opts.ticketId,
      chainDepth: depth + 1,
      // The authorization travels with the chain: an approved review may hand
      // back for fixes without CVB re-approving each hop.
      securityReview: true,
    });
    if ("error" in started) return reviewNotStartedLine(opts.agent, started.error);
    console.log(`[dispatch] ${opts.ticketId}: handoff to ${h.to} started as ${started.ticketId}`);
    return null;
  } catch (err) {
    return reviewNotStartedLine(opts.agent, `dispatching ${h.to} failed: ${(err as Error).message}`);
  }
}

/** Spawn a dispatch for one agent (used by the auto-handoff chain). Mirrors the POST
 *  path but for an already-resolved cwd; slug null means a project-less dispatch.
 *  Returns once the ticket exists; the worker itself runs fire-and-forget. */
async function dispatchAgentInternal(opts: {
  agent: string;
  slug: string | null;
  cwd: string;
  brief: string;
  parentTicketId: string | null;
  chainDepth: number;
  securityReview?: boolean;
}): Promise<{ ticketId: string } | { error: string }> {
  const persona = await loadAgentForDispatch(opts.agent);
  if (!persona) return { error: `no agent named ${opts.agent}` };
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
    securityReview: opts.securityReview === true,
    // A handoff runs on the RECEIVING agent's own defaults.
    model: persona.model,
    effort: effectiveEffort(persona.model, persona.effort),
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
    // A handoff runs on the RECEIVING agent's own defaults. The parent's
    // per-dispatch override was scoped to the parent's task, not this one.
    model: persona.model,
    effort: persona.effort,
    resume: claim.resume,
    warmKey: claim.tracked ? claim.key : null,
    parentTicketId: opts.parentTicketId,
    chainDepth: opts.chainDepth,
    securityReview: opts.securityReview === true,
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
  return { ticketId: ticket.id };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `dispatch.mjs --after <ticket>`: put the job in the dispatch queue instead of
 * starting it. Returns its ticket id at once; the id becomes a real ticket when
 * the job is released (lib/dispatch-queue.ts). Agent, project and effort were
 * already validated by POST, so a bad one is refused now, not at release.
 */
async function enqueueDispatch(
  body: DispatchRequest,
  agent: string,
  slug: string | null,
  model: string | null,
  effort: string | null
): Promise<Response> {
  if (!isDispatchQueueEnabled()) {
    return jsonResponse(409, {
      error:
        'the dispatch queue is switched off ("dispatchQueue": false in ~/.aiteam/settings.json), so --after is refused. ' +
        "Dispatch without --after, or set it back to true.",
    });
  }
  const env = queueEnv();
  const after = String(body.after).trim();
  let check;
  try {
    check = checkEnqueue(env, after);
  } catch (err) {
    return jsonResponse(503, { error: `the dispatch queue could not be read: ${(err as Error).message}` });
  }
  if (!check.ok) return jsonResponse(409, { error: check.error });

  const id = randomUUID();
  // The board task exists before the job is in the queue, so a release can
  // never race ahead of it and start without one.
  let taskId: string | null = null;
  let taskOwned = false;
  if (slug && body.taskId && (await getTask(slug, body.taskId).catch(() => null))) {
    taskId = body.taskId;
  } else {
    taskId = await createQueuedBoardTask({
      project: slug,
      agent,
      title: deriveTitle(body.brief),
      brief: body.brief,
      id,
      after: check.after,
      predecessorAgent: check.predecessorAgent,
    });
    taskOwned = taskId !== null;
  }

  let queued;
  try {
    queued = enqueue(env, {
      id,
      after: check.after,
      agent,
      project: slug,
      brief: body.brief,
      model,
      effort,
      securityReview: body.securityReview === true,
      taskId,
      taskOwned,
    });
  } catch (err) {
    queued = { ok: false as const, error: `the dispatch queue could not be written: ${(err as Error).message}` };
  }
  if (!queued.ok) {
    if (slug && taskOwned && taskId) await deleteTask(slug, taskId).catch(() => false);
    return jsonResponse(409, { error: queued.error });
  }
  console.log(`[dispatch-queue] ${id} (${agent}) queued after ${check.after}`);
  // The predecessor may already be done; if so this starts the job right away.
  void runQueueSweep(startQueuedJob, "enqueue");
  return jsonResponse(202, { ticketId: id, queuedAfter: check.after });
}

/** Appended to a re-run's brief; also how a re-run of a re-run finds the
 *  original brief again instead of stacking notes. */
const RERUN_NOTE = "\n\n---\n(Re-run by the dispatch queue:";

/**
 * Usage limit: a job died on the limit and jobs were queued behind it. Now the
 * limit has lifted, start it again, same agent, project, brief, settings and
 * board task, under the new ticket id the queue already pointed its waiters at.
 * The worker is told it is a re-run, so it checks what the first run finished
 * before redoing anything (often its warm session still has that context).
 */
async function rerunLimitedTicket(deadId: string, newId: string): Promise<void> {
  let dead: DispatchTicket;
  try {
    dead = JSON.parse(await readFile(path.join(DISPATCHES_DIR, `${deadId}.json`), "utf8")) as DispatchTicket;
  } catch {
    throw new Error(`ticket ${deadId} can't be read`);
  }
  const brief =
    dead.brief.split(RERUN_NOTE)[0] +
    `${RERUN_NOTE} your previous run of this job, ticket ${deadId.slice(0, 8)}, stopped at the usage limit. ` +
    "Check what it already finished (files, uploads, board, git) before redoing anything, then do the rest.)";
  const now = Date.now();
  await startQueuedJob({
    id: newId,
    after: deadId,
    agent: dead.agent,
    project: dead.project,
    brief,
    model: dead.model,
    effort: dead.effort,
    securityReview: dead.securityReview === true,
    taskId: dead.taskId,
    taskOwned: false,
    createdAt: now,
    state: "released",
    reason: null,
    notified: true,
    releasedAt: now,
    endedAt: now,
  });
}

/**
 * Start a job the queue just released. The same steps as POST, with the queued
 * job's own id and board task. Kept separate from POST on purpose: the queue is
 * additive, and an ordinary dispatch must run exactly the code it ran before.
 * Throws if the job can't start (the sweeper parks it as blocked), or with
 * code EEXIST if another process already started it.
 */
async function startQueuedJob(job: QueuedDispatch): Promise<void> {
  const persona = await loadAgentForDispatch(job.agent);
  if (!persona) throw new Error(`there is no agent named ${job.agent}`);
  let cwd: string;
  if (job.project) {
    const resolved = await resolveExistingProjectCwd(job.project);
    if (!resolved) throw new Error(`project ${job.project} no longer exists`);
    cwd = resolved;
  } else {
    cwd = getConfig().aiteamDir;
  }
  const claim = await claimWarmSession(job.agent, job.project, cwd);
  if (claim.recycled) {
    distillWorkerSessionAsync({
      agent: job.agent,
      project: job.project,
      cwd,
      sessionId: claim.recycled.sessionId,
      skipIfFresh: true,
    });
  }
  const model = job.model ?? persona.model;
  const effort = effectiveEffort(model, job.effort ?? persona.effort);

  let ticket;
  try {
    ticket = await createTicket({
      id: job.id,
      agent: job.agent,
      project: job.project,
      brief: job.brief,
      sessionId: claim.sessionId,
      cwd,
      model,
      effort,
      securityReview: job.securityReview,
    });
  } catch (err) {
    if (claim.tracked && claim.key) await releaseWarmSession(claim.key, { cwd });
    throw err;
  }

  runWorker({
    ticketId: ticket.id,
    agent: job.agent,
    cwd,
    slug: job.project,
    taskId: job.taskId,
    sessionId: claim.sessionId,
    brief: job.brief,
    systemPrompt: persona.systemPrompt,
    allowedTools: persona.allowedTools,
    model,
    effort,
    securityReview: job.securityReview,
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
    // runWorker never reached its own queue hook; stop the chain behind it now.
    await queueAfterTicket(startQueuedJob, ticket.id);
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
