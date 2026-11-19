"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Folder, GitBranch, Package, Sparkles, Flag } from "lucide-react";
import { ProjectUnreadBadge } from "@/components/project-unread-badge";
import { HideProjectButton } from "@/components/hide-project-button";

export interface RowProject {
  slug: string;
  name: string;
  path: string;
  modifiedMs: number;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasClaude: boolean;
}

export interface RowSignals {
  agents: { running: string[]; recentFailures: number; recentDone: number };
  tasks: { total: number; done: number; blocked: number; inProgress: number };
  git: { branch: string | null; dirty: number } | null;
  needsYou: boolean;
}

interface RowStats {
  cost: { chat: number; agents: number; total: number };
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  timeMs: { you: number; agents: number };
  daily: Record<string, { cost: number; youMs: number; agentMs: number }>;
  since: string | null;
}

/**
 * Layout constants shared by the header and every row.
 *
 * Header and rows live in separate DOM subtrees, so identical widths, gap and
 * insets are the only thing keeping the columns lined up. HIDE_BTN_SPACER stands
 * in for the hide button, which is a sibling of each row's link and would
 * otherwise inset the rows 40px relative to the header.
 *
 * Everything is ONE line from 640px up. An earlier two-line version wrapped
 * inside the narrow tasks cell, which blew every row up to ~95px tall.
 *
 * Under 640px (phones) the columns don't fit beside the name at all: the agent,
 * cost and age cells alone are ~260px, which left the name zero width. There the
 * header is hidden, those cells drop out, and each row shows the name with a
 * small second line of agent state, cost and age (PhoneMeta) instead.
 */
const ROW_PAD = "px-4 sm:px-5";
const GAP = "gap-4";
const HIDE_BTN_SPACER = "w-10"; // must match HideProjectButton's width
const CELL = {
  agent: "w-28",
  tasks: "w-16",
  time: "w-14",
  cost: "w-20",
  git: "w-32",
  spark: "w-[76px]",
  icons: "w-[88px]",
  age: "w-16",
};

function timeAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Whole dollars once we're past pocket change — cents only add noise at $342. */
function fmtUsd(n: number): string {
  if (n <= 0) return "—";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push(
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(
        x.getDate()
      ).padStart(2, "0")}`
    );
  }
  return out;
}

/** Fixed-size slot so icons form straight vertical columns even when a project
 *  is missing one of them. */
function IconSlot({ children }: { children?: ReactNode }) {
  return (
    <span className="w-4 h-4 shrink-0 flex items-center justify-center">{children}</span>
  );
}

/**
 * The bar container IS the grid cell — it carries the width itself.
 *
 * Previously the width lived on an outer wrapper and this element had none;
 * inside a `justify-end` flex parent it collapsed to zero and the whole chart
 * silently disappeared while its column header stayed put.
 */
function Sparkline({ daily }: { daily: Record<string, { cost: number }> }) {
  const days = lastNDays(14);
  const vals = days.map((d) => daily[d]?.cost ?? 0);
  const max = Math.max(...vals);
  const total = vals.reduce((a, b) => a + b, 0);
  return (
    <span
      className={`hidden lg:flex ${CELL.spark} shrink-0 items-end gap-[2px] h-4`}
      title={
        max > 0
          ? `Daily spend over the last 14 days — ${fmtUsd(total)} total, busiest day ${fmtUsd(max)}`
          : "No spend in the last 14 days"
      }
    >
      {vals.map((v, i) => (
        <span
          key={days[i]}
          // Floor at a few percent so a quiet day still reads as a day, not a gap.
          style={{ height: `${max > 0 && v > 0 ? Math.max(14, (v / max) * 100) : 7}%` }}
          className={`flex-1 rounded-[1px] ${
            max > 0 && v > 0 ? "bg-accent-2/70" : "bg-muted/25"
          }`}
        />
      ))}
    </span>
  );
}

/**
 * Agent column. Three states, each a compact badge so the column reads as a
 * column: working (live, green), a failed run (amber), or idle (deliberately
 * dim — present so the column never looks broken, quiet enough to scan past).
 */
function AgentCell({ signals, inline = false }: { signals: RowSignals; inline?: boolean }) {
  const { running, recentFailures, recentDone } = signals.agents;
  // inline: the phone second line, where the cell sizes to its text instead of
  // holding a column width.
  const base = inline
    ? "min-w-0 flex items-center gap-1.5 text-[11px]"
    : `hidden sm:flex ${CELL.agent} shrink-0 items-center gap-1.5 text-[11px]`;

  if (running.length > 0) {
    const label = running.join(", ");
    return (
      <span
        className={`${base} text-emerald-600 dark:text-emerald-400`}
        title={`Working right now: ${label}`}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="truncate">{label}</span>
      </span>
    );
  }
  if (recentFailures > 0) {
    return (
      <span
        className={`${base} text-amber-600 dark:text-amber-400`}
        title={`${recentFailures} dispatched run${
          recentFailures === 1 ? "" : "s"
        } failed in the last 24 hours. Open the project to see why.`}
      >
        <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
        <span className="truncate">
          {recentFailures} failed
        </span>
      </span>
    );
  }
  return (
    <span
      className={`${base} text-muted/40`}
      title={
        recentDone > 0
          ? `No agent working now. ${recentDone} run${
              recentDone === 1 ? "" : "s"
            } finished in the last 24 hours.`
          : "No agent activity"
      }
    >
      <span className="h-2 w-2 rounded-full bg-muted/30 shrink-0" />
      <span className="truncate">idle</span>
    </span>
  );
}

function ProjectRow({
  project,
  signals,
  stats,
  loading,
}: {
  project: RowProject;
  signals: RowSignals;
  stats: RowStats | undefined;
  loading: boolean;
}) {
  const { tasks, git } = signals;
  const pending = loading && !stats;

  const tasksTitle =
    tasks.total > 0
      ? `${tasks.done} of ${tasks.total} tasks done` +
        (tasks.inProgress > 0 ? ` · ${tasks.inProgress} in progress` : "") +
        (tasks.blocked > 0 ? ` · ${tasks.blocked} blocked` : "")
      : "No tasks on this project's board";

  const hoursTitle = stats
    ? `Your engaged time: ${fmtDuration(stats.timeMs.you)}\n` +
      `Agent time: ${fmtDuration(stats.timeMs.agents)}\n\n` +
      "Pauses longer than 15 minutes count as time away, so this is a floor rather than a ceiling."
    : "Your engaged time on this project";

  const costTitle = stats
    ? `You: ${fmtUsd(stats.cost.chat)}\n` +
      `Dispatched agents: ${fmtUsd(stats.cost.agents)}\n\n` +
      `${fmtTokens(stats.tokens.input + stats.tokens.output)} tokens in and out, ` +
      `${fmtTokens(stats.tokens.cacheRead)} read from cache.\n` +
      `Running total since ${stats.since ?? "?"}, priced at each model's list rate.`
    : "Total spend on this project";

  const gitTitle = git
    ? `On branch ${git.branch ?? "unknown"}` +
      (git.dirty > 0
        ? ` · ${git.dirty} file${git.dirty === 1 ? "" : "s"} changed but not committed`
        : " · everything committed")
    : "Not a git repository";

  return (
    <div className="flex items-stretch border-b border-border/50 hover:bg-muted-bg/40 transition-colors group">
      <Link
        href={`/projects/${encodeURIComponent(project.slug)}`}
        className={`flex-1 min-w-0 ${ROW_PAD} py-3 sm:py-2.5 flex items-center ${GAP}`}
        title={project.path}
      >
        <span className="flex flex-col gap-1 sm:gap-0 min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">
            <Folder className="h-4 w-4 text-muted shrink-0" />
            <span className="text-sm font-medium text-foreground/90 truncate">
              {project.name}
            </span>
            <ProjectUnreadBadge slug={project.slug} />
          </span>
          {/* Phone second line: the three cells that are hidden below sm. */}
          <span className="sm:hidden flex items-center gap-2 min-w-0 pl-6 text-[11px] text-muted font-mono">
            <AgentCell signals={signals} inline />
            <span className="shrink-0 text-muted/50" aria-hidden>·</span>
            <span className="shrink-0 text-foreground/70" title={costTitle}>
              {pending ? <span className="opacity-30">··</span> : fmtUsd(stats?.cost.total ?? 0)}
            </span>
            <span className="shrink-0 text-muted/50" aria-hidden>·</span>
            <span className="shrink-0">{timeAgo(project.modifiedMs)}</span>
          </span>
        </span>

        <AgentCell signals={signals} />

        <span
          className={`hidden sm:block ${CELL.tasks} text-right shrink-0 text-xs font-mono ${
            tasks.blocked > 0 ? "text-amber-500" : "text-muted"
          }`}
          title={tasksTitle}
        >
          {tasks.total > 0 ? (
            `${tasks.done}/${tasks.total}`
          ) : (
            <span className="opacity-40">—</span>
          )}
        </span>

        <span
          className={`hidden sm:block ${CELL.time} text-right shrink-0 text-xs font-mono text-muted`}
          title={hoursTitle}
        >
          {pending ? <span className="opacity-30">··</span> : fmtDuration(stats?.timeMs.you ?? 0)}
        </span>

        <span
          className={`hidden sm:block ${CELL.cost} text-right shrink-0 text-xs font-mono text-foreground/70`}
          title={costTitle}
        >
          {pending ? <span className="opacity-30">··</span> : fmtUsd(stats?.cost.total ?? 0)}
        </span>

        {/* Branch truncates; the uncommitted count never does — it was getting
            swallowed by long branch names like "ios-revenuecat-integration". */}
        <span
          className={`hidden md:flex ${CELL.git} shrink-0 items-center justify-end gap-1 min-w-0 text-xs font-mono text-muted`}
          title={gitTitle}
        >
          {git ? (
            <>
              <span className="truncate">{git.branch ?? "?"}</span>
              {git.dirty > 0 && <span className="text-amber-500 shrink-0">+{git.dirty}</span>}
            </>
          ) : (
            <span className="opacity-40">—</span>
          )}
        </span>

        {stats ? (
          <Sparkline daily={stats.daily} />
        ) : (
          <span className={`hidden lg:block ${CELL.spark} shrink-0`} />
        )}

        <span
          className={`hidden md:flex ${CELL.icons} shrink-0 items-center justify-end gap-2 text-muted`}
        >
          <IconSlot>
            {signals.needsYou && (
              <span
                className="text-amber-500"
                title={
                  tasks.blocked > 0
                    ? `${tasks.blocked} blocked task${tasks.blocked === 1 ? "" : "s"} — needs you`
                    : "A dispatched run failed in the last 24 hours — needs you"
                }
              >
                <Flag className="h-3.5 w-3.5" />
              </span>
            )}
          </IconSlot>
          <IconSlot>
            {project.hasGit && (
              <span title="git repository">
                <GitBranch className="h-3.5 w-3.5" />
              </span>
            )}
          </IconSlot>
          <IconSlot>
            {project.hasPackageJson && (
              <span title="npm package">
                <Package className="h-3.5 w-3.5" />
              </span>
            )}
          </IconSlot>
          <IconSlot>
            {project.hasClaude && (
              <span title=".claude config" className="text-emerald-600 dark:text-emerald-400">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
            )}
          </IconSlot>
        </span>

        <span className={`hidden sm:block ${CELL.age} text-right shrink-0 text-xs text-muted font-mono`}>
          {timeAgo(project.modifiedMs)}
        </span>
      </Link>
      <HideProjectButton name={project.name} />
    </div>
  );
}

export function ProjectRows({
  projects,
  signals,
}: {
  projects: RowProject[];
  signals: Record<string, RowSignals>;
}) {
  const [stats, setStats] = useState<Record<string, RowStats> | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Separate fetch on purpose: the very first store build parses the whole
    // transcript archive and can take a minute. The rows are useful before it lands.
    fetch("/api/projects/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setStats(d.projects ?? {});
        setSince(d.since ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sinceLabel = since
    ? new Date(`${since}T12:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const emptySignals: RowSignals = {
    agents: { running: [], recentFailures: 0, recentDone: 0 },
    tasks: { total: 0, done: 0, blocked: 0, inProgress: 0 },
    git: null,
    needsYou: false,
  };

  return (
    <div>
      {/* Header. Mirrors a row exactly — same padding, gap, cell widths, plus a
          spacer standing in for the hide button — so labels sit over their values. */}
      <div className="hidden sm:flex items-stretch border-b border-border bg-cards-bg/60 sticky top-0 z-10">
        <div
          className={`flex-1 min-w-0 ${ROW_PAD} py-2 flex items-center ${GAP} text-[10px] font-mono uppercase tracking-wider text-muted/70`}
        >
          <span className="flex-1 min-w-0">Project</span>
          <span className={`${CELL.agent} shrink-0`} title="Which teammate is working on this right now">
            Agent
          </span>
          <span className={`hidden sm:block ${CELL.tasks} text-right shrink-0`}>Tasks</span>
          <span
            className={`hidden sm:block ${CELL.time} text-right shrink-0`}
            title="Your engaged time. Each row's tooltip also breaks out agent time."
          >
            Time
          </span>
          <span
            className={`${CELL.cost} text-right shrink-0`}
            title={
              sinceLabel
                ? `Total recorded spend since ${sinceLabel}, and growing. Claude Code deletes raw transcripts after 30 days, so these totals are stored separately to survive that.`
                : "Total recorded spend"
            }
          >
            Cost
          </span>
          <span className={`hidden md:block ${CELL.git} text-right shrink-0`}>Git</span>
          <span className={`hidden lg:block ${CELL.spark} text-right shrink-0`} title="Daily spend, last 14 days">
            14d
          </span>
          <span className={`hidden md:block ${CELL.icons} shrink-0`} aria-hidden />
          <span className={`${CELL.age} text-right shrink-0`}>Active</span>
        </div>
        <div className={`${HIDE_BTN_SPACER} shrink-0`} aria-hidden />
      </div>

      {projects.map((p) => (
        <ProjectRow
          key={p.slug}
          project={p}
          signals={signals[p.slug] ?? emptySignals}
          stats={stats?.[p.slug]}
          loading={loading}
        />
      ))}
    </div>
  );
}
