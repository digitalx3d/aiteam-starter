"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ChevronRight,
  ChevronDown,
  Inbox,
  CheckCircle2,
  Megaphone,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";

interface ActivityEvent {
  type: "change";
  ts: number;
  path: string;
  rel: string;
  agent: string | null;
  kind: "shared-inbox" | "agent-inbox" | "agent-completed" | "other";
  preview?: string;
}

const MAX_EVENTS = 50;

function timeAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function eventLabel(evt: ActivityEvent): { title: string; subtitle: string } {
  switch (evt.kind) {
    case "shared-inbox":
      return {
        title: "Shared inbox updated",
        subtitle: "inbox-shared.md",
      };
    case "agent-inbox":
      return {
        title: `${evt.agent ?? "?"} inbox updated`,
        subtitle: evt.rel,
      };
    case "agent-completed":
      return {
        title: `${evt.agent ?? "?"} completed an item`,
        subtitle: evt.rel,
      };
    default:
      return { title: evt.rel, subtitle: "" };
  }
}

function EventIcon({ kind }: { kind: ActivityEvent["kind"] }) {
  if (kind === "shared-inbox") return <Megaphone className="h-3.5 w-3.5" />;
  if (kind === "agent-completed") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (kind === "agent-inbox") return <Inbox className="h-3.5 w-3.5" />;
  return <Activity className="h-3.5 w-3.5" />;
}

function EventRow({ evt, now }: { evt: ActivityEvent; now: number }) {
  const [open, setOpen] = useState(false);
  const { title, subtitle } = eventLabel(evt);
  const hasPreview = !!evt.preview && evt.preview.length > 0;

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => hasPreview && setOpen((v) => !v)}
        disabled={!hasPreview}
        className={
          "w-full text-left px-3 py-2 flex items-start gap-2 " +
          (hasPreview ? "hover:bg-background/40 cursor-pointer" : "cursor-default")
        }
      >
        <div className="mt-0.5 text-muted shrink-0">
          <EventIcon kind={evt.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground/90 truncate">
            {title}
          </div>
          <div className="text-[10px] text-muted truncate font-mono">
            {subtitle}
          </div>
        </div>
        <div className="text-[10px] text-muted shrink-0 pt-0.5 whitespace-nowrap">
          {timeAgo(evt.ts, now)}
        </div>
        {hasPreview && (
          <div className="text-muted shrink-0 pt-0.5">
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </div>
        )}
      </button>
      {open && hasPreview && (
        <pre className="px-3 pb-2 pl-9 text-[10px] font-mono whitespace-pre-wrap break-words text-foreground/75 max-h-48 overflow-auto bg-tool-bg/40">
          {evt.preview}
        </pre>
      )}
    </div>
  );
}

export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/activity/stream");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        // Reconnect after 3s
        reconnectRef.current = setTimeout(connect, 3000);
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as ActivityEvent | { type: string };
          if ((data as ActivityEvent).type === "change") {
            setEvents((prev) => {
              const next = [data as ActivityEvent, ...prev];
              return next.slice(0, MAX_EVENTS);
            });
          }
        } catch {
          // ignore unparseable
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      es?.close();
    };
  }, []);

  // Tick the relative timestamps every 30s
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(i);
  }, []);

  if (!open) {
    return (
      <div className="border-l border-border bg-muted-bg flex flex-col items-center py-3 px-1.5 shrink-0 w-10">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Open activity feed"
          className="p-1.5 rounded hover:bg-background/40 text-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <div className="mt-2 flex flex-col items-center gap-1">
          <Activity className="h-4 w-4 text-muted" />
          {events.length > 0 && (
            <span className="text-[10px] text-muted font-mono">{events.length}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <aside className="border-l border-border bg-muted-bg flex flex-col w-72 shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Activity className="h-3.5 w-3.5 text-muted" />
        <span className="text-xs font-semibold tracking-tight">Activity</span>
        <span
          className={
            "h-1.5 w-1.5 rounded-full ml-1 " +
            (connected ? "bg-green-500" : "bg-muted")
          }
          title={connected ? "Live" : "Reconnecting..."}
        />
        <span className="text-[10px] text-muted ml-auto">
          {events.length > 0 ? `${events.length} events` : "watching..."}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide"
          className="p-1 rounded hover:bg-background/40 text-muted hover:text-foreground"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto bg-background">
        {events.length === 0 ? (
          <div className="px-3 py-8 text-xs text-muted text-center">
            No team activity yet.
            <div className="mt-1 text-[10px] opacity-70">
              Watching inbox-shared.md and agents&#39; inboxes.
            </div>
          </div>
        ) : (
          events.map((evt, i) => (
            <EventRow key={`${evt.ts}-${evt.rel}-${i}`} evt={evt} now={now} />
          ))
        )}
      </div>
    </aside>
  );
}
