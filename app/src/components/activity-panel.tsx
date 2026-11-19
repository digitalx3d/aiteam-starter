"use client";

import { useEffect, useState } from "react";
import { ChevronUp, ChevronDown, ChevronRight, Wrench, X } from "lucide-react";
import type { ChatMessage, ContentBlock } from "@/lib/types";

type ToolCall = Extract<ContentBlock, { kind: "tool_use" }>;

function extractToolCalls(messages: ChatMessage[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.kind === "tool_use") calls.push(b);
    }
  }
  return calls;
}

// Only treat a tool_use as in-flight if it lives in an assistant turn that is
// still streaming. Stops orphan tool_uses from a crashed-mid-turn session
// rendering as "running" forever in the activity bar.
function findInFlightToolCall(messages: ChatMessage[]): ToolCall | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.pending) return null;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (b.kind === "tool_use" && b.result === undefined) return b;
    }
    return null;
  }
  return null;
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const inputStr =
    typeof call.input === "string" ? call.input : JSON.stringify(call.input, null, 2);

  let status: "ok" | "error" | "pending" = "pending";
  if (call.result !== undefined) status = call.resultIsError ? "error" : "ok";

  const statusColor =
    status === "ok" ? "text-muted" : status === "error" ? "text-error" : "text-muted/60";

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-mono hover:bg-background/50 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-muted" />
        <span className="font-semibold text-foreground/90 truncate">{call.name}</span>
        <span className={"ml-auto shrink-0 " + statusColor}>{status}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9 text-xs font-mono space-y-2">
          <div>
            <div className="text-muted text-[10px] uppercase tracking-wide mb-1">input</div>
            <pre className="whitespace-pre-wrap break-words text-foreground/80 max-h-48 overflow-auto">
              {inputStr || "{}"}
            </pre>
          </div>
          {call.result !== undefined && (
            <div>
              <div
                className={
                  "text-[10px] uppercase tracking-wide mb-1 " +
                  (call.resultIsError ? "text-error" : "text-muted")
                }
              >
                {call.resultIsError ? "error" : "result"}
              </div>
              <pre className="whitespace-pre-wrap break-words text-foreground/80 max-h-72 overflow-auto">
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Claude subscription usage (5-hour + weekly), from /api/usage ----

interface UsageWindow {
  pct: number;
  resetAt: number;
  status: string;
}
interface UsageData {
  ok: boolean;
  fiveHour?: UsageWindow;
  week?: UsageWindow;
}

/** "in 29 min" for near resets, "at 3:40pm" for later today, "Tue 11am" for future days. */
function fmtReset(ms: number): string {
  const now = Date.now();
  const diffMin = Math.round((ms - now) / 60000);
  if (diffMin <= 0) return "now";
  if (diffMin < 60) return `in ${diffMin} min`;
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const hr = d.getHours();
  const min = d.getMinutes();
  const ampm = hr < 12 ? "am" : "pm";
  const h12 = ((hr + 11) % 12) + 1;
  const time = min === 0 ? `${h12}${ampm}` : `${h12}:${String(min).padStart(2, "0")}${ampm}`;
  if (sameDay) return `at ${time}`;
  const wd = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${wd} ${time}`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-error";
  if (pct >= 75) return "text-amber-500";
  return "text-foreground/70";
}

function UsageInline() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch("/api/usage");
        const d = (await r.json()) as UsageData;
        if (alive) setUsage(d);
      } catch {
        /* leave last-known value */
      }
    };
    load();
    const id = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!usage?.ok || !usage.fiveHour) return null;
  const five = usage.fiveHour;
  const week = usage.week;
  return (
    <div className="ml-auto flex items-center gap-2 px-4 py-2 text-xs font-mono text-muted whitespace-nowrap">
      <span className="text-border">│</span>
      <span>
        <span className={pctColor(five.pct)}>{five.pct}% used</span>. Resets {fmtReset(five.resetAt)}.
      </span>
      {/* The weekly figure doesn't fit beside the five-hour one on a phone. */}
      {week && (
        <>
          <span className="hidden sm:inline text-border">|</span>
          <span className="hidden sm:inline">
            All models: <span className={pctColor(week.pct)}>{week.pct}% used</span>. Resets{" "}
            {fmtReset(week.resetAt)}.
          </span>
        </>
      )}
    </div>
  );
}

export function ActivityPanel({ messages }: { messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const calls = extractToolCalls(messages);
  const total = calls.length;
  const last = total > 0 ? calls[total - 1] : null;
  const pendingCall = findInFlightToolCall(messages);

  return (
    <div className="border-t border-border bg-muted-bg shrink-0">
      <div className="flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="min-w-0 min-h-10 sm:min-h-0 flex items-center gap-2 px-4 py-2 text-xs hover:bg-background/40 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted" />
        ) : (
          <ChevronUp className="h-3 w-3 text-muted" />
        )}
        <span className="font-medium text-foreground/80">Activity</span>
        <span className="text-muted">({total})</span>
        {!open && pendingCall && (
          <span className="text-muted truncate ml-2 flex items-center gap-1.5">
            · running:
            <span className="animate-pulse h-1.5 w-1.5 rounded-full bg-accent inline-block" />
            <span className="font-mono">{pendingCall.name}</span>
          </span>
        )}
        {!open && !pendingCall && last && (
          <span className="text-muted truncate ml-2">
            · last: <span className="font-mono">{last.name}</span>
          </span>
        )}
      </button>
        <UsageInline />
      </div>
      {open && (
        <div className="max-h-[40dvh] sm:max-h-72 overflow-y-auto border-t border-border bg-background">
          {total === 0 ? (
            <div className="px-4 py-6 text-xs text-muted text-center">
              No tool activity yet.
            </div>
          ) : (
            calls.map((c, i) => <ToolCallRow key={`${c.id}-${i}`} call={c} />)
          )}
        </div>
      )}
    </div>
  );
}
