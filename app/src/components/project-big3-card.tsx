"use client";

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  History,
  Target,
  X,
} from "lucide-react";

interface Big3Item {
  text: string;
  done: boolean;
}

interface CompletedItem {
  text: string;
  completedAt: string;
}

const SLOT_COUNT = 3;
const PLACEHOLDER = "(click to add an idea)";

function padToSlots(items: Big3Item[]): Big3Item[] {
  const padded = [...items];
  while (padded.length < SLOT_COUNT) padded.push({ text: "", done: false });
  return padded.slice(0, SLOT_COUNT);
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatCompletedDate(iso: string, now: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const itemDate = new Date(y, m - 1, d).getTime();
  const diffDays = Math.floor((now - itemDate) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return iso;
}

interface ProjectBig3CardProps {
  slug: string;
  /** Reports how many ideas are still open (null while loading). The phone
   *  header shows it on the collapsed Big 3 chip. */
  onSummary?: (openCount: number | null) => void;
}

export function ProjectBig3Card({ slug, onSummary }: ProjectBig3CardProps) {
  const [items, setItems] = useState<Big3Item[]>(padToSlots([]));
  const [completed, setCompleted] = useState<CompletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const endpoint = `/api/projects/${encodeURIComponent(slug)}/big3`;

  useEffect(() => {
    onSummary?.(loading ? null : items.filter((i) => i.text.trim() && !i.done).length);
  }, [items, loading, onSummary]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) return;
        const data = (await res.json()) as {
          active: Big3Item[];
          completed: CompletedItem[];
        };
        if (cancelled) return;
        setItems(padToSlots(data.active ?? []));
        setCompleted(data.completed ?? []);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const persist = useCallback(
    async (active: Big3Item[], completedNext: CompletedItem[]) => {
      try {
        await fetch(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active, completed: completedNext }),
        });
      } catch {
        /* best effort */
      }
    },
    [endpoint]
  );

  const startEdit = (i: number) => {
    setEditingIndex(i);
    setDraft(items[i]?.text ?? "");
  };

  const commitEdit = () => {
    if (editingIndex === null) return;
    const next = items.map((it, idx) =>
      idx === editingIndex ? { ...it, text: draft.trim() } : it
    );
    setItems(next);
    setEditingIndex(null);
    setDraft("");
    persist(next, completed);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const toggleDone = (i: number) => {
    const next = items.map((it, idx) =>
      idx === i ? { ...it, done: !it.done } : it
    );
    setItems(next);
    persist(next, completed);
  };

  const clearItem = (i: number) => {
    const item = items[i];
    if (!item || !item.text.trim()) return;
    const nextItems = items.map((it, idx) =>
      idx === i ? { text: "", done: false } : it
    );
    let nextCompleted = completed;
    if (item.done) {
      nextCompleted = [
        { text: item.text.trim(), completedAt: todayISO() },
        ...completed,
      ];
    }
    setItems(nextItems);
    setCompleted(nextCompleted);
    persist(nextItems, nextCompleted);
  };

  const now = Date.now();
  const recentCompleted = completed.slice(0, 5);

  // One Big-3 slot's interactive content (checkbox + text/edit). Shared by both
  // the desktop (horizontal strip) and mobile (vertical list) layouts. autoFocus
  // (rather than a shared ref) means the visible textarea focuses on edit even
  // though both layouts are present in the DOM at their respective breakpoints.
  const renderSlot = (item: Big3Item, i: number) => {
    const isEditing = editingIndex === i;
    const isEmpty = !item.text.trim();
    return (
      <>
        <button
          type="button"
          onClick={() => !isEmpty && toggleDone(i)}
          disabled={isEmpty}
          className={
            "mt-0.5 shrink-0 transition-colors " +
            (isEmpty
              ? "text-muted/30 cursor-default"
              : item.done
              ? "text-accent-2 hover:opacity-80"
              : "text-muted hover:text-foreground")
          }
          title={item.done ? "Mark not done" : "Mark done"}
        >
          {item.done ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <Circle className="h-3.5 w-3.5" />
          )}
        </button>
        {isEditing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
            onKeyDown={onKeyDown}
            onBlur={commitEdit}
            placeholder="Idea for this project"
            rows={1}
            className="flex-1 min-w-0 bg-background border border-accent/50 rounded px-1.5 py-0.5 text-xs leading-snug resize-none [field-sizing:content] break-words hyphens-auto focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        ) : (
          <button
            type="button"
            onClick={() => startEdit(i)}
            className={
              "flex-1 min-w-0 text-left leading-snug py-0.5 px-1.5 rounded -mx-1.5 hover:bg-background/40 transition-colors break-words hyphens-auto " +
              (isEmpty
                ? "text-muted/60 italic"
                : item.done
                ? "text-muted line-through"
                : "text-foreground/90")
            }
          >
            {isEmpty ? PLACEHOLDER : item.text}
          </button>
        )}
      </>
    );
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card-bg px-3 py-2 shadow-md shadow-black/20 shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Target className="h-4 w-4 text-accent-2 shrink-0" />
          <span className="font-semibold tracking-widest uppercase text-[10px]">
            Big 3
          </span>
          <span className="text-[10px] opacity-60 ml-1">loading...</span>
        </div>
      </div>
    );
  }

  const completedToggle = (
    <button
      type="button"
      onClick={() => setHistoryOpen((v) => !v)}
      className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-foreground"
      title={`${completed.length} completed item${
        completed.length === 1 ? "" : "s"
      }`}
    >
      {historyOpen ? (
        <ChevronDown className="h-3 w-3" />
      ) : (
        <ChevronRight className="h-3 w-3" />
      )}
      <History className="h-3 w-3" />
      <span>Completed ({completed.length})</span>
    </button>
  );

  const historyPanel = historyOpen && completed.length > 0 && (
    <div className="mt-2 pt-2 border-t border-border/60">
      <ul className="space-y-1">
        {recentCompleted.map((c, i) => (
          <li
            key={`${c.completedAt}-${i}`}
            className="flex items-start gap-1.5 text-[11px] text-muted"
          >
            <CheckCircle2 className="h-2.5 w-2.5 mt-1 shrink-0 text-accent-2/70" />
            <span className="leading-snug flex-1 min-w-0 line-through opacity-80 truncate">
              {c.text}
            </span>
            <span className="shrink-0 font-mono text-[9px] opacity-70">
              {formatCompletedDate(c.completedAt, now)}
            </span>
          </li>
        ))}
      </ul>
      {completed.length > recentCompleted.length && (
        <p className="mt-1.5 text-[10px] text-muted/60">
          +{completed.length - recentCompleted.length} older — see{" "}
          <code className="font-mono">.aiteam/big3.md</code>
        </p>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile / tablet (< lg): vertical list — readable on a phone */}
      <div className="lg:hidden rounded-lg border border-border bg-card-bg shadow-md shadow-black/20 w-full">
        <div className="flex items-center gap-2 px-3 pt-2 pb-1 border-b border-border/50">
          <Target className="h-4 w-4 text-accent-2 shrink-0" />
          <span className="text-[11px] font-bold tracking-widest uppercase text-foreground/70 leading-none">
            Big 3
          </span>
          {completed.length > 0 && <span className="ml-auto">{completedToggle}</span>}
        </div>
        <ul className="divide-y divide-border/40">
          {items.map((item, i) => (
            <li
              key={i}
              className="group relative flex items-start gap-1.5 text-xs py-1.5 px-3"
            >
              {renderSlot(item, i)}
              {item.text.trim() && editingIndex !== i && (
                <button
                  type="button"
                  onClick={() => clearItem(i)}
                  title={
                    item.done ? "Clear (archives to history)" : "Clear (discard)"
                  }
                  className="shrink-0 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 p-0.5 max-md:p-2.5 max-md:-m-2 rounded text-muted hover:text-error hover:bg-background/40 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {historyOpen && completed.length > 0 && (
          <div className="px-3 pb-2">{historyPanel}</div>
        )}
      </div>

      {/* Desktop (lg+): original horizontal "Big 3" strip — unchanged look */}
      <div className="hidden lg:block rounded-lg border border-border bg-card-bg px-3 py-[14px] shadow-md shadow-black/20 w-full h-[128px] shrink-0">
        <ul className="flex items-stretch h-full">
          <li className="shrink-0 pr-3 flex flex-col items-center justify-center gap-2.5">
            <Target className="h-5 w-5 text-accent-2 shrink-0" />
            <span className="text-[15px] font-bold tracking-widest uppercase text-foreground/70 leading-none [writing-mode:vertical-lr] rotate-180">
              Big 3
            </span>
          </li>
          {items.map((item, i) => (
            <li
              key={i}
              className="group relative flex items-start gap-1.5 text-xs py-0.5 flex-1 min-w-0 px-3 border-l border-border/60"
            >
              {renderSlot(item, i)}
              {item.text.trim() && editingIndex !== i && (
                <button
                  type="button"
                  onClick={() => clearItem(i)}
                  title={
                    item.done ? "Clear (archives to history)" : "Clear (discard)"
                  }
                  className="absolute left-3 top-5 opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-error hover:bg-background/40 transition-opacity"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {completed.length > 0 && (
          <div className="mt-1.5 flex items-center justify-end">{completedToggle}</div>
        )}
        {historyPanel}
      </div>
    </>
  );
}
