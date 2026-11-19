"use client";

import { useCallback, useEffect, useState } from "react";

/** Same-tab signal so this count updates without waiting for its poll. */
export const ACTION_ITEMS_CHANGED_EVENT = "aiteam-action-items-changed";
const POLL_MS = 60_000;

/**
 * Sidebar count of the owner's open action items (owner-assigned tasks on any
 * board). Dot when the sidebar is collapsed, count pill when expanded, like
 * the inbox badge.
 */
export function ActionItemsBadge({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/action-items", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: { status: string }[] };
      setOpen(data.items.filter((i) => i.status !== "done").length);
    } catch {
      /* keep the previous count */
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await refresh();
    };
    void run();
    const onChange = () => void refresh();
    const interval = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", onChange);
    window.addEventListener(ACTION_ITEMS_CHANGED_EVENT, onChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onChange);
      window.removeEventListener(ACTION_ITEMS_CHANGED_EVENT, onChange);
    };
  }, [refresh]);

  if (open <= 0) return null;
  if (compact) {
    return (
      <span
        aria-label={`${open} open action items`}
        className="absolute top-1 right-1 h-2 w-2 rounded-full bg-accent"
      />
    );
  }
  return (
    <span
      aria-label={`${open} open action items`}
      className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent text-accent-fg text-[10px] font-semibold leading-none"
    >
      {open > 99 ? "99+" : open}
    </span>
  );
}
