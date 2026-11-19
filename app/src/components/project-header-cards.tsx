"use client";

import { useState } from "react";
import { ChevronDown, DollarSign, Target } from "lucide-react";
import { ProjectBig3Card } from "./project-big3-card";
import { ProjectCostCard } from "./project-cost-card";

type Panel = "spend" | "big3" | null;

/**
 * The Spend and Big 3 cards under a project's name.
 *
 * From 640px up this is the original row: both cards always open, side by side.
 * On a phone the two cards stacked took ~230px, a third of the screen, before
 * the conversation even started. There they collapse into two chips (total
 * spend, open Big 3 count) and a tap opens one card at a time below them.
 * Each card renders once either way; only visibility changes, so nothing is
 * fetched twice and the desktop markup is the same as before.
 */
export function ProjectHeaderCards({ slug }: { slug: string }) {
  const [open, setOpen] = useState<Panel>(null);
  const [spend, setSpend] = useState<string | null>(null);
  const [openIdeas, setOpenIdeas] = useState<number | null>(null);

  const toggle = (p: Exclude<Panel, null>) => setOpen((cur) => (cur === p ? null : p));

  const chip =
    "flex-1 min-w-0 min-h-10 inline-flex items-center gap-2 rounded-lg border px-3 text-xs transition-colors";
  const chipState = (p: Panel) =>
    open === p
      ? "border-accent/60 bg-accent/10 text-foreground"
      : "border-border bg-card-bg text-foreground/85";

  return (
    <>
      <div className="sm:hidden px-4 pb-2 flex gap-2">
        <button
          type="button"
          onClick={() => toggle("spend")}
          aria-expanded={open === "spend"}
          className={`${chip} ${chipState("spend")}`}
        >
          <DollarSign className="h-4 w-4 text-accent-2 shrink-0" />
          <span className="font-bold tracking-widest uppercase text-[10px] text-foreground/70">
            Spend
          </span>
          <span className="ml-auto font-bold tabular-nums">
            {spend ?? <span className="opacity-30">··</span>}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${
              open === "spend" ? "rotate-180" : ""
            }`}
          />
        </button>
        <button
          type="button"
          onClick={() => toggle("big3")}
          aria-expanded={open === "big3"}
          className={`${chip} ${chipState("big3")}`}
        >
          <Target className="h-4 w-4 text-accent-2 shrink-0" />
          <span className="font-bold tracking-widest uppercase text-[10px] text-foreground/70">
            Big 3
          </span>
          <span className="ml-auto tabular-nums text-muted">
            {openIdeas === null ? "" : openIdeas === 0 ? "empty" : `${openIdeas} open`}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${
              open === "big3" ? "rotate-180" : ""
            }`}
          />
        </button>
      </div>

      {/* Cards row: stacks on mobile, side-by-side on wider screens */}
      <div
        className={`px-4 sm:px-6 pb-2 flex-col sm:flex-row gap-2 ${
          open ? "flex" : "hidden"
        } sm:flex`}
      >
        <div className={`w-full sm:w-[200px] shrink-0 ${open === "spend" ? "" : "hidden"} sm:block`}>
          <ProjectCostCard slug={slug} onSummary={setSpend} />
        </div>
        <div className={`w-full sm:flex-1 ${open === "big3" ? "" : "hidden"} sm:block`}>
          <ProjectBig3Card slug={slug} onSummary={setOpenIdeas} />
        </div>
      </div>
    </>
  );
}
