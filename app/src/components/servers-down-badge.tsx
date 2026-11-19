"use client";

import { useCallback, useEffect, useState } from "react";

const POLL_MS = 60_000;

/**
 * Red dot on the Servers sidebar item while any always-on service is down.
 * Red dot only, no phone push. Dev servers coming and
 * going never light it.
 */
export function ServersDownBadge({ compact = false }: { compact?: boolean }) {
  const [down, setDown] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/servers", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { downCount: number };
      setDown(data.downCount);
    } catch {
      /* keep the previous state */
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await refresh();
    };
    void run();
    const interval = window.setInterval(refresh, POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  if (down <= 0) return null;
  const label = `${down} always-on server${down === 1 ? "" : "s"} down`;
  return (
    <span
      aria-label={label}
      title={label}
      className={
        "h-2 w-2 rounded-full bg-error " + (compact ? "absolute top-1 right-1" : "ml-auto")
      }
    />
  );
}
