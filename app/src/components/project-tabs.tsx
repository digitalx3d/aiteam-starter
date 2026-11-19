"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, ListChecks, Users, StickyNote } from "lucide-react";

interface Tab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function ProjectTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/projects/${encodeURIComponent(slug)}`;
  const tabs: Tab[] = [
    { href: base, label: "Chat", icon: MessageSquare },
    { href: `${base}/tasks`, label: "Tasks", icon: ListChecks },
    { href: `${base}/agents`, label: "Agents", icon: Users },
    { href: `${base}/notes`, label: "Notes", icon: StickyNote },
  ];

  // Live count of agents actively working in THIS project — drives the green dot
  // on the Agents tab. Reads the same dispatch SSE the Agents board uses.
  const [activeCount, setActiveCount] = useState(0);
  const reconnectRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const active = new Set<string>();

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/dispatch/events");
      es.onerror = () => {
        es?.close();
        es = null;
        reconnectRef.current = setTimeout(connect, 5000);
      };
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type !== "ticket" || !data.ticket) return;
          const t = data.ticket as {
            id: string;
            project: string | null;
            status: string;
          };
          if (t.project !== slug) return;
          if (t.status === "running" || t.status === "queued") active.add(t.id);
          else active.delete(t.id);
          setActiveCount(active.size);
        } catch {
          /* ignore */
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

  return (
    <nav className="flex gap-0.5 -mb-px">
      {tabs.map((t) => {
        const isActive =
          t.href === base
            ? pathname === t.href || pathname === `${t.href}/`
            : pathname.startsWith(t.href);
        const Icon = t.icon;
        const showDot = t.label === "Agents" && activeCount > 0;
        return (
          <Link
            key={t.href}
            href={t.href}
            // Phones: the four tabs share the width evenly and stand 44px tall.
            className={`flex-1 sm:flex-none justify-center sm:justify-start min-h-11 sm:min-h-0 inline-flex items-center gap-1.5 px-2 sm:px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              isActive
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground/80 hover:border-border"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{t.label}</span>
            {showDot && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"
                title={`${activeCount} agent${activeCount === 1 ? "" : "s"} working`}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
