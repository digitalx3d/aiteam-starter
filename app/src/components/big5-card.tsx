"use client";

import {
  useCallback,
  useEffect,
  useRef,
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
import { SectionHeader } from "./section-header";

interface Big5Item {
  text: string;
  done: boolean;
}

interface CompletedItem {
  text: string;
  completedAt: string;
}

const SLOT_COUNT = 5;
const PLACEHOLDER = "(click to add a priority)";

function padToSlots(items: Big5Item[]): Big5Item[] {
  const padded = [...items];
  while (padded.length < SLOT_COUNT) padded.push({ text: "", done: false });
  return padded.slice(0, Math.max(SLOT_COUNT, padded.length));
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

export function Big5Card() {
  const [items, setItems] = useState<Big5Item[]>(padToSlots([]));
  const [completed, setCompleted] = useState<CompletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Version of big5.md this card is holding. Sent back on every write so a
  // stale tab can't overwrite an edit made elsewhere (see lib/big5.ts).
  const revisionRef = useRef<string | undefined>(undefined);
  const [staleNotice, setStaleNotice] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/big5", { cache: "no-store" });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        active: Big5Item[];
        completed: CompletedItem[];
        revision?: string;
      };
      setItems(padToSlots(data.active ?? []));
      setCompleted(data.completed ?? []);
      revisionRef.current = data.revision;
      return true;
    } catch {
      return false;
    }
  }, []);

  // Initial fetch, then again whenever the tab regains focus. The file is also
  // edited from the terminal and by agents, and a card left open for hours
  // would otherwise show (and save) a stale list.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await load();
      if (!cancelled) setLoading(false);
    };
    void run();
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (editingIndex !== null) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editingIndex]);

  const persist = useCallback(
    async (active: Big5Item[], completedNext: CompletedItem[]) => {
      try {
        const res = await fetch("/api/big5", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            active,
            completed: completedNext,
            revision: revisionRef.current,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          conflict?: boolean;
          active?: Big5Item[];
          completed?: CompletedItem[];
          revision?: string;
        };
        if (res.status === 409 && data.conflict) {
          // The file changed under us. Show what it actually says and say so,
          // rather than quietly winning and losing the other edit.
          setItems(padToSlots(data.active ?? []));
          setCompleted(data.completed ?? []);
          revisionRef.current = data.revision;
          setStaleNotice(true);
          return;
        }
        if (data.revision) revisionRef.current = data.revision;
        setStaleNotice(false);
      } catch {
        /* best effort */
      }
    },
    []
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

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
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

  /**
   * Clearing semantics:
   * - If the item is done, archive it to the completed log (with today's date).
   * - If the item is open (not done), discard — user decided not to do it.
   */
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
  const recentCompleted = completed.slice(0, 10);

  return (
    <section>
      <SectionHeader
        icon={Target}
        title="Big 5"
        iconClassName="text-accent-2"
        right={
          loading ? (
            <span className="text-[10px] text-muted/60 font-mono">loading...</span>
          ) : null
        }
      />
      <div className="rounded-lg border border-border bg-card-bg p-4 shadow-lg shadow-black/30">
        {staleNotice && (
          <div className="mb-3 rounded-md border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-xs text-foreground">
            This list changed somewhere else, so your last edit was not saved.
            What you see now is what the file says. Make the change again.
          </div>
        )}
        <ul className="space-y-1">
          {items.map((item, i) => {
            const isEditing = editingIndex === i;
            const isEmpty = !item.text.trim();
            return (
              <li
                key={i}
                className="group flex items-start gap-2 text-sm py-1"
              >
                <button
                  type="button"
                  onClick={() => !isEmpty && toggleDone(i)}
                  disabled={isEmpty}
                  className={
                    "mt-0.5 shrink-0 transition-colors max-md:p-3 max-md:-mx-3 max-md:-mb-3 max-md:-mt-2.5 " +
                    (isEmpty
                      ? "text-muted/30 cursor-default"
                      : item.done
                      ? "text-accent-2 hover:opacity-80"
                      : "text-muted hover:text-foreground")
                  }
                  title={item.done ? "Mark not done" : "Mark done"}
                >
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Circle className="h-4 w-4" />
                  )}
                </button>
                {isEditing ? (
                  <input
                    ref={inputRef}
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={commitEdit}
                    placeholder="What's on your mind?"
                    className="flex-1 bg-background border border-accent/50 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(i)}
                    className={
                      "flex-1 text-left leading-snug py-1 px-2 rounded -mx-2 hover:bg-background/40 transition-colors " +
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
                {!isEmpty && !isEditing && (
                  <button
                    type="button"
                    onClick={() => clearItem(i)}
                    title={
                      item.done
                        ? "Clear (archives to history)"
                        : "Clear (discard)"
                    }
                    className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 shrink-0 mt-1 p-0.5 max-md:p-2.5 max-md:-m-2 rounded text-muted hover:text-error hover:bg-background/40 transition-opacity"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {completed.length > 0 && (
          <div className="mt-2 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
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
              <span>
                Completed ({completed.length})
              </span>
            </button>
          </div>
        )}
        {historyOpen && completed.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/60">
            <ul className="space-y-1.5">
              {recentCompleted.map((c, i) => (
                <li
                  key={`${c.completedAt}-${i}`}
                  className="flex items-start gap-2 text-xs text-muted"
                >
                  <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-accent-2/70" />
                  <span className="leading-snug flex-1 line-through opacity-80">
                    {c.text}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] opacity-70">
                    {formatCompletedDate(c.completedAt, now)}
                  </span>
                </li>
              ))}
            </ul>
            {completed.length > recentCompleted.length && (
              <p className="mt-2 text-[10px] text-muted/60">
                +{completed.length - recentCompleted.length} older
                — see <code className="font-mono">aiTeam/big5.md</code>
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
