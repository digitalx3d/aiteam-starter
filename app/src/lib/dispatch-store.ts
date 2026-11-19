import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

export type DispatchStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface DispatchTicket {
  id: string;
  agent: string;
  /** Project slug. null when dispatched against the aiTeam dir itself. */
  project: string | null;
  brief: string;
  status: DispatchStatus;
  /** OS pid of the spawned claude.exe, when running. Null otherwise. */
  pid: number | null;
  sessionId: string;
  cwd: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** One-line summary the worker reported on completion (or last assistant text).
   *  Deliberately short — it feeds the Live Feed and the chat bubble. For anything
   *  that needs the whole story, use `report`. */
  summary: string | null;
  /** The worker's complete final message, unabridged.
   *
   *  `summary` caps at 600 chars, which truncated 64% of reports mid-sentence and
   *  lost up to 83% of their content — including things that mattered, like a
   *  worker standing down because it detected two agents editing the same files.
   *  Previously this text was computed, used to derive `summary`, then discarded;
   *  the only surviving copy was buried in the multi-hundred-KB raw stream at
   *  .dispatches/<id>.jsonl, which nothing read. */
  report: string | null;
  /** True when CVB asked for a security review on this line of work. It is the
   *  ONLY thing that lets a ===HANDOFF=== auto-fire (see dispatch-handoff.ts):
   *  a worker cannot authorize its own review. Propagates down a handoff chain so
   *  an authorized review can hand back for fixes. */
  securityReview?: boolean;
  /** Absolute (or repo-relative) path to the worker's full write-up, pulled from
   *  the report before the summary cap could truncate it away. Null when the
   *  report names no such file. Rendered with the chat post so a "see the review"
   *  report always says WHERE. */
  reportPath?: string | null;
  /** Non-zero exit / spawn error message, when status=failed. */
  errorMessage: string | null;
  /** Board task this dispatch is tied to (auto-created or referenced). null if none. */
  taskId: string | null;
  /** For auto-handoff chains: the ticket that triggered this one. null for root dispatches. */
  parentTicketId: string | null;
  /** Auto-handoff hop count. 0 for a root (CVB-initiated) dispatch; +1 per auto-hop. */
  chainDepth: number;
  /** Model this worker was spawned on, after resolving request > persona.
   *  Null means no --model flag was passed and the CLI default applied.
   *  Recorded so the Agents tab can show what's actually running. */
  model: string | null;
  /** Reasoning effort for this spawn, same resolution order. Null means no
   *  --effort flag was passed. */
  effort: string | null;
}

const DISPATCHES_DIR = path.join(process.cwd(), ".dispatches");
const INDEX_LOG = path.join(DISPATCHES_DIR, "index.jsonl");

const emitter = new EventEmitter();
const tickets = new Map<string, DispatchTicket>();
let loaded = false;

async function ensureDir(): Promise<void> {
  try {
    await fsp.mkdir(DISPATCHES_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function ticketPath(id: string): string {
  return path.join(DISPATCHES_DIR, `${id}.json`);
}

async function writeTicket(t: DispatchTicket): Promise<void> {
  await ensureDir();
  await fsp.writeFile(ticketPath(t.id), JSON.stringify(t, null, 2), "utf8");
}

async function appendIndex(t: DispatchTicket): Promise<void> {
  await ensureDir();
  try {
    await fsp.appendFile(
      INDEX_LOG,
      JSON.stringify({ ts: Date.now(), ...t }) + "\n",
      "utf8"
    );
  } catch {
    /* best-effort */
  }
}

async function loadAll(): Promise<void> {
  if (loaded) return;
  try {
    const entries = await fsp.readdir(DISPATCHES_DIR);
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fsp.readFile(path.join(DISPATCHES_DIR, f), "utf8");
        const t = JSON.parse(raw) as DispatchTicket;
        if (t && typeof t.id === "string") tickets.set(t.id, t);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* directory doesn't exist yet — first run */
  }
  loaded = true;
}

export async function listTickets(): Promise<DispatchTicket[]> {
  await loadAll();
  return Array.from(tickets.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
}

export async function listOpenTickets(): Promise<DispatchTicket[]> {
  const all = await listTickets();
  return all.filter((t) => t.status === "queued" || t.status === "running");
}

export async function getTicket(id: string): Promise<DispatchTicket | null> {
  await loadAll();
  return tickets.get(id) ?? null;
}

export interface CreateTicketInput {
  agent: string;
  project: string | null;
  brief: string;
  sessionId: string;
  cwd: string;
  parentTicketId?: string | null;
  chainDepth?: number;
  model?: string | null;
  effort?: string | null;
  /** CVB asked for a security review on this line of work. Gates auto-handoff. */
  securityReview?: boolean;
  /** Use this id instead of a fresh one: a job released from the dispatch queue
   *  keeps the id it was given when queued. The ticket file is then created
   *  exclusively, so the same queued job can never become two tickets. */
  id?: string;
}

export async function createTicket(
  init: CreateTicketInput
): Promise<DispatchTicket> {
  await loadAll();
  if (init.id) {
    await ensureDir();
    // Throws EEXIST if any process already created this ticket.
    await fsp.writeFile(ticketPath(init.id), "{}", { encoding: "utf8", flag: "wx" });
  }
  const t: DispatchTicket = {
    id: init.id ?? randomUUID(),
    agent: init.agent,
    project: init.project,
    brief: init.brief,
    status: "queued",
    pid: null,
    sessionId: init.sessionId,
    cwd: init.cwd,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    summary: null,
    report: null,
    reportPath: null,
    securityReview: init.securityReview === true,
    errorMessage: null,
    taskId: null,
    parentTicketId: init.parentTicketId ?? null,
    chainDepth: init.chainDepth ?? 0,
    model: init.model ?? null,
    effort: init.effort ?? null,
  };
  tickets.set(t.id, t);
  await writeTicket(t);
  await appendIndex(t);
  emitter.emit("event", t);
  return t;
}

export async function updateTicket(
  id: string,
  patch: Partial<DispatchTicket>
): Promise<DispatchTicket | null> {
  await loadAll();
  const cur = tickets.get(id);
  if (!cur) return null;
  const next: DispatchTicket = { ...cur, ...patch, id: cur.id };
  tickets.set(id, next);
  await writeTicket(next);
  await appendIndex(next);
  emitter.emit("event", next);
  return next;
}

/**
 * Subscribe to ticket lifecycle events. Returns an unsubscribe function.
 * Called by the dispatch SSE route so the dashboard sees changes in real time.
 */
export function subscribe(
  handler: (t: DispatchTicket) => void
): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}

// Live child-process registry. Lives in-process only — survives no reloads.
// Used so DELETE /api/dispatch/:id can kill a running worker directly.
const runningChildren = new Map<string, ChildProcess>();

export function registerRunningChild(
  ticketId: string,
  child: ChildProcess
): void {
  runningChildren.set(ticketId, child);
}

export function unregisterRunningChild(ticketId: string): void {
  runningChildren.delete(ticketId);
}

export function killTicketChild(ticketId: string): boolean {
  const child = runningChildren.get(ticketId);
  if (!child) return false;
  try {
    child.kill();
  } catch {
    return false;
  }
  runningChildren.delete(ticketId);
  return true;
}
