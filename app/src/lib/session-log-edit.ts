/**
 * Pure edits to a Claude Code session log. No filesystem, no config, no
 * imports: this is the part of a chat move that can silently corrupt a
 * conversation, so it is kept separate and testable on its own.
 *
 * Log shape that matters here: every conversational row (user, assistant,
 * attachment) carries a `uuid` and a `parentUuid` pointing at the row before
 * it, forming a chain the resume walks. Bookkeeping rows (queue-operation,
 * mode, ai-title, last-prompt) carry no uuid and sit outside the chain.
 */

export interface LogEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sourceToolAssistantUUID?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

/**
 * Grow a set of selected uuids to everything that only makes sense alongside
 * them: attachments hanging off a removed row, and the tool results belonging
 * to a removed assistant turn. A tool_result left behind with no matching
 * tool_use is exactly the kind of orphan that makes a resume fail.
 *
 * Loops to a fixpoint so a chain (assistant -> tool result -> its attachment)
 * comes out whole.
 */
export function expandRemovalSet(
  entries: LogEntry[],
  seed: Iterable<string>
): Set<string> {
  const removed = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries) {
      if (!e.uuid || removed.has(e.uuid)) continue;
      const parentGone = e.parentUuid ? removed.has(e.parentUuid) : false;
      const toolParentGone = e.sourceToolAssistantUUID
        ? removed.has(e.sourceToolAssistantUUID)
        : false;
      if ((e.type === "attachment" && parentGone) || toolParentGone) {
        removed.add(e.uuid);
        grew = true;
      }
    }
  }
  return removed;
}

/**
 * Drop the removed rows and repair the chain around the hole: any survivor
 * whose parent was removed is re-pointed at the last surviving row before it.
 * A survivor at the very front ends up with a null parent, same as the first
 * row of a fresh conversation.
 */
export function relink(entries: LogEntry[], removed: Set<string>): LogEntry[] {
  const kept: LogEntry[] = [];
  let lastKeptUuid: string | null = null;
  for (const e of entries) {
    if (e.uuid && removed.has(e.uuid)) continue;
    if (!e.uuid) {
      // Bookkeeping rows sit outside the chain, but `last-prompt` names the
      // turn's final row in `leafUuid`. Delete that turn and the pointer
      // dangles; re-point it the same way a child is re-parented.
      const leaf = typeof e.leafUuid === "string" ? e.leafUuid : null;
      if (leaf && removed.has(leaf)) {
        if (lastKeptUuid) kept.push({ ...e, leafUuid: lastKeptUuid });
        continue;
      }
      kept.push(e);
      continue;
    }
    if (e.parentUuid && removed.has(e.parentUuid)) {
      kept.push({ ...e, parentUuid: lastKeptUuid });
    } else {
      kept.push(e);
    }
    lastKeptUuid = e.uuid;
  }
  return kept;
}

/**
 * Build the row appended to the receiving chat. The envelope is cloned from an
 * existing row in that log so cwd/version/gitBranch match the rest of the file,
 * then the identity and content are replaced. Fields that belong to a specific
 * tool call or prompt are stripped so they can't reference something that isn't
 * in this log.
 */
export function buildAppendEntry(opts: {
  template: LogEntry | undefined;
  parentUuid: string | null;
  uuid: string;
  sessionId: string;
  cwd: string;
  text: string;
  timestamp: string;
}): LogEntry {
  const base: LogEntry = opts.template ? { ...opts.template } : {};
  for (const field of [
    "sourceToolAssistantUUID",
    "toolUseResult",
    "promptId",
    "requestId",
    "attachment",
    "effort",
  ]) {
    delete base[field];
  }
  return {
    ...base,
    parentUuid: opts.parentUuid,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: opts.text },
    uuid: opts.uuid,
    timestamp: opts.timestamp,
    userType: "external",
    cwd: opts.cwd,
    sessionId: opts.sessionId,
  };
}

/**
 * Every uuid referenced as a parent must exist in the file (or be null).
 * Cheap structural check to run after an edit, before anything is written.
 */
export function findBrokenLinks(entries: LogEntry[]): string[] {
  const present = new Set(entries.map((e) => e.uuid).filter(Boolean) as string[]);
  const broken: string[] = [];
  for (const e of entries) {
    if (e.parentUuid && !present.has(e.parentUuid)) {
      broken.push(`${e.uuid ?? "(no uuid)"} -> ${e.parentUuid}`);
    }
  }
  return broken;
}

function contentItems(e: LogEntry): Record<string, unknown>[] {
  const content = e.message?.content;
  return Array.isArray(content)
    ? (content.filter((c) => c && typeof c === "object") as Record<string, unknown>[])
    : [];
}

/**
 * Tool calls and tool results that have lost their other half. The API
 * rejects a conversation containing either, so a chat in that state can fail
 * to resume at all. Returned as `use:<id>` / `result:<id>` so two runs can be
 * compared.
 *
 * findBrokenLinks() cannot see this: the parent chain can be perfectly intact
 * with a tool result gone from under its call.
 */
export function findUnpairedTools(entries: LogEntry[]): Set<string> {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const e of entries) {
    for (const item of contentItems(e)) {
      if (item.type === "tool_use" && item.id) uses.add(String(item.id));
      else if (item.type === "tool_result" && item.tool_use_id) {
        results.add(String(item.tool_use_id));
      }
    }
  }
  const unpaired = new Set<string>();
  for (const id of uses) if (!results.has(id)) unpaired.add(`use:${id}`);
  for (const id of results) if (!uses.has(id)) unpaired.add(`result:${id}`);
  return unpaired;
}

/**
 * Tool pairs an edit broke: unpaired after, paired before. Compared against
 * the log as it was rather than demanding zero, so a call that was already
 * open (the turn a reply was interrupted in) doesn't block every later edit to
 * that chat, while anything the edit itself orphaned still does.
 */
export function newlyUnpairedTools(before: LogEntry[], after: LogEntry[]): string[] {
  const already = findUnpairedTools(before);
  return [...findUnpairedTools(after)].filter((k) => !already.has(k));
}
