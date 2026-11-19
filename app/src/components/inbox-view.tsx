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
import type { InboxEntry } from "@/lib/inbox-parse";

// Read state used to live here in localStorage, which made it per-browser: what
// read on a phone stayed unread on the desktop. It now lives on the
// server (~/.aiteam/inbox-state.json). This key is only read once, to carry the
// existing per-browser state up to the server, and is then removed.
const LEGACY_READ_KEY = "aiteam.inbox.readIds";
const READ_CHANGED_EVENT = "aiteam-inbox-read-state-changed";

/** Tell the sidebar badge to refresh; storage events do not fire in this tab. */
function broadcastReadChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(READ_CHANGED_EVENT));
}

/** Returns the server's full read list, or null if the write did not land. */
async function postRead(ids: string[], read: boolean): Promise<string[] | null> {
  try {
    const res = await fetch("/api/inbox/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, read }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { read?: unknown };
    return Array.isArray(data.read) ? data.read.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * "2026-08-15 5:30 PM" in the viewer's own timezone, matching the task board.
 *
 * A leading "~" means the entry never stated a time and this is when the
 * dashboard first saw it. Falls back to the raw header stamp when there is no
 * usable time at all.
 */
function formatPosted(entry: InboxEntry): string {
  // Some older headers lead with a "[HIGH]"-style tag; the priority already has
  // its own badge, so drop it from the stamp.
  const headerStamp = entry.timestamp.replace(/^\[[^\]]*\]\s*/, "");
  if (!entry.postedAt) return headerStamp;
  const d = new Date(entry.postedAt);
  if (Number.isNaN(d.getTime())) return headerStamp;
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return date + " " + (entry.postedAtApprox ? "~" : "") + time;
}

function postedTooltip(entry: InboxEntry): string {
  if (!entry.postedAt) {
    return "This entry states only a date, and it predates the posting-time stamping";
  }
  if (entry.postedAtApprox) {
    return "Approximate: the entry states only a date, so this is when the dashboard first saw it";
  }
  return "Posting time stated by the entry";
}

type AgentFilter = "any" | string;

/** Shown, and filtered on, for posts that name no project (digests, disk alerts). */
const NO_PROJECT = "General";

const DISPLAY_NAME: Record<string, string> = {
  cvb: "CVB",
  maya: "Maya",
  devin: "Devin",
  casey: "Casey",
  all: "Everyone",
  everyone: "Everyone",
  team: "Everyone",
};

// "owner", or the owner's own first name, renders as the configured owner's
// first name (via useOwner).
function makeDisplayName(ownerFirst: string) {
  return (slug: string): string => {
    const key = slug.toLowerCase();
    if (key === "owner" || key === ownerFirst.toLowerCase()) return ownerFirst;
    return DISPLAY_NAME[key] || slug.charAt(0).toUpperCase() + slug.slice(1);
  };
}

/** The "To:" line. A post that names no one reaches the Inbox only because it is for the owner. */
function recipientsLabel(to: string[], displayName: (slug: string) => string): string {
  if (to.length === 0) return displayName("owner");
  return [...new Set(to.map(displayName))].join(", ");
}

export function InboxView() {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [fromFilter, setFromFilter] = useState<AgentFilter>("any");
  const [projectFilter, setProjectFilter] = useState<AgentFilter>("any");

  // Entries AND read state both come from the server now, in one request.
  // Fetched on mount + on window focus, so a fresh post by an agent shows up
  // next time the owner tabs back. Returns the server read set so the caller can
  // run the one-time migration against it.
  const fetchEntries = useCallback(async (): Promise<Set<string> | undefined> => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      const data = (await res.json()) as {
        entries: InboxEntry[];
        read?: string[];
        error?: string;
      };
      if (data.error) {
        setError(data.error);
        return undefined;
      }
      setError(null);
      setEntries(data.entries);
      const serverRead = new Set(data.read ?? []);
      setReadIds(serverRead);
      return serverRead;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  // One-time carry-up of the old per-browser read state. Runs after the first
  // fetch so it can skip ids the server already knows, and clears the local key
  // only once the server has accepted them.
  const migrateLegacyReadIds = useCallback(async (serverRead: Set<string>) => {
    if (typeof window === "undefined") return;
    let legacy: string[] = [];
    try {
      const raw = window.localStorage.getItem(LEGACY_READ_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) legacy = parsed.map(String);
    } catch {
      window.localStorage.removeItem(LEGACY_READ_KEY);
      return;
    }
    const missing = legacy.filter((id) => id && !serverRead.has(id));
    if (missing.length === 0) {
      window.localStorage.removeItem(LEGACY_READ_KEY);
      return;
    }
    const merged = await postRead(missing, true);
    if (!merged) return; // leave the key in place and retry on the next load
    window.localStorage.removeItem(LEGACY_READ_KEY);
    setReadIds(new Set(merged));
    broadcastReadChange();
  }, []);

  useEffect(() => {
    let migrated = false;
    const run = async () => {
      const serverRead = await fetchEntries();
      if (serverRead && !migrated) {
        migrated = true;
        await migrateLegacyReadIds(serverRead);
      }
    };
    void run();
    const onFocus = () => {
      void fetchEntries();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchEntries, migrateLegacyReadIds]);

  // Optimistic: flip the UI immediately, then persist. If the write does not
  // land, re-read from the server rather than leaving the screen showing a
  // state the server never accepted.
  const applyRead = useCallback(
    async (ids: string[], read: boolean) => {
      if (ids.length === 0) return;
      setReadIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (read) next.add(id);
          else next.delete(id);
        }
        return next;
      });
      const serverRead = await postRead(ids, read);
      if (serverRead) setReadIds(new Set(serverRead));
      else await fetchEntries();
      broadcastReadChange();
    },
    [fetchEntries]
  );

  const markRead = useCallback(
    (id: string) => {
      void applyRead([id], true);
    },
    [applyRead]
  );

  const markUnread = useCallback(
    (id: string) => {
      void applyRead([id], false);
    },
    [applyRead]
  );

  const markAllRead = useCallback(() => {
    void applyRead(
      entries.filter((e) => !readIds.has(e.id)).map((e) => e.id),
      true
    );
  }, [applyRead, entries, readIds]);

  // Senders as their names appear on the cards, so the list never offers
  // someone with nothing in the Inbox.
  const senders = useMemo(
    () => [...new Set(entries.map((e) => e.agent))].sort((a, b) => a.localeCompare(b)),
    [entries]
  );

  const projects = useMemo(
    () =>
      [...new Set(entries.map((e) => e.project ?? NO_PROJECT))].sort((a, b) =>
        a === NO_PROJECT ? 1 : b === NO_PROJECT ? -1 : a.localeCompare(b)
      ),
    [entries]
  );

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (urgentOnly && e.priority !== "high") return false;
        if (fromFilter !== "any" && e.agent !== fromFilter) return false;
        if (projectFilter !== "any" && (e.project ?? NO_PROJECT) !== projectFilter) return false;
        return true;
      }),
    [entries, urgentOnly, fromFilter, projectFilter]
  );

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
          <span className="text-muted text-xs px-1">
            <Filter className="h-3 w-3 inline" />
          </span>
          <AgentSelect
            label="Project"
            value={projectFilter}
            onChange={setProjectFilter}
            options={projects}
            highlighted={projectFilter !== "any"}
          />
          <AgentSelect
            label="From"
            value={fromFilter}
            onChange={setFromFilter}
            options={senders}
            highlighted={fromFilter !== "any"}
          />
          <FilterChip
            active={urgentOnly}
            onClick={() => setUrgentOnly((v) => !v)}
            tone="error"
          >
            Urgent only
          </FilterChip>
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadCount === 0}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/50 px-3 py-1 max-md:min-h-9 text-xs text-muted hover:text-foreground hover:border-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
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
    "rounded-full border px-2.5 py-1 max-md:min-h-9 text-[11px] transition-colors disabled:opacity-40";
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
            <h2
              className={`text-sm leading-snug ${
                isRead ? "text-foreground/75" : "font-semibold text-foreground"
              }`}
            >
              {entry.priority === "high" && (
                <span className="mr-2 align-[1px] text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded border bg-error/15 text-error border-error/30">
                  Urgent
                </span>
              )}
              {entry.title}
            </h2>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
              <dt className="text-muted">Project:</dt>
              <dd>
                {entry.project ? (
                  <span className="font-semibold text-accent">{entry.project}</span>
                ) : (
                  <span className="text-muted">{NO_PROJECT}</span>
                )}
              </dd>
              <dt className="text-muted">From:</dt>
              <dd className="text-foreground/90 font-medium">{entry.agent}</dd>
              <dt className="text-muted">To:</dt>
              <dd className="text-foreground/80">{recipientsLabel(entry.to, displayName)}</dd>
              <dt className="text-muted">Date:</dt>
              <dd className="text-muted font-mono" title={postedTooltip(entry)}>
                {formatPosted(entry)}
              </dd>
            </dl>
          </div>
        </button>
        <button
          type="button"
          onClick={isRead ? onMarkUnread : onMarkRead}
          title={isRead ? "Mark as unread" : "Mark as read"}
          className="shrink-0 mt-3 mr-4 inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-0.5 max-md:min-h-9 max-md:px-3 text-[11px] text-muted hover:text-foreground hover:border-foreground/30 transition-colors"
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
