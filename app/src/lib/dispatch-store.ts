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
  /** One-line summary the worker reported on completion (or last assistant text). */
  summary: string | null;
  /** Non-zero exit / spawn error message, when status=failed. */
  errorMessage: string | null;
  /** Board task this dispatch is tied to (auto-created or referenced). null if none. */
  taskId: string | null;
  /** For auto-handoff chains: the ticket that triggered this one. null for root dispatches. */
  parentTicketId: string | null;
  /** Auto-handoff hop count. 0 for a root (CVB-initiated) dispatch; +1 per auto-hop. */
  chainDepth: number;
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
}

export async function createTicket(
  init: CreateTicketInput
): Promise<DispatchTicket> {
  await loadAll();
  const t: DispatchTicket = {
    id: randomUUID(),
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
    errorMessage: null,
    taskId: null,
    parentTicketId: init.parentTicketId ?? null,
    chainDepth: init.chainDepth ?? 0,
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
