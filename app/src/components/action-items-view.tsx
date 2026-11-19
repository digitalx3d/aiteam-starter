"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Markdown } from "./markdown";
import { useOwner } from "./owner-context";
import type { ActionItem } from "@/lib/action-items";
import { ACTION_ITEMS_CHANGED_EVENT } from "./action-items-badge";

const POLL_MS = 30_000;
const BRIDGE = "aiTeam";
const DONE_WINDOW_DAYS = 14;

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;

function projectLabel(slug: string): string {
  return slug === BRIDGE ? "The Bridge (aiTeam)" : slug;
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dueLabel(due: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round(
    (new Date(`${due}T00:00:00`).getTime() - today.getTime()) / 86_400_000
  );
  if (days < 0) return { text: `${-days}d overdue`, overdue: true };
  if (days === 0) return { text: "due today", overdue: true };
  if (days === 1) return { text: "due tomorrow", overdue: false };
  return { text: `due ${shortDate(`${due}T12:00:00`)}`, overdue: false };
}

function ItemRow({
  item,
  onToggle,
  busy,
}: {
  item: ActionItem;
  onToggle: (item: ActionItem) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const done = item.status === "done";
  const due = dueLabel(item.due);
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={done}
          disabled={busy}
          onChange={() => onToggle(item)}
          aria-label={done ? `Reopen ${item.title}` : `Mark ${item.title} done`}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] cursor-pointer"
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={
              "text-left text-sm leading-snug hover:text-accent " +
              (done ? "line-through text-muted" : "")
            }
          >
            {item.title}
          </button>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap text-[11px] text-muted">
            {item.num !== null && <span className="font-mono">#{String(item.num).padStart(4, "0")}</span>}
            {item.status === "in-progress" && <span className="text-accent">in progress</span>}
            {item.status === "blocked" && <span className="text-error">blocked</span>}
            {item.priority === "high" && !done && (
              <span className="rounded border border-accent-2/60 bg-accent-2/10 px-1 text-accent-2">high</span>
            )}
            {due && !done && (
              <span className={due.overdue ? "text-error" : ""}>{due.text}</span>
            )}
            <span>{done ? `done ${shortDate(item.completed)}` : `added ${shortDate(item.created)}`}</span>
            {item.alsoIn.length > 0 && <span>also on {item.alsoIn.join(", ")}</span>}
          </div>
          {open && (
            <div className="mt-2 text-sm rounded border border-border bg-background/30 px-3 py-2">
              {item.description ? (
                <Markdown>{item.description}</Markdown>
              ) : (
                <p className="text-xs text-muted">No details on this one.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function ActionItemsView() {
  const owner = useOwner();
  const [items, setItems] = useState<ActionItem[] | null>(null);
  // When the list was last read; the "recently done" window is measured from it.
  const [readAt, setReadAt] = useState(0);
  const [projects, setProjects] = useState<string[]>([BRIDGE]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftProject, setDraftProject] = useState(BRIDGE);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/action-items${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: ActionItem[] };
      setItems(data.items);
      setReadAt(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await refresh();
      try {
        const res = await fetch("/api/projects", { cache: "no-store" });
        const data = (await res.json()) as { projects: { slug: string }[] };
        setProjects([BRIDGE, ...data.projects.map((p) => p.slug).sort((a, b) => a.localeCompare(b))]);
      } catch {
        /* the Bridge alone still works for quick adds */
      }
    };
    void run();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const announce = () => window.dispatchEvent(new Event(ACTION_ITEMS_CHANGED_EVENT));

  const toggle = async (item: ActionItem) => {
    const next = item.status === "done" ? "todo" : "done";
    setBusyId(item.id);
    // Optimistic: flip it now, then trust whatever the board says on re-read.
    setItems((list) =>
      list?.map((i) =>
        i.id === item.id && i.project === item.project
          ? { ...i, status: next, completed: next === "done" ? new Date().toISOString() : null }
          : i
      ) ?? null
    );
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(item.project)}/tasks/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(`Couldn't update "${item.title}": ${(err as Error).message}`);
    } finally {
      setBusyId(null);
      await refresh(true);
      announce();
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(draftProject)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, assignee: owner.first, status: "todo", priority: "medium" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft("");
      await refresh(true);
      announce();
    } catch (err) {
      setError(`Couldn't add it: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const { groups, recentDone, openCount } = useMemo(() => {
    const list = items ?? [];
    const open = list.filter((i) => i.status !== "done");
    const cutoff = readAt - DONE_WINDOW_DAYS * 86_400_000;
    const done = list
      .filter((i) => i.status === "done" && new Date(i.completed ?? i.updated).getTime() >= cutoff)
      .sort((a, b) => (b.completed ?? b.updated).localeCompare(a.completed ?? a.updated));
    const byProject = new Map<string, ActionItem[]>();
    for (const i of open) {
      const g = byProject.get(i.project) ?? [];
      g.push(i);
      byProject.set(i.project, g);
    }
    const grouped = [...byProject.entries()].map(([project, list]) => ({
      project,
      items: list.sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          b.created.localeCompare(a.created)
      ),
      newest: list.reduce((m, i) => (i.created > m ? i.created : m), ""),
    }));
    // Projects with the freshest asks float to the top.
    grouped.sort((a, b) => b.newest.localeCompare(a.newest));
    return { groups: grouped, recentDone: done, openCount: open.length };
  }, [items, readAt]);

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <h1 className="text-lg font-semibold tracking-tight">Action Items</h1>
        <p className="text-xs text-muted mt-0.5">
          Everything on any project board assigned to {owner.first}
          {items ? `: ${openCount} open` : ""}. Ticking one off here marks it done
          on that board too.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-4 max-w-4xl w-full [&>*]:shrink-0">
        <form onSubmit={add} className="flex flex-col sm:flex-row gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an action item…"
            className="flex-1 min-w-0 rounded-md border border-border bg-card-bg px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <select
              value={draftProject}
              onChange={(e) => setDraftProject(e.target.value)}
              aria-label="Project"
              className="flex-1 sm:flex-none sm:w-48 min-w-0 rounded-md border border-border bg-card-bg px-2 py-2 text-sm"
            >
              {projects.map((p) => (
                <option key={p} value={p}>
                  {projectLabel(p)}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={adding || !draft.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-accent text-accent-fg px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
        </form>

        {error && <p className="text-xs text-error">{error}</p>}
        {!items && !error && <p className="text-xs text-muted">Loading…</p>}
        {items && groups.length === 0 && (
          <p className="text-sm text-muted py-6 text-center">Nothing waiting on you.</p>
        )}

        {groups.map((g) => (
          <section key={g.project} className="rounded-lg border border-border bg-card-bg overflow-hidden">
            <header className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <h2 className="text-sm font-semibold">{projectLabel(g.project)}</h2>
              <span className="text-xs text-muted">({g.items.length})</span>
              <Link
                href={`/projects/${encodeURIComponent(g.project)}/tasks`}
                className="ml-auto text-[11px] text-muted hover:text-accent max-md:py-3 max-md:-my-3 max-md:px-2 max-md:-mr-2"
              >
                Open board
              </Link>
            </header>
            <ul className="divide-y divide-border">
              {g.items.map((i) => (
                <ItemRow key={`${i.project}:${i.id}`} item={i} onToggle={toggle} busy={busyId === i.id} />
              ))}
            </ul>
          </section>
        ))}

        {recentDone.length > 0 && (
          <section className="rounded-lg border border-border bg-card-bg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-background/30"
            >
              {showDone ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <span className="text-sm font-semibold">
                Done in the last {DONE_WINDOW_DAYS} days{" "}
                <span className="text-muted font-normal">({recentDone.length})</span>
              </span>
            </button>
            {showDone && (
              <ul className="divide-y divide-border border-t border-border">
                {recentDone.map((i) => (
                  <ItemRow key={`${i.project}:${i.id}`} item={i} onToggle={toggle} busy={busyId === i.id} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
