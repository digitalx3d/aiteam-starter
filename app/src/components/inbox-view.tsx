"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Inbox as InboxIcon,
  Check,
  CheckCheck,
  AlertTriangle,
  Filter,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Markdown } from "./markdown";
import { useOwner } from "./owner-context";
import type { InboxEntry, InboxPriority } from "@/lib/inbox-parse";

const READ_KEY = "aiteam.inbox.readIds";
const READ_CHANGED_EVENT = "aiteam-inbox-read-state-changed";

function loadReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveReadIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new Event(READ_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

type PriorityFilter = "all" | InboxPriority;
type AgentFilter = "any" | string;

const PRIORITY_BADGE: Record<InboxPriority, string> = {
  high: "bg-error/15 text-error border-error/30",
  medium: "bg-accent-2/10 text-accent-2 border-accent-2/30",
  low: "bg-muted-bg text-muted border-border",
};

// Canonical team roster from the inbox-shared.md header rules. Listed in the
// order the owner reads them. "all" is a broadcast marker, only valid for `to`.
const FROM_ROSTER = ["john", "cvb", "maya", "devin", "casey", "indy", "ethan"] as const;
const TO_ROSTER = ["john", "cvb", "maya", "devin", "casey", "indy", "ethan"] as const;

const DISPLAY_NAME: Record<string, string> = {
  cvb: "CVB",
  maya: "Maya",
  devin: "Devin",
  casey: "Casey",
  indy: "Indy",
  ethan: "Ethan",
  all: "All",
};

// The "john" slug renders as the configured owner's first name (via useOwner).
function makeDisplayName(ownerFirst: string) {
  return (slug: string): string =>
    slug === "john" ? ownerFirst : DISPLAY_NAME[slug] || slug;
}

export function InboxView() {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  // `loaded` gates the persist effect so it never runs with the pre-load
  // empty Set. Without this, on every fresh mount the persist effect would
  // fire before the load effect's setReadIds took effect and would wipe
  // localStorage with `[]` — a subtle bug that turned all read entries back
  // to unread after any hot-reload or Strict-Mode double-mount.
  const [loaded, setLoaded] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [fromFilter, setFromFilter] = useState<AgentFilter>("any");
  const [toFilter, setToFilter] = useState<AgentFilter>("any");

  // Load read state from localStorage on mount. `loaded` flips true after
  // the load lands so the persist effect can start running.
  useEffect(() => {
    setReadIds(loadReadIds());
    setLoaded(true);
  }, []);

  // Persist + broadcast whenever readIds actually changes. Doing this in an
  // effect (instead of inside the setReadIds updater) keeps the updater pure,
  // which is required because React may call updaters during render and the
  // broadcast triggers setState in a sibling component (InboxUnreadBadge).
  useEffect(() => {
    if (!loaded) return;
    saveReadIds(readIds);
  }, [readIds, loaded]);

  // Fetch entries on mount + on window focus (so a fresh post by an agent shows
  // up next time the owner tabs back).
  const fetchEntries = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      const data = (await res.json()) as { entries: InboxEntry[]; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      setError(null);
      setEntries(data.entries);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries();
    const onFocus = () => fetchEntries();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchEntries]);

  const markRead = useCallback((id: string) => {
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const markUnread = useCallback((id: string) => {
    setReadIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setReadIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const e of entries) {
        if (!next.has(e.id)) {
          next.add(e.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);

  const filtered = useMemo(() => {
    const fromKey = fromFilter.toLowerCase();
    const toKey = toFilter.toLowerCase();
    return entries.filter((e) => {
      if (priorityFilter !== "all" && e.priority !== priorityFilter) return false;
      if (fromKey !== "any" && e.from.toLowerCase() !== fromKey) return false;
      if (toKey !== "any") {
        // A broadcast (`to: all`) counts as addressed to everyone, so it
        // matches any specific recipient filter too.
        const recipients = e.to.map((s) => s.toLowerCase());
        if (!recipients.includes(toKey) && !recipients.includes("all")) {
          return false;
        }
      }
      return true;
    });
  }, [entries, priorityFilter, fromFilter, toFilter]);

  const unreadCount = useMemo(
    () => entries.filter((e) => !readIds.has(e.id)).length,
    [entries, readIds]
  );

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <InboxIcon className="h-5 w-5 text-accent" />
            Inbox
          </h1>
          <p className="text-xs text-muted mt-0.5 font-mono">
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}
            {" · "}
            <span className={unreadCount > 0 ? "text-accent" : ""}>
              {unreadCount} unread
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AgentSelect
            label="From"
            value={fromFilter}
            onChange={setFromFilter}
            options={FROM_ROSTER}
            highlighted={fromFilter !== "any"}
          />
          <AgentSelect
            label="To"
            value={toFilter}
            onChange={setToFilter}
            options={TO_ROSTER}
            highlighted={toFilter !== "any"}
          />
          <span className="text-muted text-xs px-1">
            <Filter className="h-3 w-3 inline" />
          </span>
          <FilterChip
            active={priorityFilter === "all"}
            onClick={() => setPriorityFilter("all")}
          >
            Any priority
          </FilterChip>
          <FilterChip
            active={priorityFilter === "high"}
            onClick={() => setPriorityFilter("high")}
            tone="error"
          >
            High
          </FilterChip>
          <FilterChip
            active={priorityFilter === "medium"}
            onClick={() => setPriorityFilter("medium")}
          >
            Medium
          </FilterChip>
          <FilterChip
            active={priorityFilter === "low"}
            onClick={() => setPriorityFilter("low")}
          >
            Low
          </FilterChip>
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadCount === 0}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/50 px-3 py-1 text-xs text-muted hover:text-foreground hover:border-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <CheckCheck className="h-3 w-3" />
            Mark all read
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 sm:px-6 py-12 text-sm text-muted text-center">Loading...</div>
        ) : error ? (
          <div className="m-6 rounded-md border border-error/40 bg-error-bg px-4 py-3 text-xs text-error flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Inbox failed to load</div>
              <div className="opacity-80 mt-0.5 font-mono">{error}</div>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 sm:px-6 py-12 text-sm text-muted text-center">
            {entries.length === 0
              ? "No entries in the shared inbox yet."
              : "No entries match the current filters."}
          </div>
        ) : (
          <div className="px-4 sm:px-6 py-4 space-y-3">
            {filtered.map((e) => (
              <EntryCard
                key={e.id}
                entry={e}
                isRead={readIds.has(e.id)}
                onMarkRead={() => markRead(e.id)}
                onMarkUnread={() => markUnread(e.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentSelect({
  label,
  value,
  onChange,
  options,
  highlighted,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  highlighted: boolean;
}) {
  const displayName = makeDisplayName(useOwner().first);
  return (
    <label
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors cursor-pointer ${
        highlighted
          ? "border-accent/50 bg-accent/10 text-accent"
          : "border-border bg-background/40 text-muted hover:text-foreground hover:border-foreground/30"
      }`}
    >
      <span className="opacity-70">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent border-0 outline-none text-[11px] font-medium pr-1 cursor-pointer focus:outline-none"
      >
        <option value="any">Any</option>
        {options.map((slug) => (
          <option key={slug} value={slug}>
            {displayName(slug)}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "error";
}) {
  const base =
    "rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40";
  const inactive =
    "border-border bg-background/40 text-muted hover:text-foreground hover:border-foreground/30";
  const activeCls =
    tone === "error"
      ? "border-error/50 bg-error/10 text-error"
      : "border-accent/50 bg-accent/10 text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${active ? activeCls : inactive}`}
    >
      {children}
    </button>
  );
}

function EntryCard({
  entry,
  isRead,
  onMarkRead,
  onMarkUnread,
}: {
  entry: InboxEntry;
  isRead: boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
}) {
  const displayName = makeDisplayName(useOwner().first);
  const priorityCls = PRIORITY_BADGE[entry.priority];
  // Default state mirrors read state: unread → expanded, read → collapsed.
  // User can still click the header to override at any time. Marking
  // read/unread snaps back to the matching default via the sync effect below.
  const [expanded, setExpanded] = useState(!isRead);
  const prevReadRef = useRef(isRead);

  // When isRead actually flips (mark read / mark unread), snap expanded to
  // match. Don't fire on initial mount or on unrelated re-renders.
  useEffect(() => {
    if (prevReadRef.current === isRead) return;
    prevReadRef.current = isRead;
    setExpanded(!isRead);
  }, [isRead]);

  return (
    <article
      className={`rounded-md border border-border bg-cards-bg overflow-hidden border-l-4 transition-colors ${
        isRead ? "border-l-transparent opacity-75" : "border-l-accent"
      }`}
    >
      <div
        className={`flex items-start gap-3 ${
          expanded ? "border-b border-border/60" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex-1 min-w-0 flex items-start gap-2 px-4 py-3 text-left hover:bg-background/30 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted shrink-0 mt-0.5" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border ${priorityCls}`}
              >
                {entry.priority}
              </span>
              <span className="text-xs font-semibold text-foreground/90">
                {entry.agent}
              </span>
              <span className="text-xs text-muted font-mono">{entry.timestamp}</span>
              {entry.to.length > 0 && (
                <span className="text-[10px] text-muted">
                  → {entry.to.map(displayName).join(", ")}
                </span>
              )}
            </div>
            <h2
              className={`text-sm mt-1 leading-snug ${
                isRead ? "text-foreground/75" : "font-semibold text-foreground"
              }`}
            >
              {entry.title}
            </h2>
          </div>
        </button>
        <button
          type="button"
          onClick={isRead ? onMarkUnread : onMarkRead}
          title={isRead ? "Mark as unread" : "Mark as read"}
          className="shrink-0 mt-3 mr-4 inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-0.5 text-[11px] text-muted hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          <Check className="h-3 w-3" />
          {isRead ? "Read" : "Mark read"}
        </button>
      </div>
      {expanded && (
        <div className="px-4 py-3 text-foreground/85">
          <Markdown>{entry.body}</Markdown>
        </div>
      )}
    </article>
  );
}
