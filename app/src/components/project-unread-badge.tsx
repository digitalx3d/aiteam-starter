"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  subscribe as storeSubscribe,
  getUnreadCount,
  scopeKeyFor,
} from "@/lib/chat-store";

export function ProjectUnreadBadge({ slug }: { slug: string }) {
  const scopeKey = scopeKeyFor(slug);
  const sub = useCallback(
    (cb: () => void) => storeSubscribe(scopeKey, cb),
    [scopeKey]
  );
  const getSnap = useCallback(() => getUnreadCount(scopeKey), [scopeKey]);
  const count = useSyncExternalStore(sub, getSnap, () => 0);
  if (count <= 0) return null;
  return (
    <span
      title={`${count} unread message${count === 1 ? "" : "s"}`}
      className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-orange-500 text-white text-[10px] font-semibold leading-none shrink-0"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
