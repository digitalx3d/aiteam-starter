import path from "node:path";
import { promises as fsp } from "node:fs";
import { SETTINGS_FILE, getAppPort, isDispatchQueueEnabled } from "./config";
import * as Q from "./dispatch-queue";
import { createTask, deleteTask, getTask, updateTask } from "./tasks";
import { postReportToChat } from "./dispatch-chat-post";
import { postPath } from "./feed-posts";

/*
 * The dispatch queue's side effects: board tasks, the "waiting on a failed job"
 * chat report, and the sweeper that releases waiting jobs. dispatch-queue.ts
 * decides; this does. The one thing it can't do is start a worker, which lives
 * in api/dispatch/route.ts and is passed in as `start`.
 *
 * Everything here is best-effort and never throws into a caller: the queue
 * must not be able to break an ordinary dispatch.
 */

export type QueueStarter = (job: Q.QueuedDispatch) => Promise<void>;

/** scripts/dispatch.mjs, absolute, for the commands shown in chat messages. */
const DISPATCH_SCRIPT = path.join(process.cwd(), "..", "scripts", "dispatch.mjs").replace(/\\/g, "/");

/** The queue file sits next to settings.json (~/.aiteam); tickets in app/.dispatches. */
export function queueEnv(): Q.QueueEnv {
  return {
    file: path.join(path.dirname(SETTINGS_FILE), "dispatch-queue.json"),
    dispatchesDir: path.join(process.cwd(), ".dispatches"),
    dispatchScript: DISPATCH_SCRIPT,
  };
}

/**
 * Only the main dashboard process (the one on appPort) releases jobs. A second
 * instance running the same build against the same files would be harmless,
 * since the lock already makes a double start impossible; this keeps released
 * workers in the process whose Agents tab, live feed and CVB notices the owner
 * is actually watching.
 *
 * __NEXT_PRIVATE_ORIGIN is Next's own record of the origin THIS process bound
 * (server/lib/start-server.js), so it can't be redirected by an ambient PORT.
 */
export function isReleasingInstance(): boolean {
  const origin = process.env.__NEXT_PRIVATE_ORIGIN;
  if (!origin) return true; // dev server or an unknown runtime: a single process
  try {
    return new URL(origin).port === getAppPort();
  } catch {
    return true;
  }
}

/** A worker whose last Live Feed post on this ticket is a blocker reported
 *  blocked, even if it exited cleanly. Returns that post's text, or null. Read
 *  BEFORE the dispatch engine writes its own "done" post over it. */
export async function blockerPostSince(
  agent: string,
  ticketId: string,
  sinceMs: number
): Promise<string | null> {
  try {
    const p = postPath(agent, ticketId);
    if ((await fsp.stat(p)).mtimeMs < sinceMs) return null;
    const text = (await fsp.readFile(p, "utf8")).trim();
    if (!/^blocker\b/i.test(text)) return null;
    const flat = text.replace(/\s+/g, " ");
    return flat.length <= 200 ? flat : flat.slice(0, 197) + "...";
  } catch {
    return null;
  }
}

/** Board task for a queued job, on the project board as a todo that says what
 *  it is waiting for. Null for project-less jobs or if the board write fails. */
export async function createQueuedBoardTask(input: {
  project: string | null;
  agent: string;
  title: string;
  brief: string;
  id: string;
  after: string;
  predecessorAgent: string;
}): Promise<string | null> {
  if (!input.project) return null;
  try {
    const task = await createTask(input.project, {
      title: input.title,
      description:
        `${input.brief}\n\n---\n**Queued after ${input.predecessorAgent}'s job ${Q.shortId(input.after)}.** ` +
        `Starts on its own when that job finishes successfully. Queue ticket ${input.id}.`,
      assignee: input.agent,
      status: "todo",
    });
    return task?.id ?? null;
  } catch {
    return null;
  }
}

/** Board cleanup when a waiting job is cancelled: a task the queue made is
 *  removed (the job never existed as work); one CVB passed in gets a note. */
export async function cancelBoardTask(job: Q.QueuedDispatch): Promise<void> {
  if (!job.project || !job.taskId) return;
  try {
    if (job.taskOwned) {
      await deleteTask(job.project, job.taskId);
      return;
    }
    const existing = await getTask(job.project, job.taskId);
    if (!existing) return;
    await updateTask(job.project, job.taskId, {
      description: `${existing.description}\n\n---\n**Removed from the queue** before it started (ticket ${Q.shortId(job.id)}).`,
    });
  } catch {
    /* best-effort */
  }
}

function blockedMessage(job: Q.QueuedDispatch): string {
  return (
    `Not started. This job was queued after ${Q.shortId(job.after)}, and ${job.reason ?? "that job did not finish"}. ` +
    `It will not start on its own. Re-dispatch it once the earlier work is sorted, or remove it with:\n` +
    `node ${DISPATCH_SCRIPT} --cancel ${job.id}`
  );
}

/** Tell the chat (and the board) that a waiting job will not start. */
async function reportBlocked(job: Q.QueuedDispatch): Promise<void> {
  const message = blockedMessage(job);
  console.log(`[dispatch-queue] ${job.id} is waiting on a failed job: ${job.reason}`);
  if (job.project && job.taskId) {
    try {
      const existing = await getTask(job.project, job.taskId);
      if (existing) {
        await updateTask(job.project, job.taskId, {
          status: "blocked",
          description: `${existing.description}\n\n---\n**Waiting on a failed job:** ${message}`,
        });
      }
    } catch {
      /* best-effort */
    }
  }
  // Not awaited: a chat post waits out any reply running in that chat, which
  // can take minutes, and the sweep must not wait with it.
  void postBlockedToChat(job, message);
}

/** postReportToChat gives up when the chat log was written in the last ten
 *  seconds, a few times over. A stopped chain lands right behind the failed
 *  job's own news, so this keeps trying for a few minutes: the whole point of
 *  the notice is that CVB sees it. */
const CHAT_RETRY_MS = 30_000;
const CHAT_ATTEMPTS = 10;

async function postBlockedToChat(
  job: Q.QueuedDispatch,
  message: string,
  status = "waiting on a failed job"
): Promise<void> {
  for (let attempt = 1; attempt <= CHAT_ATTEMPTS; attempt++) {
    const r = await postReportToChat({
      id: job.id,
      agent: job.agent,
      project: job.project,
      status,
      summary: null,
      errorMessage: message,
    });
    if (r.posted) return;
    const retryable = r.reason === "busy" || r.reason === "chat stayed busy";
    if (!retryable || attempt === CHAT_ATTEMPTS) {
      console.log(`[dispatch-queue] chat post skipped for ${job.id}: ${r.reason}`);
      return;
    }
    await new Promise((res) => setTimeout(res, CHAT_RETRY_MS));
  }
}

/** Usage limit: the dead predecessor is re-run once the limit lifts. Tells the
 *  chat when, so CVB doesn't re-dispatch it by hand and run it twice. */
async function reportHeld(job: Q.QueuedDispatch): Promise<void> {
  const when = job.holdUntil
    ? new Date(job.holdUntil).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "the reset";
  const message =
    `Held for the usage limit: ${job.reason ?? "the job it waits on stopped at the usage limit"}. ` +
    `At about ${when} the queue re-runs ${Q.shortId(job.after)} once, and this job starts after it finishes. ` +
    `Don't re-dispatch ${Q.shortId(job.after)} by hand, or it runs twice. To stop the chain instead:\n` +
    `node ${DISPATCH_SCRIPT} --cancel ${job.id}`;
  console.log(`[dispatch-queue] ${job.id} held for the usage limit until ${when}`);
  if (job.project && job.taskId) {
    try {
      const existing = await getTask(job.project, job.taskId);
      if (existing) {
        await updateTask(job.project, job.taskId, {
          description: `${existing.description}\n\n---\n**Held for the usage limit:** ${message}`,
        });
      }
    } catch {
      /* best-effort */
    }
  }
  void postBlockedToChat(job, message, "held for the usage limit");
}

/** Starts a fresh run of a ticket that died on the usage limit, under a new
 *  ticket id. Lives in api/dispatch/route.ts; registered by ensureQueueSweeper. */
export type QueueRerunner = (deadTicketId: string, newId: string) => Promise<void>;
let rerunner: QueueRerunner | null = null;

async function sweepOnce(start: QueueStarter, why: string): Promise<void> {
  if (!isDispatchQueueEnabled() || !isReleasingInstance()) return;
  const env = queueEnv();
  const plan = Q.planSweep(env);
  const reported: Q.QueuedDispatch[] = [...plan.blocked];
  for (const r of plan.rerun) {
    try {
      if (!rerunner) throw new Error("nothing is registered to re-run it");
      await rerunner(r.of, r.id);
      console.log(`[dispatch-queue] re-ran ${r.of} as ${r.id} after the usage limit [${why}]`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") continue;
      reported.push(
        ...Q.blockWaitersOn(env, r.id, `the re-run of ${Q.shortId(r.of)} after the usage limit could not start: ${e.message}`)
      );
    }
  }
  for (const job of plan.held) await reportHeld(job);
  Q.markNotified(env, plan.held.map((j) => j.id));
  for (const job of plan.release) {
    try {
      await start(job);
      console.log(`[dispatch-queue] released ${job.id} (${job.agent}) after ${job.after} [${why}]`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Another process already created this ticket: it started, just not here.
      if (e.code === "EEXIST") continue;
      const reason = `it could not be started: ${e.message}`;
      Q.markBlocked(env, job.id, reason);
      reported.push({ ...job, state: "blocked", reason });
    }
  }
  for (const job of reported) await reportBlocked(job);
  Q.markNotified(env, reported.map((j) => j.id));
}

// One sweep at a time per process; the file lock covers the other process.
let sweeping: Promise<void> = Promise.resolve();

export function runQueueSweep(start: QueueStarter, why: string): Promise<void> {
  sweeping = sweeping
    .then(() => sweepOnce(start, why))
    .catch((err) => console.error(`[dispatch-queue] sweep (${why}) failed:`, err));
  return sweeping;
}

/** Note that a ticket's worker reported blocked. Must run before the ticket is
 *  marked done, so no sweep ever sees it as a clean finish. Never throws. */
export async function noteBlockerReport(ticketId: string, blockerPost: string | null): Promise<void> {
  if (!blockerPost) return;
  try {
    Q.recordBlockedReport(queueEnv(), ticketId, blockerPost);
  } catch (err) {
    console.error(`[dispatch-queue] could not record ${ticketId} as blocked:`, err);
  }
}

/** Called when any ticket finishes, success or failure: release (or block)
 *  whatever was waiting on it. Never throws. */
export async function queueAfterTicket(start: QueueStarter, ticketId: string): Promise<void> {
  await runQueueSweep(start, `after ${Q.shortId(ticketId)}`);
}

const SWEEP_EVERY_MS = 30_000;
const g = globalThis as { __aiteamDispatchQueueSweeper?: ReturnType<typeof setInterval> };

/**
 * The safety net under the event-driven sweeps: every 30 seconds, release
 * anything whose predecessor finished where no completion hook saw it (a
 * restart, the other dashboard process). Started lazily from the dispatch
 * route's handlers, never at module load, so `next build` (which imports route
 * modules) can't start workers. instrumentation.ts pings that route once at boot.
 */
export function ensureQueueSweeper(start: QueueStarter, rerun?: QueueRerunner): void {
  if (rerun) rerunner = rerun;
  if (g.__aiteamDispatchQueueSweeper || !isReleasingInstance()) return;
  g.__aiteamDispatchQueueSweeper = setInterval(() => void runQueueSweep(start, "timer"), SWEEP_EVERY_MS);
  g.__aiteamDispatchQueueSweeper.unref?.();
  void runQueueSweep(start, "boot");
}
