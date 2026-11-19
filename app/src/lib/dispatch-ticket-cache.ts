import path from "node:path";
import { promises as fsp } from "node:fs";

/**
 * Read-mostly view of every dispatch ticket on disk, for pages that summarize
 * them (Projects row signals, the spend store's session list).
 *
 * Those pages used to JSON.parse all ~2,300 tickets on every request. Inside
 * the pm2-run dashboard each file open costs several times what it does from a
 * console, so that alone made /projects take ~2s (measured 2026-10-16). A
 * finished ticket never changes in any field these readers use, so it is read
 * once and kept. Queued and running tickets, and any file seen for the first
 * time, are read fresh on every call, which keeps "who is working right now"
 * live.
 *
 * Reads from disk rather than dispatch-store's in-memory map on purpose: other
 * processes (dispatch.mjs, startup reconciliation) write tickets too.
 */

export type RawTicket = Record<string, unknown>;

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** The only fields the summarizing readers use. Briefs and reports are most of
 *  a ticket's size, so they are dropped rather than held for every ticket. */
const KEEP = ["id", "agent", "project", "status", "pid", "sessionId", "startedAt", "finishedAt"];

function slim(t: RawTicket): RawTicket {
  const out: RawTicket = {};
  for (const k of KEEP) if (k in t) out[k] = t[k];
  return out;
}

/** filename -> parsed ticket, terminal tickets only. */
const finished = new Map<string, RawTicket>();

function ticketsDir(): string {
  return path.join(process.cwd(), ".dispatches");
}

export async function readAllTickets(): Promise<RawTicket[]> {
  const dir = ticketsDir();
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const present = new Set(names);
  for (const name of finished.keys()) {
    if (!present.has(name)) finished.delete(name);
  }

  const out = await Promise.all(
    names.map(async (name): Promise<RawTicket | null> => {
      const hit = finished.get(name);
      if (hit) return hit;
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")) as RawTicket;
        if (!parsed || typeof parsed !== "object") return null;
        const t = slim(parsed);
        if (typeof t.status === "string" && TERMINAL.has(t.status)) finished.set(name, t);
        return t;
      } catch {
        // Malformed, or caught mid-write: try again next call.
        return null;
      }
    })
  );
  return out.filter((t): t is RawTicket => t !== null);
}
