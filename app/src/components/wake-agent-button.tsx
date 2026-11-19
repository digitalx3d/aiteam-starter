"use client";

import { useCallback, useState, type MouseEvent } from "react";
import { Zap, Check, Loader2 } from "lucide-react";

// Waking an agent = dispatch them through the real courier (/api/dispatch) to work
// whatever is assigned to them. Runs out-of-band; the worker updates the task board
// and its report arrives as a bubble in the dashboard chat. No navigation, no chat
// prompt injection. (Previously this navigated to /dashboard?wake= and injected a
// prompt telling CVB to use the blocked Task tool — that path is gone.)
const WAKE_BRIEF =
  "Wake-up / heartbeat run. Scan your inbox and every active project's task board " +
  "(<project>/.aiteam/tasks/*.md) for work assigned to you with status 'todo'. Pick the " +
  "highest-priority one, do it, flip the task to in-progress then done (or blocked with a " +
  "reason), and end with a ===REPORT===. If nothing is queued for you, reply 'nothing " +
  "queued' and stop.";

export function WakeAgentButton({ agentName }: { agentName: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const onClick = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      // Stop the parent Link from also navigating to /team/<name>.
      e.preventDefault();
      e.stopPropagation();
      if (state === "sending") return;
      setState("sending");
      try {
        const res = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: agentName.toLowerCase(), brief: WAKE_BRIEF }),
        });
        setState(res.ok ? "sent" : "error");
      } catch {
        setState("error");
      }
      window.setTimeout(() => setState("idle"), 3000);
    },
    [agentName, state]
  );

  const label =
    state === "sending"
      ? "Waking…"
      : state === "sent"
        ? "Dispatched"
        : state === "error"
          ? "Failed"
          : "Wake";
  const Icon = state === "sending" ? Loader2 : state === "sent" ? Check : Zap;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "sending"}
      title={`Wake ${agentName} — dispatches ${agentName} to work their highest-priority assigned task; the report lands in the dashboard chat`}
      className="inline-flex items-center gap-1 rounded-full border border-accent-2/50 bg-accent-2/10 px-2 py-0.5 max-md:min-h-9 max-md:px-3 text-[11px] font-medium text-accent-2 hover:bg-accent-2/20 hover:border-accent-2 transition-colors disabled:opacity-60"
    >
      <Icon className={"h-3 w-3" + (state === "sending" ? " animate-spin" : "")} />
      <span>{label}</span>
    </button>
  );
}
