"use client";

import { useEffect, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";

/*
 * "Waiting in line": jobs in the dispatch queue (`dispatch.mjs --after`) for
 * this project, shown on the Agents tab above the workers. A job here has a
 * ticket id but no worker yet; it starts by itself when the job it waits on
 * finishes successfully. Polls the queue API (cheap: one small file read) since
 * a queued job has no ticket events to stream.
 */

interface QueuedJob {
  id: string;
  after: string;
  afterAgent: string | null;
  agent: string;
  brief: string;
  state: "waiting" | "blocked" | "released" | "cancelled" | "held";
  reason: string | null;
  holdUntil?: number | null;
  createdAt: number;
}

interface AgentMeta {
  name: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
}

const POLL_MS = 10_000;

function firstLine(brief: string): string {
  const l = (brief.split(/\r?\n/).find((x) => x.trim()) ?? brief).trim().replace(/\s+/g, " ");
  return l.length <= 90 ? l : l.slice(0, 87) + "...";
}

function displayOf(agentMap: Record<string, AgentMeta>, name: string | null): string {
  if (!name) return "an earlier job";
  return agentMap[name]?.displayName ?? name;
}

export function QueuedDispatches({
  slug,
  agentMap,
}: {
  slug: string;
  agentMap: Record<string, AgentMeta>;
}) {
  const [jobs, setJobs] = useState<QueuedJob[]>([]);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/dispatch/queue?project=${encodeURIComponent(slug)}`);
        const d = (await r.json()) as { enabled?: boolean; jobs?: QueuedJob[] };
        if (!alive) return;
        if (Array.isArray(d.jobs)) setJobs(d.jobs);
        setEnabled(d.enabled !== false);
      } catch {
        /* keep last-known */
      }
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [slug]);

  if (jobs.length === 0) return null;

  return (
    <section className="mb-5">
      <div className="text-[10px] uppercase tracking-wider text-muted/80 font-semibold mb-2">
        Waiting in line
        {!enabled && (
          <span className="normal-case tracking-normal font-normal ml-2">
            (the queue is switched off, so these will not start)
          </span>
        )}
      </div>
      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
        {jobs.map((j) => {
          const meta = agentMap[j.agent];
          const failed = j.state === "blocked";
          return (
            <div key={j.id} className="bg-background flex items-start gap-2.5 px-3 py-3">
              <div className="pt-0.5 shrink-0 pl-6">
                <AgentAvatar
                  name={meta?.displayName ?? j.agent}
                  color={meta?.color}
                  imageUrl={meta?.avatarUrl}
                  size={32}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-foreground/90">
                    {meta?.displayName ?? j.agent}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className={"h-1.5 w-1.5 rounded-full " + (failed ? "bg-rose-500" : "bg-amber-500")} />
                    <span
                      className={
                        "text-[10px] uppercase tracking-wide font-medium " +
                        (failed ? "text-rose-500" : "text-amber-600 dark:text-amber-400")
                      }
                    >
                      {failed
                        ? "waiting on a failed job"
                        : j.state === "held"
                          ? `held for the usage limit${j.holdUntil ? ` until ${new Date(j.holdUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`
                          : `queued after ${displayOf(agentMap, j.afterAgent)} ${j.after.slice(0, 8)}`}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted ml-auto whitespace-nowrap font-mono">
                    {j.id.slice(0, 8)}
                  </span>
                </div>
                <div className="text-xs text-foreground/80 leading-snug mt-1">{firstLine(j.brief)}</div>
                {(failed || j.state === "held") && j.reason && (
                  <div className="text-[11px] leading-snug mt-1 text-rose-500/90">{j.reason}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
