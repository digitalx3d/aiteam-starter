"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Filter,
  PanelRightOpen,
  PanelRightClose,
  Hand,
  Wrench,
  Lightbulb,
  Compass,
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
} from "lucide-react";
import { AgentAvatar } from "@/components/agent-avatar";

type Kind =
  | "pickup"
  | "working"
  | "discovery"
  | "pivot"
  | "blocker"
  | "done"
  | "other";

interface NarrationEvent {
  type: "narration";
  ts: number;
  agent: string;
  kind: Kind;
  text: string;
  project?: string;
  /** Dispatch ticket id. Parallel workers of the same agent have different slots. */
  slot?: string;
  /** The slot's label (its brief's title), so the owner can tell parallel slots apart. */
  label?: string;
}

/** One row per agent, or per agent and slot when the post came from a dispatch. */
function slotKey(evt: NarrationEvent): string {
  return evt.slot ? `${evt.agent}/${evt.slot}` : evt.agent;
}

interface AgentMeta {
  name: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
}

const MAX_EVENTS = 500;
// An agent is shown in the "Now" section if their last narration is younger than this.
const NOW_FRESH_MS = 30 * 60 * 1000;

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

function KindIcon({ kind }: { kind: Kind }) {
  const cls = "h-3 w-3";
  switch (kind) {
    case "pickup":
      return <Hand className={cls} />;
    case "working":
      return <Wrench className={cls} />;
    case "discovery":
      return <Lightbulb className={cls} />;
    case "pivot":
      return <Compass className={cls} />;
    case "blocker":
      return <AlertTriangle className={cls} />;
    case "done":
      return <CheckCircle2 className={cls} />;
    default:
      return <MessageSquare className={cls} />;
  }
}

function kindColorClass(kind: Kind): string {
  switch (kind) {
    case "pickup":
      return "text-sky-500";
    case "working":
      return "text-muted";
    case "discovery":
      return "text-amber-500";
    case "pivot":
      return "text-violet-500";
    case "blocker":
      return "text-rose-500";
    case "done":
      return "text-emerald-500";
    default:
      return "text-muted";
  }
}

export function LiveFeed() {
  const [events, setEvents] = useState<NarrationEvent[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentMeta>>({});
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [filterOpen, setFilterOpen] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  // Load agent metadata once for color + avatar lookup.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data: { agents?: Array<Record<string, unknown>> }) => {
        if (cancelled || !Array.isArray(data.agents)) return;
        const map: Record<string, AgentMeta> = {};
        for (const a of data.agents) {
          if (typeof a.name === "string") {
            map[a.name] = {
              name: a.name,
              displayName: (a.displayName as string) ?? a.name,
              color: (a.color as string) ?? "blue",
              avatarUrl: (a.avatarUrl as string) ?? null,
            };
          }
        }
        setAgents(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Stream narration events.
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/live-feed/stream");
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
          if (data?.type !== "narration") return;
          const evt = data as NarrationEvent;
          setEvents((prev) => {
            const key = `${evt.ts}-${slotKey(evt)}-${evt.text}`;
            if (prev.some((e) => `${e.ts}-${slotKey(e)}-${e.text}` === key)) return prev;
            const next = [...prev, evt].sort((a, b) => b.ts - a.ts);
            return next.slice(0, MAX_EVENTS);
          });
        } catch {
          // ignore
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

  // Tick every 15s for relative timestamps.
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(i);
  }, []);

  const filterActive = agentFilter !== "all" || projectFilter !== "all";

  const filterOptions = useMemo(() => {
    const agentSet = new Set<string>();
    const projectSet = new Set<string>();
    for (const evt of events) {
      agentSet.add(evt.agent);
      if (evt.project) projectSet.add(evt.project);
    }
    return {
      agents: Array.from(agentSet).sort(),
      projects: Array.from(projectSet).sort(),
    };
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (!filterActive) return events;
    return events.filter(
      (e) =>
        (agentFilter === "all" || e.agent === agentFilter) &&
        (projectFilter === "all" || e.project === projectFilter)
    );
  }, [events, agentFilter, projectFilter, filterActive]);

  // Compute "currently working": the latest fresh event per agent, or per agent
  // and slot for dispatched work, so three parallel Indys show as three rows.
  const nowSection = useMemo(() => {
    const latest = new Map<string, NarrationEvent>();
    for (const evt of filteredEvents) {
      const key = slotKey(evt);
      const prior = latest.get(key);
      if (!prior || evt.ts > prior.ts) latest.set(key, evt);
    }
    const fresh: NarrationEvent[] = [];
    for (const evt of latest.values()) {
      if (evt.kind === "done") continue; // hide finished agents
      if (now - evt.ts > NOW_FRESH_MS) continue;
      fresh.push(evt);
    }
    fresh.sort((a, b) => b.ts - a.ts);
    return fresh;
  }, [filteredEvents, now]);

  if (!open) {
    return (
      <div className="border-l border-border bg-muted-bg flex flex-col items-center py-3 px-1.5 shrink-0 w-10">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Open live feed"
          className="p-1.5 rounded hover:bg-background/40 text-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <div className="mt-2 flex flex-col items-center gap-1">
          <Activity className="h-4 w-4 text-muted" />
          {nowSection.length > 0 && (
            <span
              className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"
              title={`${nowSection.length} agent${nowSection.length === 1 ? "" : "s"} working`}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <aside className="border-l border-border bg-muted-bg flex flex-col w-80 shrink-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Activity className="h-3.5 w-3.5 text-muted" />
        <span className="text-xs font-semibold tracking-tight">Live feed</span>
        <span
          className={
            "h-1.5 w-1.5 rounded-full ml-1 " +
            (connected ? "bg-emerald-500" : "bg-muted")
          }
          title={connected ? "Live" : "Reconnecting…"}
        />
        <span className="text-[10px] text-muted ml-auto">
          {events.length > 0 ? `${events.length} entries` : "watching…"}
        </span>
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          title="Filter feed"
          className={"p-1 rounded hover:bg-background/40 " + (filterActive ? "text-sky-500" : "text-muted hover:text-foreground")}
        >
          <Filter className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide"
          className="p-1 rounded hover:bg-background/40 text-muted hover:text-foreground"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {filterOpen && (
        <div className="border-b border-border bg-background/30 px-3 py-2 flex flex-col gap-1.5">
          <div className="flex gap-2">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="flex-1 min-w-0 text-[11px] bg-background border border-border rounded px-1.5 py-1 text-foreground"
            >
              <option value="all">All agents</option>
              {filterOptions.agents.map((a) => (
                <option key={a} value={a}>{agents[a]?.displayName ?? a}</option>
              ))}
            </select>
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="flex-1 min-w-0 text-[11px] bg-background border border-border rounded px-1.5 py-1 text-foreground"
            >
              <option value="all">All projects</option>
              {filterOptions.projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          {filterActive && (
            <button
              type="button"
              onClick={() => { setAgentFilter("all"); setProjectFilter("all"); }}
              className="text-[10px] text-muted hover:text-foreground text-left"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {nowSection.length > 0 && (
        <div className="border-b border-border bg-background/60">
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted/80 font-semibold">
            Working now
          </div>
          {nowSection.map((evt) => (
            <NowRow key={slotKey(evt)} evt={evt} now={now} agentMeta={agents[evt.agent]} />
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-background">
        {filteredEvents.length === 0 ? (
          <div className="px-3 py-8 text-xs text-muted text-center">
            {filterActive ? "No events match the current filters." : "No team activity yet."}
            {!filterActive && (
              <div className="mt-1 text-[10px] opacity-70">
                Wake an agent to see them think out loud.
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted/80 font-semibold">
              Recent
            </div>
            {filteredEvents.map((evt, i) => (
              <FeedRow
                key={`${evt.ts}-${slotKey(evt)}-${i}`}
                evt={evt}
                now={now}
                agentMeta={agents[evt.agent]}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function NowRow({
  evt,
  now,
  agentMeta,
}: {
  evt: NarrationEvent;
  now: number;
  agentMeta: AgentMeta | undefined;
}) {
  const displayName = agentMeta?.displayName ?? evt.agent;
  return (
    <div className="px-3 py-2 flex items-start gap-2.5">
      <AgentAvatar
        name={displayName}
        color={agentMeta?.color}
        imageUrl={agentMeta?.avatarUrl}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-foreground/90">
            {displayName}
          </span>
          <span className={"inline-flex items-center gap-1 " + kindColorClass(evt.kind)}>
            <KindIcon kind={evt.kind} />
            <span className="text-[9px] uppercase tracking-wider font-medium">
              {evt.kind}
            </span>
          </span>
          <span className="text-[10px] text-muted ml-auto whitespace-nowrap">
            {timeAgo(evt.ts, now)}
          </span>
        </div>
        {evt.label && (
          <div className="text-[10px] text-muted truncate" title={evt.label}>
            {evt.label}
          </div>
        )}
        <div className="text-xs text-foreground/85 leading-snug mt-0.5 whitespace-pre-line">
          {evt.project && (
            <span className="font-semibold text-foreground">{evt.project}: </span>
          )}
          {evt.text}
        </div>
      </div>
    </div>
  );
}

function FeedRow({
  evt,
  now,
  agentMeta,
}: {
  evt: NarrationEvent;
  now: number;
  agentMeta: AgentMeta | undefined;
}) {
  const displayName = agentMeta?.displayName ?? evt.agent;
  return (
    <div className="px-3 py-1.5 flex items-start gap-2 border-b border-border/40 last:border-b-0">
      <div className="pt-0.5 shrink-0">
        <AgentAvatar
          name={displayName}
          color={agentMeta?.color}
          imageUrl={agentMeta?.avatarUrl}
          size={20}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-foreground/85">
            {displayName}
          </span>
          <span className={"inline-flex items-center " + kindColorClass(evt.kind)}>
            <KindIcon kind={evt.kind} />
          </span>
          <span className="text-[10px] text-muted ml-auto whitespace-nowrap">
            {timeAgo(evt.ts, now)}
          </span>
        </div>
        {evt.label && (
          <div className="text-[10px] text-muted truncate" title={evt.label}>
            {evt.label}
          </div>
        )}
        <div className="text-[11px] text-foreground/75 leading-snug whitespace-pre-line">
          {evt.project && (
            <span className="font-semibold text-foreground/90">{evt.project}: </span>
          )}
          {evt.text}
        </div>
      </div>
    </div>
  );
}
