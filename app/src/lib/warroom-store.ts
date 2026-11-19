import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * War Room session store. Mirrors the dispatch-store pattern: an in-memory Map
 * backed by JSON on disk, plus an EventEmitter the SSE route subscribes to.
 * A session is a live, multi-agent brainstorm; the engine (warroom-engine.ts)
 * drives the rounds and appends messages here, which fan out to watchers.
 */

export type WarRoomStatus =
  | "running"
  | "paused"
  | "synthesizing"
  | "done"
  | "cancelled"
  | "failed";

export type WarRoomRole = "facilitator" | "agent" | "human";

export interface WarRoomMessage {
  id: string;
  role: WarRoomRole;
  /** Name key: "claude" (facilitator), "owner" (human), or an agent name. */
  agent: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
  text: string;
  /** Which round this belongs to (0 = facilitator framing / setup). */
  round: number;
  ts: number;
}

export interface RosterMember {
  name: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
  /** Who answers for this member: the Claude CLI (default) or the OpenRouter API. */
  provider?: "claude" | "openrouter";
  /** Per-member model override: a Claude alias, or an OpenRouter model id for outsiders. */
  model?: string;
  /** Optional owner-supplied role/context for this session, appended to the system prompt. */
  extra?: string;
}

/** Research setting: none, private web research before Round 1, or that plus a
 *  mid-session research break with per-agent assigned questions. */
export type WarRoomResearch = "off" | "opening" | "deep";

export interface WarRoomSession {
  id: string;
  idea: string;
  objective: string;
  /** Short, creative AI-generated label for the header. Empty until generated. */
  title: string;
  model: string;
  /** Pace preset key (lightning|standard|deep) chosen at setup. */
  pace: string;
  /** Per-bubble word cap (a prompt instruction, soft cap). Derived from pace. */
  wordLimit: number;
  /** Reasoning effort passed to the CLI (--effort). Derived from pace. */
  effort: string;
  roster: string[];
  rosterMeta: RosterMember[];
  rounds: number;
  /** Persona strength 0-100. Low = sharp generalist who brings their specialty
   *  as one occasional lens; high = today's stay-in-your-lane specialist. */
  personaWeight: number;
  /** Research setting chosen at setup. */
  research: WarRoomResearch;
  /** Per-member private research notes (member name -> notes). Injected only
   *  into that member's own prompts; archived with the transcript. */
  researchNotes: Record<string, string>;
  status: WarRoomStatus;
  currentRound: number;
  messages: WarRoomMessage[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  savedPlanPath: string | null;
  /** Queued human interjections, folded into the next round's context. */
  pendingInterjections: string[];
  wrapRequested: boolean;
  cancelRequested: boolean;
  /** When true, the engine holds at the next round boundary so the owner can read /
   *  type. Cleared by Resume. */
  paused: boolean;
}

/** Live SSE event envelope. Typing events are ephemeral (not persisted). */
export type WarRoomEvent =
  | { type: "message"; message: WarRoomMessage }
  | {
      type: "typing";
      agent: string;
      displayName: string;
      color: string;
      avatarUrl: string | null;
      on: boolean;
    }
  | {
      type: "status";
      status: WarRoomStatus;
      currentRound: number;
      savedPlanPath: string | null;
    }
  | { type: "title"; title: string };

const WARROOM_DIR = path.join(process.cwd(), ".warroom");

const emitter = new EventEmitter();
// Allow many concurrent watchers without the Node warning.
emitter.setMaxListeners(0);
const sessions = new Map<string, WarRoomSession>();

// Live child processes per session, for cancellation. In-process only.
const runningChildren = new Map<string, Set<ChildProcess>>();

async function ensureDir(): Promise<void> {
  try {
    await fsp.mkdir(WARROOM_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function sessionPath(id: string): string {
  return path.join(WARROOM_DIR, `${id}.json`);
}

async function persist(s: WarRoomSession): Promise<void> {
  await ensureDir();
  try {
    await fsp.writeFile(sessionPath(s.id), JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

export function createSession(
  init: Omit<
    WarRoomSession,
    | "id"
    | "title"
    | "status"
    | "currentRound"
    | "messages"
    | "researchNotes"
    | "createdAt"
    | "startedAt"
    | "finishedAt"
    | "savedPlanPath"
    | "pendingInterjections"
    | "wrapRequested"
    | "cancelRequested"
    | "paused"
  > & { id: string }
): WarRoomSession {
  const s: WarRoomSession = {
    ...init,
    title: "",
    researchNotes: {},
    status: "running",
    currentRound: 0,
    messages: [],
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    savedPlanPath: null,
    pendingInterjections: [],
    wrapRequested: false,
    cancelRequested: false,
    paused: false,
  };
  sessions.set(s.id, s);
  void persist(s);
  return s;
}

export async function getSession(id: string): Promise<WarRoomSession | null> {
  const inMem = sessions.get(id);
  if (inMem) return inMem;
  // Fall back to disk (e.g. after a server reload mid-session).
  try {
    const raw = await fsp.readFile(sessionPath(id), "utf8");
    const s = JSON.parse(raw) as WarRoomSession;
    if (s && typeof s.id === "string") {
      sessions.set(s.id, s);
      return s;
    }
  } catch {
    /* not found */
  }
  return null;
}

/** Synchronous accessor for the engine, which only touches in-memory sessions. */
export function getSessionSync(id: string): WarRoomSession | null {
  return sessions.get(id) ?? null;
}

export function appendMessage(
  id: string,
  msg: WarRoomMessage
): WarRoomMessage | null {
  const s = sessions.get(id);
  if (!s) return null;
  s.messages.push(msg);
  void persist(s);
  emitter.emit("event", id, { type: "message", message: msg });
  return msg;
}

export function setStatus(
  id: string,
  status: WarRoomStatus,
  currentRound?: number
): void {
  const s = sessions.get(id);
  if (!s) return;
  s.status = status;
  if (typeof currentRound === "number") s.currentRound = currentRound;
  if (status === "done" || status === "cancelled" || status === "failed") {
    s.finishedAt = Date.now();
  }
  void persist(s);
  emitter.emit("event", id, {
    type: "status",
    status: s.status,
    currentRound: s.currentRound,
    savedPlanPath: s.savedPlanPath,
  });
}

export function setStarted(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.startedAt = Date.now();
  void persist(s);
}

export function setSavedPlanPath(id: string, p: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.savedPlanPath = p;
  void persist(s);
}

export function emitTyping(
  id: string,
  member: RosterMember,
  on: boolean
): void {
  emitter.emit("event", id, {
    type: "typing",
    agent: member.name,
    displayName: member.displayName,
    color: member.color,
    avatarUrl: member.avatarUrl,
    on,
  });
}

export function queueInterjection(id: string, text: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.pendingInterjections.push(text);
  void persist(s);
  return true;
}

export function drainInterjections(id: string): string[] {
  const s = sessions.get(id);
  if (!s) return [];
  const drained = s.pendingInterjections;
  s.pendingInterjections = [];
  void persist(s);
  return drained;
}

/** Append private research notes for one member (midpoint notes stack under
 *  the opening ones). Guards sessions persisted before this field existed. */
export function addResearchNotes(
  id: string,
  agent: string,
  notes: string
): void {
  const s = sessions.get(id);
  if (!s) return;
  if (!s.researchNotes) s.researchNotes = {};
  const prior = s.researchNotes[agent];
  s.researchNotes[agent] = prior ? `${prior}\n\n${notes}` : notes;
  void persist(s);
}

export function setTitle(id: string, title: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.title = title;
  void persist(s);
  emitter.emit("event", id, { type: "title", title });
}

export function setPaused(id: string, paused: boolean): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.paused = paused;
  void persist(s);
  return true;
}

export function requestWrap(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.wrapRequested = true;
  void persist(s);
  return true;
}

export function requestCancel(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.cancelRequested = true;
  void persist(s);
  // Kill any in-flight children immediately.
  const children = runningChildren.get(id);
  if (children) {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* noop */
      }
    }
    children.clear();
  }
  return true;
}

export function registerChild(id: string, child: ChildProcess): void {
  let set = runningChildren.get(id);
  if (!set) {
    set = new Set();
    runningChildren.set(id, set);
  }
  set.add(child);
}

export function unregisterChild(id: string, child: ChildProcess): void {
  runningChildren.get(id)?.delete(child);
}

/** Subscribe to all session events. Handler filters by id. Returns unsubscribe. */
export function subscribe(
  handler: (sessionId: string, event: WarRoomEvent) => void
): () => void {
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}
