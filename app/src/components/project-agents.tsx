"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Users, ChevronRight, ChevronDown, Wrench } from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";
import { QueuedDispatches } from "@/components/queued-dispatches";
import type { DispatchTicket } from "@/lib/dispatch-store";
import type { FeedEntry } from "@/lib/dispatch-transcript";

// Tools whose body (the actual code/command) is worth showing inline by default;
// everything else (Read/Grep/Glob/etc.) stays collapsed to keep the feed readable.
const WORK_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);

interface AgentMeta {
  name: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
}

// A finished dispatch lingers in the board this long after it completes, so you
// catch the outcome ("Ethan just finished") before it clears.
const FINISHED_LINGER_MS = 15 * 60 * 1000;

/** "2m 14s" / "45s" / "1h 3m" — live elapsed for a running/queued dispatch. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "just now" / "3m ago" / "2h ago" — for a finished dispatch. */
function timeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "claude-opus-5" / "opus" -> "Opus". Keeps anything unrecognized readable. */
function fmtModel(model: string): string {
  const m = model.toLowerCase();
  for (const known of ["opus", "sonnet", "haiku", "fable"]) {
    if (m.includes(known)) return known.charAt(0).toUpperCase() + known.slice(1);
  }
  return model.replace(/^claude-/, "");
}

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

/**
 * "Opus · xHigh" — what this worker is actually running on, so a slow dispatch
 * explains itself at a glance. Older tickets predate the fields and show nothing.
 */
function SpawnBadge({
  model,
  effort,
}: {
  model: string | null | undefined;
  effort: string | null | undefined;
}) {
  const parts: string[] = [];
  if (model) parts.push(fmtModel(model));
  if (effort) parts.push(EFFORT_LABELS[effort.toLowerCase()] ?? effort);
  if (parts.length === 0) return null;
  return (
    <span
      className="shrink-0 inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted"
      title={
        `Running on ${model ?? "the default model"}` +
        (effort ? ` at ${effort} reasoning effort` : "")
      }
    >
      {parts.join(" · ")}
    </span>
  );
}

/** First non-empty line of the brief, capped — "what they're working on". */
function deriveTitle(brief: string): string {
  const firstLine = brief.split(/\r?\n/).find((l) => l.trim()) ?? brief;
  const t = firstLine.trim().replace(/\s+/g, " ");
  return t.length <= 90 ? t : t.slice(0, 87) + "...";
}

export function ProjectAgents({
  slug,
  initialTickets,
  agents,
}: {
  slug: string;
  initialTickets: DispatchTicket[];
  agents: AgentMeta[];
}) {
  const agentMap = useMemo(() => {
    const m: Record<string, AgentMeta> = {};
    for (const a of agents) m[a.name] = a;
    return m;
  }, [agents]);

  const [tickets, setTickets] = useState<Record<string, DispatchTicket>>(() => {
    const m: Record<string, DispatchTicket> = {};
    for (const t of initialTickets) m[t.id] = t;
    return m;
  });
  // Latest-tickets ref so the self-heal effect can read current state without
  // re-subscribing on every change. Synced in an effect (never during render).
  const ticketsRef = useRef<Record<string, DispatchTicket>>(tickets);
  useEffect(() => {
    ticketsRef.current = tickets;
  });
  const [now, setNow] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  // Live dispatch lifecycle over the same SSE stream the chat uses. We filter to
  // this project; the stream carries every project's tickets.
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/dispatch/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        reconnectRef.current = setTimeout(connect, 3000);
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type !== "ticket" || !data.ticket) return;
          const t = data.ticket as DispatchTicket;
          if (t.project !== slug) return;
          setTickets((prev) => ({ ...prev, [t.id]: t }));
        } catch {
          /* ignore malformed frame */
        }
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      es?.close();
    };
  }, [slug]);

  // Tick every second so elapsed timers count up live.
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  // Self-heal stale cards. Terminal dispatch events (done/failed/cancelled) are
  // NOT replayed on SSE reconnect, so a missed one — a dropped stream, a deploy
  // restart, a crashed worker — can leave a "working" card that never clears, even
  // through a refresh. So we verify anything we're showing as running/queued against
  // the server: if it's actually terminal we update it (moves to Recently finished),
  // and if the server has no such ticket (404) we drop it. Runs on mount + every 15s.
  useEffect(() => {
    let alive = true;
    const verify = async () => {
      const openLocal = Object.values(ticketsRef.current).filter(
        (t) => t.status === "running" || t.status === "queued"
      );
      for (const t of openLocal) {
        try {
          const r = await fetch(`/api/dispatch/${t.id}`);
          if (!alive) return;
          if (r.status === 404) {
            setTickets((prev) => {
              if (!prev[t.id]) return prev;
              const next = { ...prev };
              delete next[t.id];
              return next;
            });
            continue;
          }
          const d = (await r.json()) as { ticket?: DispatchTicket };
          if (alive && d.ticket && d.ticket.status !== t.status) {
            const fresh = d.ticket;
            setTickets((prev) => ({ ...prev, [t.id]: fresh }));
          }
        } catch {
          /* transient; retry next tick */
        }
      }
    };
    verify();
    const iv = setInterval(verify, 15000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const { working, recent } = useMemo(() => {
    const all = Object.values(tickets).filter((t) => t.project === slug);
    const working = all
      .filter((t) => t.status === "running" || t.status === "queued")
      .sort((a, b) => {
        const rank = (t: DispatchTicket) => (t.status === "running" ? 0 : 1);
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        return (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt);
      });
    const recent = all
      .filter(
        (t) =>
          (t.status === "done" ||
            t.status === "failed" ||
            t.status === "cancelled") &&
          t.finishedAt !== null &&
          now - t.finishedAt < FINISHED_LINGER_MS
      )
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return { working, recent };
  }, [tickets, slug, now]);

  const nothing = working.length === 0 && recent.length === 0;

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-semibold tracking-tight">Agents at work</h2>
        <span
          className={
            "h-1.5 w-1.5 rounded-full ml-1 " +
            (connected ? "bg-emerald-500" : "bg-muted")
          }
          title={connected ? "Live" : "Reconnecting…"}
        />
        {working.length > 0 && (
          <span className="text-xs text-muted ml-auto">
            {working.length} active
          </span>
        )}
      </div>

      <QueuedDispatches slug={slug} agentMap={agentMap} />

      {nothing ? (
        <div className="rounded-lg border border-border bg-muted-bg px-4 py-10 text-center">
          <div className="text-sm text-foreground/70">
            No agents are working in this project right now.
          </div>
          <div className="text-xs text-muted mt-1">
            When you dispatch someone here, they&apos;ll show up live with what
            they&apos;re doing.
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {working.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted/80 font-semibold mb-2">
                Working now
              </div>
              <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
                {working.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    now={now}
                    meta={agentMap[t.agent]}
                  />
                ))}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted/80 font-semibold mb-2">
                Recently finished
              </div>
              <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
                {recent.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    now={now}
                    meta={agentMap[t.agent]}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

interface StatusView {
  dot: string;
  pulse: boolean;
  label: string;
  labelColor: string;
}

function statusView(status: DispatchTicket["status"]): StatusView {
  switch (status) {
    case "running":
      return { dot: "bg-emerald-500", pulse: true, label: "working", labelColor: "text-emerald-600 dark:text-emerald-400" };
    case "queued":
      return { dot: "bg-amber-500", pulse: false, label: "queued", labelColor: "text-amber-600 dark:text-amber-400" };
    case "done":
      return { dot: "bg-emerald-500", pulse: false, label: "done", labelColor: "text-muted" };
    case "failed":
      return { dot: "bg-rose-500", pulse: false, label: "failed", labelColor: "text-rose-500" };
    case "cancelled":
      return { dot: "bg-muted", pulse: false, label: "cancelled", labelColor: "text-muted" };
    default:
      return { dot: "bg-muted", pulse: false, label: status, labelColor: "text-muted" };
  }
}

function TicketRow({
  ticket,
  now,
  meta,
}: {
  ticket: DispatchTicket;
  now: number;
  meta: AgentMeta | undefined;
}) {
  const displayName = meta?.displayName ?? ticket.agent;
  const sv = statusView(ticket.status);
  const title = deriveTitle(ticket.brief);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<FeedEntry[] | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  let timing: string;
  if (ticket.status === "running") {
    timing = `working ${fmtElapsed(now - (ticket.startedAt ?? ticket.createdAt))}`;
  } else if (ticket.status === "queued") {
    timing = `queued ${fmtElapsed(now - ticket.createdAt)}`;
  } else if (ticket.finishedAt) {
    timing = timeAgo(ticket.finishedAt, now);
  } else {
    timing = "";
  }

  const outcome =
    ticket.status === "failed"
      ? ticket.errorMessage
      : ticket.status === "done"
        ? ticket.summary
        : null;

  // Live activity feed: fetch on expand; poll every 2s while the worker is running.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/dispatch/${ticket.id}/transcript`);
        const d = (await r.json()) as { entries?: FeedEntry[] };
        if (alive && Array.isArray(d.entries)) setEntries(d.entries);
      } catch {
        /* keep last-known */
      }
    };
    load();
    let poll: ReturnType<typeof setInterval> | null = null;
    if (ticket.status === "running") poll = setInterval(load, 2000);
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [open, ticket.id, ticket.status]);

  // Auto-follow: keep the newest activity in view while the worker is live.
  useEffect(() => {
    if (!open || ticket.status !== "running") return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, open, ticket.status]);

  return (
    <div className="bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2.5 px-3 py-3 text-left hover:bg-muted-bg/40"
        aria-expanded={open}
      >
        <span className="pt-1 shrink-0 text-muted">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="pt-0.5 shrink-0">
          <AgentAvatar
            name={displayName}
            color={meta?.color}
            imageUrl={meta?.avatarUrl}
            size={32}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-foreground/90">
              {displayName}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={
                  "h-1.5 w-1.5 rounded-full " +
                  sv.dot +
                  (sv.pulse ? " animate-pulse" : "")
                }
              />
              <span className={"text-[10px] uppercase tracking-wide font-medium " + sv.labelColor}>
                {sv.label}
              </span>
            </span>
            <SpawnBadge model={ticket.model} effort={ticket.effort} />
            <span className="text-[11px] text-muted ml-auto whitespace-nowrap">
              {timing}
            </span>
          </div>
          <div className="text-xs text-foreground/80 leading-snug mt-1">
            {title}
          </div>
          {outcome && (
            <div
              className={
                "text-[11px] leading-snug mt-1 " +
                (ticket.status === "failed" ? "text-rose-500/90" : "text-muted")
              }
            >
              {outcome.length <= 220 ? outcome : outcome.slice(0, 217) + "..."}
            </div>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border bg-muted-bg/40">
          {entries === null ? (
            <div className="text-xs text-muted px-3 py-2">Loading activity…</div>
          ) : entries.length === 0 ? (
            <div className="text-xs text-muted px-3 py-2">
              {ticket.status === "queued"
                ? "Waiting to start…"
                : "No activity recorded yet."}
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="max-h-96 overflow-y-auto px-3 py-2 space-y-2"
            >
              {entries.map((e) =>
                e.kind === "text" ? (
                  <NarrationText key={e.id} text={e.text} />
                ) : (
                  <FeedToolRow key={e.id} entry={e} />
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Devin's reasoning / narration — the "what I'm doing and why" between actions. */
function NarrationText({ text }: { text: string }) {
  return (
    <div className="text-xs text-foreground/85 leading-relaxed whitespace-pre-wrap">
      {text}
    </div>
  );
}

type ToolEntry = Extract<FeedEntry, { kind: "tool" }>;

/** Short one-liner for the tool header (the file, command, or pattern it acted on). */
function toolSummary(input: unknown): string {
  const inp =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const raw =
    inp.command ?? inp.file_path ?? inp.path ?? inp.notebook_path ?? inp.pattern ?? "";
  const s = typeof raw === "string" ? raw.split(/\r?\n/)[0] : "";
  return s.length <= 72 ? s : s.slice(0, 69) + "...";
}

function Pre({ text, className = "" }: { text: string; className?: string }) {
  return (
    <pre
      className={
        "whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/80 max-h-48 overflow-auto rounded bg-muted-bg/60 px-2 py-1.5 " +
        className
      }
    >
      {text}
    </pre>
  );
}

/** Renders the meaningful body of a tool call — actual code for edits, the command
 *  and output for Bash, JSON otherwise. */
function ToolBody({ entry }: { entry: ToolEntry }) {
  const inp =
    entry.input && typeof entry.input === "object"
      ? (entry.input as Record<string, unknown>)
      : {};
  const parts: ReactNode[] = [];

  if (entry.name === "Bash" && typeof inp.command === "string") {
    parts.push(<Pre key="cmd" text={"$ " + inp.command} />);
  } else if (entry.name === "Write" && typeof inp.content === "string") {
    if (typeof inp.file_path === "string")
      parts.push(
        <div key="fp" className="text-[10px] text-muted font-mono">
          {inp.file_path}
        </div>
      );
    parts.push(<Pre key="content" text={inp.content} />);
  } else if (
    (entry.name === "Edit" || entry.name === "MultiEdit") &&
    (typeof inp.old_string === "string" || typeof inp.new_string === "string")
  ) {
    if (typeof inp.file_path === "string")
      parts.push(
        <div key="fp" className="text-[10px] text-muted font-mono">
          {inp.file_path}
        </div>
      );
    if (typeof inp.old_string === "string")
      parts.push(
        <Pre key="old" text={"- " + inp.old_string} className="text-rose-500/80" />
      );
    if (typeof inp.new_string === "string")
      parts.push(
        <Pre
          key="new"
          text={"+ " + inp.new_string}
          className="text-emerald-600/80 dark:text-emerald-400/80"
        />
      );
  } else {
    parts.push(<Pre key="input" text={JSON.stringify(entry.input, null, 2)} />);
  }

  if (entry.result !== undefined) {
    parts.push(
      <div key="result">
        <div
          className={
            "text-[9px] uppercase tracking-wide mb-1 " +
            (entry.resultIsError ? "text-rose-500" : "text-muted")
          }
        >
          {entry.resultIsError ? "error" : "output"}
        </div>
        <Pre text={entry.result} />
      </div>
    );
  }

  return <div className="space-y-1.5">{parts}</div>;
}

/** One tool action in the feed. Work tools (edits, Bash) open by default so the
 *  code/commands scroll by; lookups (Read/Grep/…) stay collapsed to reduce noise. */
function FeedToolRow({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(WORK_TOOLS.has(entry.name));
  const summary = toolSummary(entry.input);
  const status: "ok" | "error" | "pending" =
    entry.result !== undefined ? (entry.resultIsError ? "error" : "ok") : "pending";
  const statusColor =
    status === "ok"
      ? "text-muted"
      : status === "error"
        ? "text-rose-500"
        : "text-muted/60";

  return (
    <div className="rounded border border-border/60 bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-muted-bg/40 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-muted" />
        <span className="font-semibold text-foreground/90 shrink-0">
          {entry.name}
        </span>
        {summary && (
          <span className="text-muted truncate">{summary}</span>
        )}
        <span className={"ml-auto shrink-0 " + statusColor}>
          {status === "pending" ? (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse inline-block" />
              running
            </span>
          ) : (
            status
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pl-7">
          <ToolBody entry={entry} />
        </div>
      )}
    </div>
  );
}
