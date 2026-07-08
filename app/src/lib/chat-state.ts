import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatState } from "./types";
import { getConfig } from "./config";

/**
 * Chat-state files live under <app>/.chat-states/.
 * Default Dashboard chat: .chat-states/_default.json
 * Project chats:         .chat-states/project-<slug>.json
 *
 * Legacy: an older version stored the Dashboard at <app>/.chat-state.json.
 * We migrate that on first read.
 */

const STATES_DIR = path.join(process.cwd(), ".chat-states");
const LEGACY_STATE_PATH = path.join(process.cwd(), ".chat-state.json");

function fileForKey(key: string): string {
  // Sanitize the key so it's safe as a filename
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(STATES_DIR, `${safe}.json`);
}

function keyFor(slug?: string | null): string {
  if (!slug) return "_default";
  return `project-${slug}`;
}

async function ensureStatesDir(): Promise<void> {
  try {
    await fs.mkdir(STATES_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

async function tryReadJson(file: string): Promise<ChatState | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    if (parsed.sessionId) {
      return {
        sessionId: parsed.sessionId,
        started: parsed.started ?? false,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function migrateLegacyIfNeeded(): Promise<void> {
  const target = fileForKey(keyFor(null));
  try {
    await fs.access(target);
    return; // new-format file already exists
  } catch {
    /* fall through */
  }
  // No new-format default file; check legacy
  const legacy = await tryReadJson(LEGACY_STATE_PATH);
  if (!legacy) return;
  await ensureStatesDir();
  try {
    await fs.writeFile(target, JSON.stringify(legacy, null, 2), "utf8");
    await fs.unlink(LEGACY_STATE_PATH);
  } catch {
    /* best-effort */
  }
}

export async function readChatState(slug?: string | null): Promise<ChatState | null> {
  if (!slug) await migrateLegacyIfNeeded();
  return tryReadJson(fileForKey(keyFor(slug)));
}

export async function writeChatState(
  state: ChatState,
  slug?: string | null
): Promise<void> {
  await ensureStatesDir();
  await fs.writeFile(
    fileForKey(keyFor(slug)),
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

export async function getOrCreateSessionId(
  slug?: string | null
): Promise<ChatState> {
  const existing = await readChatState(slug);
  if (existing) return existing;
  const fresh: ChatState = { sessionId: randomUUID(), started: false };
  await writeChatState(fresh, slug);
  return fresh;
}

export async function markSessionStarted(
  sessionId: string,
  slug?: string | null
): Promise<void> {
  await writeChatState({ sessionId, started: true }, slug);
}

/**
 * Self-heal a chat state when claude already has the session jsonl on disk
 * but our state file still says started:false. This happens if the spawn
 * succeeded server-side (jsonl was created) but the route's markSessionStarted
 * never fired (e.g. the stream errored mid-flight). Without this, every
 * subsequent turn would re-attempt --session-id create and fail with
 * "Session ID is already in use". Returns the (possibly corrected) state.
 */
export async function healSessionStateForCwd(
  state: ChatState,
  cwd: string,
  slug?: string | null
): Promise<ChatState> {
  if (state.started) return state;
  const encoded = cwd.replace(/[:\\/]/g, "-");
  const sessionJsonl = path.join(
    getConfig().claudeProjectsDir,
    encoded,
    `${state.sessionId}.jsonl`
  );
  try {
    await fs.access(sessionJsonl);
  } catch {
    return state; // jsonl not present, state is accurate
  }
  const healed: ChatState = { sessionId: state.sessionId, started: true };
  await writeChatState(healed, slug);
  return healed;
}

export async function deleteChatState(slug?: string | null): Promise<void> {
  try {
    await fs.unlink(fileForKey(keyFor(slug)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
