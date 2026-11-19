import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import type { DispatchTicket } from "@/lib/dispatch-store";
import { getTask, updateTask } from "@/lib/tasks";

/**
 * Startup reconciliation for stranded dispatch tickets.
 *
 * A dispatched worker is a CHILD of this app, and the app owns its stdout pipe
 * and the exit promise that marks the ticket done. So a pm2 restart (deploy),
 * a crash, or a reboot mid-dispatch kills the worker and leaves its ticket on
 * "running" forever, with no report ever delivered. That bit us on 2026-06-30:
 * a deploy killed Devin mid-build, his code survived on disk,
 * the ticket stuck, and the work had to be re-dispatched.
 *
 * This runs once per server start (see src/instrumentation.ts) and closes those
 * tickets out so they stop lying about being alive.
 *
 * Deliberately does its own file I/O instead of going through dispatch-store:
 * instrumentation and route handlers are separate bundles and are not
 * guaranteed to share a module instance, so the store's in-memory cache is not
 * a reliable channel between them. Disk is. Because instrumentation's
 * `register()` completes before the server serves its first request, the files
 * are already correct by the time any route reads them.
 */

/** How long a ticket may sit in "queued" before a restart counts it stranded.
 *  The real queued window is milliseconds (createTicket, then runWorker flips
 *  it to running), so anything older than this outlived an app that died in
 *  that window. Generous on purpose: the cost of waiting is a ticket that
 *  closes on the NEXT restart instead of this one. */
const QUEUED_GRACE_MS = 2 * 60 * 1000;

export interface ReconcileResult {
  /** Tickets closed out as interrupted. */
  strandedCount: number;
  /** Tickets left alone because their worker is still alive. */
  survivingCount: number;
  ids: string[];
}

/**
 * True if `pid` is a process this machine currently has.
 *
 * Signal 0 does no work; it only asks the kernel whether the pid resolves.
 * EPERM means it exists but is owned by someone we can't signal, which is
 * still "alive". Anything else (ESRCH) means gone.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Decide whether a ticket's worker is genuinely gone.
 *
 * The blunt rule ("this app just started, therefore every running ticket is
 * dead") is WRONG here, because a second Next process may run this same
 * build from the same cwd and therefore share one .dispatches directory (a
 * second dashboard on another port, or a dev server next to the live one). Its
 * restart would wrongly fail a dispatch the main dashboard is actively running. So liveness of the recorded pid is the
 * test, and it errs toward leaving a ticket alone.
 */
function isStranded(t: DispatchTicket, bootMs: number, nowMs: number): boolean {
  if (t.status === "queued") {
    return nowMs - t.createdAt > QUEUED_GRACE_MS;
  }
  if (t.status !== "running") return false;
  if (t.pid === null) return true; // running with no pid recorded: nothing to check
  // A pid from before this boot cannot be the same process, whatever the OS
  // has since done with that number. Checking liveness first would risk a
  // recycled pid reading as "still running" forever.
  if ((t.startedAt ?? t.createdAt) < bootMs) return true;
  return !pidAlive(t.pid);
}

async function readTicket(file: string): Promise<DispatchTicket | null> {
  try {
    const raw = await fsp.readFile(file, "utf8");
    const t = JSON.parse(raw) as DispatchTicket;
    return t && typeof t.id === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Flip the ticket's board task off "in-progress" so the board stops lying too.
 *  Best-effort; a board failure must never break startup. */
async function blockBoardTask(t: DispatchTicket, why: string): Promise<void> {
  if (!t.project || !t.taskId) return;
  try {
    const existing = await getTask(t.project, t.taskId);
    if (!existing || existing.status !== "in-progress") return;
    await updateTask(t.project, t.taskId, {
      status: "blocked",
      description: `${existing.description}\n\n---\n**Outcome (blocked):** ${why}`,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Scan the ticket store and close out anything stranded by a restart.
 * Never throws: a reconciliation failure must not stop the server booting.
 */
export async function reconcileStrandedDispatches(
  dispatchesDir: string
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    strandedCount: 0,
    survivingCount: 0,
    ids: [],
  };
  let files: string[];
  try {
    files = await fsp.readdir(dispatchesDir);
  } catch {
    return result; // no dispatches yet — first run
  }

  const nowMs = Date.now();
  const bootMs = nowMs - os.uptime() * 1000;

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(dispatchesDir, f);
    const t = await readTicket(file);
    if (!t) continue;
    if (t.status !== "running" && t.status !== "queued") continue;

    if (!isStranded(t, bootMs, nowMs)) {
      result.survivingCount += 1;
      continue;
    }

    const stillAlive =
      t.status === "running" && t.pid !== null && pidAlive(t.pid);
    const why = stillAlive
      ? `Interrupted: the dashboard restarted while this dispatch was open, so its report was lost. Process ${t.pid} is still running and may finish its work on disk, but nothing is listening for it.`
      : "Interrupted: the dashboard restarted (deploy, crash, or reboot) while this dispatch was running, so the worker was killed and no report was delivered. Re-dispatch if the work is still needed.";

    const next: DispatchTicket = {
      ...t,
      status: "failed",
      finishedAt: nowMs,
      pid: null,
      errorMessage: why,
    };
    try {
      await fsp.writeFile(file, JSON.stringify(next, null, 2), "utf8");
    } catch {
      continue; // couldn't persist — leave it as-is rather than half-report it
    }
    try {
      await fsp.appendFile(
        path.join(dispatchesDir, "index.jsonl"),
        JSON.stringify({ ts: nowMs, ...next }) + "\n",
        "utf8"
      );
    } catch {
      /* index is best-effort */
    }
    await blockBoardTask(next, why);
    result.strandedCount += 1;
    result.ids.push(t.id);
  }

  return result;
}
