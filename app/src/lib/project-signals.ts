import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listProjectTasks } from "./project-tasks";
import { readAllTickets } from "./dispatch-ticket-cache";

const execFileAsync = promisify(execFile);

/**
 * The cheap, live half of a project row: who's working, what's stuck, and git
 * state. Everything here is recomputed per request — unlike project-stats.ts,
 * none of it requires reading the transcript archive.
 */

/** A dispatch ticket left in "running" longer than this is assumed dead. Workers
 *  that crash never write a terminal status, so without this the row would show a
 *  phantom agent forever. */
const STALE_RUN_MS = 2 * 60 * 60_000;

/** How far back a failed run still counts as something the owner should look at. */
const RECENT_FAILURE_MS = 24 * 60 * 60_000;

export interface AgentActivity {
  /** Agents currently working, verified alive. */
  running: string[];
  /** Failed runs within the last day — part of the needs-you signal. */
  recentFailures: number;
  /** Completed runs in the last day, for the "N ran today" idle caption. */
  recentDone: number;
}

export interface ProjectSignals {
  agents: AgentActivity;
  tasks: { total: number; done: number; blocked: number; inProgress: number };
  git: GitState | null;
  /** True when something wants the owner's attention: a blocked task or a failed run. */
  needsYou: boolean;
}

interface Ticket {
  agent?: unknown;
  project?: unknown;
  status?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}

/** Is this PID still alive? Signal 0 checks existence without touching the process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function asMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Group every dispatch ticket's activity by project in one pass. Finished
 * tickets come from dispatch-ticket-cache, so only live ones touch the disk.
 */
export async function readAgentActivity(): Promise<Map<string, AgentActivity>> {
  const byProject = new Map<string, AgentActivity>();
  const now = Date.now();

  for (const t of (await readAllTickets()) as Ticket[]) {
    if (typeof t.project !== "string" || !t.project) continue;
    const entry =
      byProject.get(t.project) ??
      byProject.set(t.project, { running: [], recentFailures: 0, recentDone: 0 }).get(t.project)!;

    const started = asMs(t.startedAt);
    const finished = asMs(t.finishedAt);
    const agent = typeof t.agent === "string" ? t.agent : "agent";

    if (t.status === "running") {
      const fresh = started !== null && now - started < STALE_RUN_MS;
      const alive = typeof t.pid === "number" ? pidAlive(t.pid) : false;
      // Require both: a live PID proves the process exists, the age check
      // catches a recycled PID now belonging to something unrelated.
      if (fresh && alive && !entry.running.includes(agent)) entry.running.push(agent);
      continue;
    }
    if (t.status === "failed" && finished !== null && now - finished < RECENT_FAILURE_MS) {
      entry.recentFailures++;
    }
    if (t.status === "done" && finished !== null && now - finished < RECENT_FAILURE_MS) {
      entry.recentDone++;
    }
  }

  return byProject;
}

/**
 * Branch and uncommitted-file count in a SINGLE git invocation.
 *
 * `git status -b --porcelain` prints the branch on a leading "## " line and one
 * line per change, so it answers both questions at once. That matters more than
 * it looks: each call is only ~36ms, but process spawning on Windows is the real
 * cost, and two calls across ~25 projects meant 50 spawns and a 2.5s page.
 */
export interface GitState {
  branch: string | null;
  dirty: number;
}

/**
 * Short-lived cache of git results.
 *
 * Every page load shells out once per repo. Without this, a couple of quick
 * navigations means dozens of process spawns in a few seconds. The window is
 * deliberately short so committing something and reloading still shows the
 * change almost immediately.
 */
const gitCache = new Map<string, { at: number; value: GitState | null }>();
const GIT_CACHE_MS = 15_000;

async function readGit(cwd: string): Promise<GitState | null> {
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_CACHE_MS) return hit.value;
  const value = await readGitUncached(cwd);
  gitCache.set(cwd, { at: Date.now(), value });
  return value;
}

async function readGitUncached(cwd: string): Promise<GitState | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "-b", "--porcelain"], {
      cwd,
      timeout: 3000,
      maxBuffer: 4_000_000,
      // CRITICAL on Windows: without this, every spawn flashes a visible console
      // window. Listing ~20 repos meant a storm of windows blinking on screen on
      // each page load. Node defaults windowsHide to false.
      windowsHide: true,
    });
    let branch: string | null = null;
    let dirty = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("## ")) {
        // "## main...origin/main [ahead 1]" -> "main"; "## HEAD (no branch)" -> "HEAD"
        branch = line.slice(3).split("...")[0].split(" ")[0] || null;
      } else if (line.trim().length > 0) {
        dirty++;
      }
    }
    return { branch, dirty };
  } catch {
    // Not a repo, git missing, or a slow/locked index — the row just omits it.
    return null;
  }
}

async function readTaskCounts(cwd: string): Promise<ProjectSignals["tasks"]> {
  try {
    const tasks = await listProjectTasks(cwd);
    return {
      total: tasks.length,
      done: tasks.filter((t) => t.status === "done").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      inProgress: tasks.filter((t) => t.status === "in-progress").length,
    };
  } catch {
    return { total: 0, done: 0, blocked: 0, inProgress: 0 };
  }
}

/** Signals for every project, gathered in parallel. */
export async function getProjectSignals(
  projects: { slug: string; cwd: string; hasGit: boolean }[]
): Promise<Record<string, ProjectSignals>> {
  const activity = await readAgentActivity();
  const entries = await Promise.all(
    projects.map(async ({ slug, cwd, hasGit }) => {
      const [tasks, git] = await Promise.all([
        readTaskCounts(cwd),
        hasGit ? readGit(cwd) : Promise.resolve(null),
      ]);
      const agents =
        activity.get(slug) ?? { running: [], recentFailures: 0, recentDone: 0 };
      const signals: ProjectSignals = {
        agents,
        tasks,
        git,
        needsYou: tasks.blocked > 0 || agents.recentFailures > 0,
      };
      return [slug, signals] as const;
    })
  );
  return Object.fromEntries(entries);
}
