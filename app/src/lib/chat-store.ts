"use client";

import type { ChatMessage, ContentBlock, TraceEvent } from "./types";

// ---- Dispatch-report injection ----
// Dispatched workers (Devin, Maya, Casey, Indy, Ethan) run as top-level
// claude processes out-of-band. When one finishes, the server emits an event
// on /api/dispatch/events; we inject a synthetic chat bubble into the
// appropriate scope so the orchestrator chat sees "📨 Devin finished: …".

interface DispatchTicket {
  id: string;
  agent: string;
  project: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  summary: string | null;
  errorMessage: string | null;
  finishedAt: number | null;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function injectDispatchReport(ticket: DispatchTicket): void {
  if (
    ticket.status !== "done" &&
    ticket.status !== "failed" &&
    ticket.status !== "cancelled"
  ) {
    return;
  }
  const scopeKey = ticket.project ? `project:${ticket.project}` : "default";
  const projectTag = ticket.project ? ` _(${ticket.project})_` : "";
  const emoji =
    ticket.status === "done"
      ? "📨"
      : ticket.status === "failed"
      ? "⚠️"
      : "⏹";
  const text =
    ticket.status === "done"
      ? ticket.summary?.trim() || "(no summary)"
      : ticket.status === "failed"
      ? `Worker failed: ${ticket.errorMessage ?? "unknown error"}`
      : "Cancelled.";
  const msg: ChatMessage = {
    id: `dispatch-${ticket.id}-${ticket.status}`,
    role: "assistant",
    // personaName is just the agent slug — message-bubble's avatar/name
    // lookup keys off this. Project context goes in the body text instead.
    personaName: ticket.agent,
    blocks: [
      { kind: "text", text: `${emoji}${projectTag} ${text}` },
    ],
    createdAt: ticket.finishedAt ?? Date.now(),
  };
  updateMessages(scopeKey, (prev) => {
    if (prev.some((m) => m.id === msg.id)) return prev;
    return [...prev, msg];
  });
}

interface VbReply {
  scope: string;
  ticketId: string;
  text: string;
  ts: number;
}

function injectVbReply(reply: VbReply): void {
  const msg: ChatMessage = {
    id: `vb-reply-${reply.ticketId}-${reply.ts}`,
    role: "assistant",
    personaName: "claude",
    blocks: [{ kind: "text", text: reply.text }],
    createdAt: reply.ts,
  };
  updateMessages(reply.scope, (prev) => {
    if (prev.some((m) => m.id === msg.id)) return prev;
    return [...prev, msg];
  });
}

let dispatchStreamStarted = false;
function ensureDispatchStream(): void {
  if (dispatchStreamStarted) return;
  if (typeof window === "undefined") return;
  dispatchStreamStarted = true;
  try {
    const es = new EventSource("/api/dispatch/events");
    es.addEventListener("message", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          ticket?: DispatchTicket;
          reply?: VbReply;
        };
        if (data.type === "ticket" && data.ticket) {
          injectDispatchReport(data.ticket);
          return;
        }
        if (data.type === "vb-reply" && data.reply) {
          injectVbReply(data.reply);
          return;
        }
      } catch {
        /* skip malformed */
      }
    });
    es.addEventListener("error", () => {
      // Browser auto-reconnects EventSource; no manual retry needed.
    });
  } catch {
    /* EventSource unavailable; dispatch reports won't surface. Not fatal. */
  }
}

if (typeof window !== "undefined") {
  // Defer to next tick so module init doesn't block on the network call.
  setTimeout(ensureDispatchStream, 0);
}

// ---- Per-scope chat state, lifted out of any component lifecycle. ----
// Each scope is identified by a key: "default" for the Dashboard chat,
// or `project:<slug>` for a project chat. Multiple scopes can stream
// concurrently; navigating between pages doesn't tear down their streams.

export type ScopeKey = string;

export interface ScopeState {
  messages: ChatMessage[];
  busy: boolean;
  errorBanner: string | null;
  /** Raw stderr from the failed claude subprocess (when applicable). Surfaced
   *  in a small dimmed line under errorBanner so failures aren't opaque. */
  errorDetail: string | null;
}

interface InternalScope extends ScopeState {
  abortController: AbortController | null;
  /** Tools the user has approved for this scope. Persists across turns within the session. */
  allowedTools: Set<string>;
}

const EMPTY_SCOPE: ScopeState = {
  messages: [],
  busy: false,
  errorBanner: null,
  errorDetail: null,
};

const scopes = new Map<ScopeKey, InternalScope>();
const subscribers = new Map<ScopeKey, Set<() => void>>();
const lastSeenAt = new Map<ScopeKey, number>();

// Snapshot identity matters for useSyncExternalStore — return a stable empty
// object reference for unknown scopes so React doesn't loop.
const emptySnapshots = new Map<ScopeKey, ScopeState>();
function getEmpty(key: ScopeKey): ScopeState {
  let s = emptySnapshots.get(key);
  if (!s) {
    s = EMPTY_SCOPE;
    emptySnapshots.set(key, s);
  }
  return s;
}

function getInternal(key: ScopeKey): InternalScope {
  let s = scopes.get(key);
  if (!s) {
    s = { ...EMPTY_SCOPE, abortController: null, allowedTools: new Set() };
    scopes.set(key, s);
  }
  return s;
}

function notify(key: ScopeKey): void {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const cb of subs) cb();
}

export function subscribe(key: ScopeKey, cb: () => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

// We return the InternalScope directly — typed as ScopeState — so React's
// useSyncExternalStore gets a stable reference between updates. update() and
// updateMessages() both swap in a new InternalScope object on real changes,
// which is what triggers re-renders.
export function getSnapshot(key: ScopeKey): ScopeState {
  const s = scopes.get(key);
  if (!s) return getEmpty(key);
  return s;
}

function update(key: ScopeKey, patch: Partial<InternalScope>): void {
  const prev = getInternal(key);
  const next: InternalScope = { ...prev, ...patch };
  scopes.set(key, next);
  notify(key);
}

function updateMessages(
  key: ScopeKey,
  fn: (prev: ChatMessage[]) => ChatMessage[]
): void {
  const prev = getInternal(key);
  const next: InternalScope = { ...prev, messages: fn(prev.messages) };
  scopes.set(key, next);
  notify(key);
}

// ----------------- Streaming parser, lifted from ChatSurface -----------------

interface ToolUseBlockState extends Extract<ContentBlock, { kind: "tool_use" }> {
  inputJsonBuffer?: string;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

async function consumeStream(
  key: ScopeKey,
  response: Response
): Promise<void> {
  if (!response.body) {
    update(key, { errorBanner: "No response body", errorDetail: null });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let currentAssistantId: string | null = null;
  const blockIndexMap = new Map<
    number,
    ToolUseBlockState | { kind: "text"; text: string }
  >();
  let traceBuffer: TraceEvent[] = [];

  const ensureAssistantMessage = () => {
    if (currentAssistantId) return;
    const id = newId();
    currentAssistantId = id;
    updateMessages(key, (prev) => [
      ...prev,
      {
        id,
        role: "assistant",
        blocks: [],
        pending: true,
        traceEvents: [],
        createdAt: Date.now(),
      },
    ]);
    blockIndexMap.clear();
    traceBuffer = [];
  };

  const blocksFromMap = (): ContentBlock[] => {
    const indices = [...blockIndexMap.keys()].sort((a, b) => a - b);
    return indices.map((i) => {
      const b = blockIndexMap.get(i)!;
      if (b.kind === "text") return { kind: "text", text: b.text };
      const tu = b as ToolUseBlockState;
      let parsedInput: unknown = tu.input;
      if (
        tu.inputJsonBuffer &&
        tu.inputJsonBuffer.trim().length > 0 &&
        (parsedInput === undefined ||
          (typeof parsedInput === "object" &&
            parsedInput !== null &&
            Object.keys(parsedInput).length === 0))
      ) {
        try {
          parsedInput = JSON.parse(tu.inputJsonBuffer);
        } catch {
          parsedInput = tu.inputJsonBuffer;
        }
      }
      return {
        kind: "tool_use",
        id: tu.id,
        name: tu.name,
        input: parsedInput ?? {},
        result: tu.result,
        resultIsError: tu.resultIsError,
      };
    });
  };

  const updateAssistantBlocks = (blocks: ContentBlock[]) => {
    const id = currentAssistantId;
    if (!id) return;
    updateMessages(key, (prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, blocks, pending: true } : m
      )
    );
  };

  const finalizeAssistant = () => {
    const id = currentAssistantId;
    if (!id) return;
    const events = traceBuffer.slice();
    updateMessages(key, (prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              pending: false,
              traceEvents: [...(m.traceEvents ?? []), ...events],
            }
          : m
      )
    );
    currentAssistantId = null;
    blockIndexMap.clear();
    traceBuffer = [];
  };

  const recordTrace = (evt: unknown) => {
    if (currentAssistantId) {
      traceBuffer.push({ ts: Date.now(), event: evt });
    }
  };

  const recordToolResultTrace = (toolUseId: string, evt: unknown) => {
    updateMessages(key, (prev) =>
      prev.map((m) => {
        if (m.role !== "assistant") return m;
        const owns = m.blocks.some(
          (b) => b.kind === "tool_use" && b.id === toolUseId
        );
        if (!owns) return m;
        return {
          ...m,
          traceEvents: [
            ...(m.traceEvents ?? []),
            { ts: Date.now(), event: evt },
          ],
        };
      })
    );
  };

  const attachToolResult = (
    toolUseId: string,
    content: unknown,
    isError: boolean
  ) => {
    const resultStr =
      typeof content === "string"
        ? content
        : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === "string"
                ? c
                : c && typeof c === "object" && "text" in c
                ? String((c as { text: unknown }).text)
                : JSON.stringify(c)
            )
            .join("\n")
        : JSON.stringify(content);

    const needsApproval =
      isError && /requires approval/i.test(resultStr);

    updateMessages(key, (prev) =>
      prev.map((m) => {
        if (m.role !== "assistant") return m;
        let changed = false;
        const newBlocks = m.blocks.map((b) => {
          if (b.kind === "tool_use" && b.id === toolUseId) {
            changed = true;
            return {
              ...b,
              result: resultStr,
              resultIsError: isError,
              ...(needsApproval
                ? { needsApproval: true, approvalStatus: "pending" as const }
                : {}),
            };
          }
          return b;
        });
        return changed ? { ...m, blocks: newBlocks } : m;
      })
    );
  };

  const processClaudeEvent = (evt: Record<string, unknown>) => {
    const type = evt.type as string | undefined;
    if (type === "session") return;
    if (type === "done") {
      recordTrace(evt);
      finalizeAssistant();
      return;
    }
    if (type === "error") {
      recordTrace(evt);
      const detail =
        typeof evt.stderr === "string" && evt.stderr.trim().length > 0
          ? evt.stderr.trim()
          : null;
      update(key, {
        errorBanner: String(evt.message ?? "Unknown error"),
        errorDetail: detail,
      });
      finalizeAssistant();
      return;
    }

    recordTrace(evt);

    if (type === "stream_event") {
      const inner = evt.event as Record<string, unknown> | undefined;
      if (!inner) return;
      const innerType = inner.type as string;

      if (innerType === "message_start") {
        ensureAssistantMessage();
        return;
      }
      if (innerType === "content_block_start") {
        ensureAssistantMessage();
        const idx = inner.index as number;
        const cb = inner.content_block as Record<string, unknown>;
        if (cb?.type === "text") {
          blockIndexMap.set(idx, { kind: "text", text: "" });
        } else if (cb?.type === "tool_use") {
          blockIndexMap.set(idx, {
            kind: "tool_use",
            id: String(cb.id),
            name: String(cb.name),
            input: {},
            inputJsonBuffer: "",
          });
        }
        updateAssistantBlocks(blocksFromMap());
        return;
      }
      if (innerType === "content_block_delta") {
        ensureAssistantMessage();
        const idx = inner.index as number;
        const delta = inner.delta as Record<string, unknown>;
        const existing = blockIndexMap.get(idx);
        if (delta?.type === "text_delta" && existing?.kind === "text") {
          existing.text += String(delta.text ?? "");
        } else if (
          delta?.type === "input_json_delta" &&
          existing?.kind === "tool_use"
        ) {
          (existing as ToolUseBlockState).inputJsonBuffer =
            ((existing as ToolUseBlockState).inputJsonBuffer ?? "") +
            String(delta.partial_json ?? "");
        }
        updateAssistantBlocks(blocksFromMap());
        return;
      }
      if (innerType === "content_block_stop") {
        updateAssistantBlocks(blocksFromMap());
        return;
      }
      if (innerType === "message_stop") {
        finalizeAssistant();
        return;
      }
      return;
    }

    if (type === "assistant" && evt.message) {
      const message = evt.message as Record<string, unknown>;
      const content = message.content as unknown[];
      if (!currentAssistantId) ensureAssistantMessage();
      const blocks: ContentBlock[] = [];
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object" && "type" in item) {
            const it = item as Record<string, unknown>;
            if (it.type === "text") {
              blocks.push({ kind: "text", text: String(it.text ?? "") });
            } else if (it.type === "tool_use") {
              blocks.push({
                kind: "tool_use",
                id: String(it.id),
                name: String(it.name),
                input: it.input ?? {},
              });
            }
          }
        }
      }
      const accumulated = blocksFromMap();
      const hasContent = accumulated.some(
        (b) =>
          (b.kind === "text" && b.text.length > 0) ||
          (b.kind === "tool_use" && b.id)
      );
      if (!hasContent) updateAssistantBlocks(blocks);
      return;
    }

    if (type === "user" && evt.message) {
      const message = evt.message as Record<string, unknown>;
      const content = message.content as unknown[];
      if (Array.isArray(content)) {
        for (const item of content) {
          if (
            item &&
            typeof item === "object" &&
            "type" in item &&
            (item as Record<string, unknown>).type === "tool_result"
          ) {
            const it = item as Record<string, unknown>;
            const tuid = String(it.tool_use_id);
            attachToolResult(tuid, it.content, Boolean(it.is_error));
            recordToolResultTrace(tuid, evt);
          }
        }
      }
      return;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlnl: number;
    while ((nlnl = buffer.indexOf("\n\n")) !== -1) {
      const evtBlock = buffer.slice(0, nlnl);
      buffer = buffer.slice(nlnl + 2);
      const dataLine = evtBlock
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const raw = dataLine.slice(6).trim();
      if (!raw) continue;
      try {
        const ev = JSON.parse(raw) as Record<string, unknown>;
        processClaudeEvent(ev);
      } catch {
        /* skip unparseable */
      }
    }
  }

  finalizeAssistant();
}

// ----------------- Public API -----------------

export interface SendOptions {
  text: string;
  model: string;
  /** Optional project slug. Omit for the default Dashboard chat. */
  projectSlug?: string;
  /** Permission mode. Default: acceptEdits. */
  permissionMode?: "acceptEdits" | "bypassPermissions";
  /** Tool names to auto-approve for this turn (e.g. ["Bash"]). */
  allowedTools?: string[];
}

export async function sendMessage(
  key: ScopeKey,
  opts: SendOptions
): Promise<void> {
  const trimmed = opts.text.trim();
  if (!trimmed) return;
  const internal = getInternal(key);
  if (internal.busy) return;

  const userMsg: ChatMessage = {
    id: newId(),
    role: "user",
    blocks: [{ kind: "text", text: trimmed }],
    createdAt: Date.now(),
  };

  const ctrl = new AbortController();
  update(key, {
    messages: [...internal.messages, userMsg],
    busy: true,
    errorBanner: null,
    errorDetail: null,
    abortController: ctrl,
  });

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: trimmed,
        model: opts.model,
        ...(opts.projectSlug ? { project: opts.projectSlug } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(() => {
          const merged = new Set<string>(internal.allowedTools);
          if (opts.allowedTools) {
            for (const t of opts.allowedTools) merged.add(t);
          }
          return merged.size > 0 ? { allowedTools: [...merged] } : {};
        })(),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      update(key, {
        errorBanner: `HTTP ${res.status}: ${text || "request failed"}`,
        errorDetail: null,
      });
      return;
    }
    await consumeStream(key, res);
  } catch (err) {
    const e = err as Error;
    if (e.name !== "AbortError") {
      update(key, { errorBanner: e.message, errorDetail: null });
    }
  } finally {
    // Clear pending state on any in-flight assistant message (covers abort case)
    updateMessages(key, (prev) =>
      prev.map((m) => (m.pending ? { ...m, pending: false } : m))
    );
    const cur = getInternal(key);
    if (cur.abortController === ctrl) {
      update(key, { busy: false, abortController: null });
    } else {
      update(key, { busy: false });
    }
  }
}

export function stopMessage(key: ScopeKey): void {
  const s = getInternal(key);
  s.abortController?.abort();
}

export function clearError(key: ScopeKey): void {
  update(key, { errorBanner: null, errorDetail: null });
}

export function setMessages(key: ScopeKey, messages: ChatMessage[]): void {
  update(key, { messages });
}

export function clearScope(key: ScopeKey): void {
  const s = getInternal(key);
  s.abortController?.abort();
  scopes.set(key, {
    messages: [],
    busy: false,
    errorBanner: null,
    errorDetail: null,
    abortController: null,
    allowedTools: new Set(),
  });
  notify(key);
}

/** Find a tool_use block by id within the scope's messages. */
function findToolUseBlock(
  key: ScopeKey,
  toolUseId: string
): Extract<ContentBlock, { kind: "tool_use" }> | null {
  const s = getInternal(key);
  for (const m of s.messages) {
    for (const b of m.blocks) {
      if (b.kind === "tool_use" && b.id === toolUseId) return b;
    }
  }
  return null;
}

/** Mark a tool's approval status without sending anything. */
function setApprovalStatus(
  key: ScopeKey,
  toolUseId: string,
  status: "approved" | "denied"
): void {
  updateMessages(key, (prev) =>
    prev.map((m) => {
      if (m.role !== "assistant") return m;
      let changed = false;
      const newBlocks = m.blocks.map((b) => {
        if (b.kind === "tool_use" && b.id === toolUseId) {
          changed = true;
          return { ...b, approvalStatus: status };
        }
        return b;
      });
      return changed ? { ...m, blocks: newBlocks } : m;
    })
  );
}

/**
 * Approve a denied tool call. Adds the tool name to the scope's allowed list,
 * marks the block as approved, and sends a follow-up "please proceed" message
 * with --allowedTools now including this tool.
 */
export async function approveToolCall(
  key: ScopeKey,
  toolUseId: string,
  opts: { model: string; projectSlug?: string; permissionMode?: "acceptEdits" | "bypassPermissions" }
): Promise<void> {
  const block = findToolUseBlock(key, toolUseId);
  if (!block) return;
  const internal = getInternal(key);
  if (internal.busy) return;

  // Add to scope-level allowed tools so future calls don't re-prompt
  internal.allowedTools.add(block.name);
  setApprovalStatus(key, toolUseId, "approved");

  await sendMessage(key, {
    text: `Approved. Please proceed with the previously denied ${block.name} call.`,
    model: opts.model,
    projectSlug: opts.projectSlug,
    permissionMode: opts.permissionMode,
    allowedTools: [block.name],
  });
}

/** Deny a tool call. Marks the block as denied; no follow-up message sent. */
export function denyToolCall(key: ScopeKey, toolUseId: string): void {
  setApprovalStatus(key, toolUseId, "denied");
}

export function scopeKeyFor(projectSlug?: string | null): ScopeKey {
  return projectSlug ? `project:${projectSlug}` : "default";
}

/** Mark all messages currently in a scope as "seen" — clears the unread count. */
export function markScopeSeen(key: ScopeKey): void {
  lastSeenAt.set(key, Date.now());
  notify(key);
}

/** Count assistant messages in the scope newer than the last seen timestamp. */
export function getUnreadCount(key: ScopeKey): number {
  const s = scopes.get(key);
  if (!s) return 0;
  const since = lastSeenAt.get(key) ?? 0;
  let n = 0;
  for (const m of s.messages) {
    if (m.role === "assistant" && (m.createdAt ?? 0) > since) n++;
  }
  return n;
}
