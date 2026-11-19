"use client";

import { useCallback, useEffect, useState } from "react";

const READ_CHANGED_EVENT = "aiteam-inbox-read-state-changed";
const POLL_MS = 30_000;

interface InboxBadgeProps {
  /** When true (collapsed sidebar), shows a small dot in the corner of the icon
   *  instead of a count pill, so the badge still works in icon-only mode. */
  compact?: boolean;
}

/**
 * Sidebar badge showing the count of unread inbox entries.
 *
 * Both halves of the count now come from the same server response: /api/inbox
 * returns the entry ids and the ids the owner has read (~/.aiteam/inbox-state.json).
 * Read state used to live in this browser's localStorage, so the badge
 * disagreed with itself across devices.
 *
 * Polled every 30s + on focus. When the inbox page marks something read it
 * dispatches a same-tab custom event (storage events don't fire in the writing
 * tab) so the badge updates without waiting for the next poll.
 */
export function InboxUnreadBadge({ compact = false }: InboxBadgeProps) {
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        entries: { id: string }[];
        read?: string[];
      };
      const read = new Set(data.read ?? []);
      setUnread(data.entries.reduce((acc, e) => (read.has(e.id) ? acc : acc + 1), 0));
    } catch {
      /* leave the previous count in place */
    }
  }, []);

  useEffect(() => {
    // Wrapped rather than called directly so the initial load lands in a
    // callback, like every other refresh path here.
    const run = async () => {
      await refresh();
    };
    void run();
    const onFocus = () => {
      void refresh();
    };
    const interval = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const onChanged = () => {
      void refresh();
    };
    window.addEventListener(READ_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onChanged);
    return () => {
      window.removeEventListener(READ_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onChanged);
    };
  }, [refresh]);

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
