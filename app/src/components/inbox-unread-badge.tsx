"use client";

import { useCallback, useEffect, useState } from "react";

const READ_KEY = "aiteam.inbox.readIds";
const READ_CHANGED_EVENT = "aiteam-inbox-read-state-changed";
const POLL_MS = 30_000;

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

interface InboxBadgeProps {
  /** When true (collapsed sidebar), shows a small dot in the corner of the icon
   *  instead of a count pill, so the badge still works in icon-only mode. */
  compact?: boolean;
}

/**
 * Sidebar badge showing the count of unread inbox entries.
 *
 * Sources of truth:
 *  - /api/inbox: list of entry ids (server-side, polled every 30s + on focus)
 *  - localStorage `aiteam.inbox.readIds`: which ids the owner has marked read
 *
 * When the inbox page mutates the read set, it dispatches a same-tab custom
 * event (storage events don't fire in the writing tab) so this badge updates
 * without waiting for the next poll. Cross-tab updates ride the `storage` event.
 */
export function InboxUnreadBadge({ compact = false }: InboxBadgeProps) {
  const [unread, setUnread] = useState(0);
  const [ids, setIds] = useState<string[]>([]);

  const fetchIds = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { entries: { id: string }[] };
      setIds(data.entries.map((e) => e.id));
    } catch {
      /* leave previous ids in place */
    }
  }, []);

  // Recompute unread whenever ids or stored read-set change.
  const recompute = useCallback(() => {
    const read = loadReadIds();
    setUnread(ids.reduce((acc, id) => (read.has(id) ? acc : acc + 1), 0));
  }, [ids]);

  useEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    fetchIds();
    const onFocus = () => fetchIds();
    const interval = window.setInterval(fetchIds, POLL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchIds]);

  useEffect(() => {
    const onChanged = () => recompute();
    window.addEventListener(READ_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onChanged);
    return () => {
      window.removeEventListener(READ_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onChanged);
    };
  }, [recompute]);

  if (unread <= 0) return null;
  if (compact) {
    return (
      <span
        aria-label={`${unread} unread inbox entries`}
        className="absolute top-1 right-1 h-2 w-2 rounded-full bg-accent"
      />
    );
  }
  return (
    <span
      aria-label={`${unread} unread inbox entries`}
      className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent text-accent-fg text-[10px] font-semibold leading-none"
    >
      {unread > 99 ? "99+" : unread}
    </span>
  );
}
