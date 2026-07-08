"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DollarSign } from "lucide-react";
import { subscribe, getSnapshot, scopeKeyFor } from "@/lib/chat-store";

interface ProjectCost {
  total: number;
  chat: number;
  agents: number;
}

function fmtUsd(n: number): string {
  if (n < 0.01) return "$0.00";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(0)}`;
}

interface ProjectCostCardProps {
  slug: string;
}

export function ProjectCostCard({ slug }: ProjectCostCardProps) {
  const [cost, setCost] = useState<ProjectCost | null>(null);

  const fetchCost = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/cost`);
      if (!res.ok) return;
      const data = (await res.json()) as ProjectCost;
      setCost(data);
    } catch {
      /* ignore */
    }
  }, [slug]);

  // Initial fetch + refetch when slug changes.
  useEffect(() => {
    fetchCost();
  }, [fetchCost]);

  // Refetch whenever a chat turn completes in this project's scope. We watch
  // the chat-store's `busy` flag for this scope; a true→false transition means
  // the assistant just finished streaming, so the JSONL has new usage to read.
  // Small debounce delay lets Claude Code flush the final tokens to disk.
  const wasBusyRef = useRef<boolean>(false);
  useEffect(() => {
    const scopeKey = scopeKeyFor(slug);
    const check = () => {
      const busy = getSnapshot(scopeKey).busy;
      if (wasBusyRef.current && !busy) {
        // Transitioned from busy → idle: a turn just completed.
        setTimeout(fetchCost, 750);
      }
      wasBusyRef.current = busy;
    };
    // Seed the initial busy value so the first notification doesn't fire as a
    // spurious "transition" from undefined to whatever.
    wasBusyRef.current = getSnapshot(scopeKey).busy;
    return subscribe(scopeKey, check);
  }, [slug, fetchCost]);

  const total = cost?.total ?? 0;
  return (
    <div
      className="rounded-lg border border-border bg-card-bg px-3 py-2 shadow-md shadow-black/20 shrink-0 w-full"
      title={
        cost
          ? `CVB chat sessions: ${fmtUsd(cost.chat)} (Opus)\nDispatched agents: ${fmtUsd(cost.agents)} (Sonnet)\n\nIncludes everything in ~/.claude/projects/Z--GitHub-${slug}/ — both top-level chat sessions and subagent runs spawned via the Task tool. Computed from per-message token usage at official rates.`
          : "loading..."
      }
    >
      <div className="flex items-center gap-2">
        <DollarSign className="h-4 w-4 text-accent-2 shrink-0" />
        <span className="text-[11px] font-bold tracking-widest uppercase text-foreground/70 leading-none">
          Spend
        </span>
        <span className="ml-auto text-base font-bold tabular-nums text-foreground/90 leading-none">
          {cost ? fmtUsd(total) : "—"}
        </span>
      </div>
      {cost && (
        <div className="mt-1 flex gap-3 text-[10px] text-muted/70 font-mono justify-end">
          <span>chat {fmtUsd(cost.chat)}</span>
          <span>agents {fmtUsd(cost.agents)}</span>
        </div>
      )}
    </div>
  );
}
