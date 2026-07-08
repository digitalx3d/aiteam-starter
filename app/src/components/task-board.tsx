"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  Plus,
  Trash2,
  Calendar,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  created: string;
  updated: string;
}

interface TaskBoardProps {
  slug: string;
  initialTasks: Task[];
  assigneeOptions: string[];
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_ORDER: TaskStatus[] = ["todo", "in-progress", "blocked", "done"];

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  low: "border-border text-muted",
  medium: "border-accent/40 text-accent",
  high: "border-accent-2/60 bg-accent-2/10 text-accent-2",
};

function formatRelativeDue(due: string | null): {
  label: string;
  tone: "muted" | "warn" | "soon" | "ok";
} | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${due}T00:00:00`);
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
  );
  if (diffDays < 0)
    return {
      label: `${Math.abs(diffDays)}d overdue`,
      tone: "warn",
    };
  if (diffDays === 0) return { label: "Today", tone: "soon" };
  if (diffDays === 1) return { label: "Tomorrow", tone: "soon" };
  if (diffDays <= 7) return { label: `${diffDays}d`, tone: "ok" };
  return { label: due.slice(5), tone: "muted" };
}

export function TaskBoard({
  slug,
  initialTasks,
  assigneeOptions,
}: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [filterAssignee, setFilterAssignee] = useState<string>("all");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (filterAssignee === "all") return tasks;
    if (filterAssignee === "__unassigned__")
      return tasks.filter((t) => !t.assignee);
    return tasks.filter((t) => t.assignee === filterAssignee);
  }, [tasks, filterAssignee]);

  const grouped = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = {
      todo: [],
      "in-progress": [],
      blocked: [],
      done: [],
    };
    for (const t of filtered) out[t.status].push(t);
    return out;
  }, [filtered]);

  const apiBase = `/api/projects/${encodeURIComponent(slug)}/tasks`;

  const createTask = useCallback(
    async (input: {
      title: string;
      description: string;
      assignee: string | null;
      priority: TaskPriority;
      due: string | null;
    }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(apiBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const { task } = (await res.json()) as { task: Task };
        setTasks((prev) => [task, ...prev]);
        setShowNew(false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [apiBase]
  );

  const updateTask = useCallback(
    async (id: string, patch: Partial<Task>) => {
      // Optimistic update
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
      );
      try {
        const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { task } = (await res.json()) as { task: Task };
        setTasks((prev) => prev.map((t) => (t.id === id ? task : t)));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [apiBase]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      const before = tasks;
      setTasks((prev) => prev.filter((t) => t.id !== id));
      try {
        const res = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        setError((e as Error).message);
        setTasks(before);
      }
    },
    [apiBase, tasks]
  );

  return (
    <div className="px-4 sm:px-6 py-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-xs text-muted">Assignee:</label>
          <select
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="all">Everyone</option>
            <option value="__unassigned__">Unassigned</option>
            {assigneeOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted ml-2">
            {filtered.length} {filtered.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New task</span>
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-error/40 bg-error-bg px-3 py-2 text-xs text-error flex items-start justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-error/70 hover:text-error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {showNew && (
        <NewTaskForm
          assigneeOptions={assigneeOptions}
          busy={busy}
          onCancel={() => setShowNew(false)}
          onCreate={createTask}
        />
      )}

      <div className="space-y-5">
        {STATUS_ORDER.map((status) => {
          const items = grouped[status];
          return (
            <section key={status}>
              <div className="text-xs uppercase tracking-wide text-muted mb-1.5 font-medium">
                {STATUS_LABELS[status]}{" "}
                <span className="text-muted/70 normal-case">({items.length})</span>
              </div>
              {items.length === 0 ? (
                <div className="text-xs text-muted/70 italic px-1 py-2">
                  No tasks.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {items.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      assigneeOptions={assigneeOptions}
                      expanded={expanded.has(t.id)}
                      onToggleExpand={() => toggleExpand(t.id)}
                      onUpdate={(patch) => updateTask(t.id, patch)}
                      onDelete={() => deleteTask(t.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function NewTaskForm({
  assigneeOptions,
  busy,
  onCancel,
  onCreate,
}: {
  assigneeOptions: string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    description: string;
    assignee: string | null;
    priority: TaskPriority;
    due: string | null;
  }) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string>("__none__");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [due, setDue] = useState<string>("");

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    onCreate({
      title: title.trim(),
      description: description.trim(),
      assignee: assignee === "__none__" ? null : assignee,
      priority,
      due: due || null,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-lg border border-border bg-cards-bg p-3 space-y-2"
    >
      <input
        type="text"
        autoFocus
        required
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
        className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <textarea
        rows={2}
        placeholder="Description (optional, markdown ok)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-muted">Assignee</label>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          disabled={busy}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="__none__">Unassigned</option>
          {assigneeOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label className="text-[11px] text-muted ml-2">Priority</label>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          disabled={busy}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <label className="text-[11px] text-muted ml-2">Due</label>
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          disabled={busy}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        />
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md border border-border text-muted hover:text-foreground hover:border-foreground/30"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="px-3 py-1.5 text-xs rounded-md bg-accent text-accent-fg font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </form>
  );
}

function TaskRow({
  task,
  assigneeOptions,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
}: {
  task: Task;
  assigneeOptions: string[];
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (patch: Partial<Task>) => void;
  onDelete: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description);
  const dueInfo = formatRelativeDue(task.due);
  const isDone = task.status === "done";

  function commitTitle() {
    setEditingTitle(false);
    const t = titleDraft.trim();
    if (t && t !== task.title) onUpdate({ title: t });
    else setTitleDraft(task.title);
  }

  function commitDescription() {
    setEditingDescription(false);
    if (descDraft !== task.description) onUpdate({ description: descDraft });
  }

  return (
    <li className="rounded-md border border-border bg-cards-bg">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="text-muted hover:text-foreground p-0.5"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitleDraft(task.title);
                setEditingTitle(false);
              }
            }}
            className="flex-1 rounded border border-accent/40 bg-background px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setTitleDraft(task.title);
              setEditingTitle(true);
            }}
            className={`flex-1 text-left text-sm hover:text-foreground/90 truncate ${
              isDone ? "line-through text-muted" : ""
            }`}
            title="Click to rename"
          >
            {task.title}
          </button>
        )}

        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[task.priority]}`}
        >
          {PRIORITY_LABELS[task.priority]}
        </span>

        {dueInfo && (
          <span
            className={`shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium ${
              dueInfo.tone === "warn"
                ? "text-error"
                : dueInfo.tone === "soon"
                ? "text-accent-2"
                : dueInfo.tone === "ok"
                ? "text-foreground/80"
                : "text-muted"
            }`}
          >
            <Calendar className="h-3 w-3" />
            {dueInfo.label}
          </span>
        )}

        {task.assignee && (
          <span className="shrink-0 inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            {task.assignee}
          </span>
        )}

        <select
          value={task.status}
          onChange={(e) => onUpdate({ status: e.target.value as TaskStatus })}
          className="h-7 rounded border border-border bg-background px-1.5 text-[11px]"
          aria-label="Status"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete "${task.title}"?`)) onDelete();
          }}
          className="text-muted hover:text-error p-1"
          title="Delete task"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] uppercase tracking-wide text-muted">
              Assignee
            </label>
            <select
              value={task.assignee ?? "__none__"}
              onChange={(e) =>
                onUpdate({
                  assignee:
                    e.target.value === "__none__" ? null : e.target.value,
                })
              }
              className="h-7 rounded border border-border bg-background px-2 text-[11px]"
            >
              <option value="__none__">Unassigned</option>
              {assigneeOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <label className="text-[10px] uppercase tracking-wide text-muted ml-2">
              Priority
            </label>
            <select
              value={task.priority}
              onChange={(e) =>
                onUpdate({ priority: e.target.value as TaskPriority })
              }
              className="h-7 rounded border border-border bg-background px-2 text-[11px]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>

            <label className="text-[10px] uppercase tracking-wide text-muted ml-2">
              Due
            </label>
            <input
              type="date"
              value={task.due ?? ""}
              onChange={(e) => onUpdate({ due: e.target.value || null })}
              className="h-7 rounded border border-border bg-background px-2 text-[11px]"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-muted">
              Description
            </label>
            {editingDescription ? (
              <textarea
                autoFocus
                rows={4}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={commitDescription}
                className="mt-1 w-full resize-none rounded-md border border-accent/40 bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDescDraft(task.description);
                  setEditingDescription(true);
                }}
                className="mt-1 w-full text-left text-xs whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2 py-1.5 hover:border-foreground/30 min-h-[2rem]"
              >
                {task.description || (
                  <span className="text-muted italic">
                    Click to add description...
                  </span>
                )}
              </button>
            )}
          </div>

          <div className="text-[10px] text-muted font-mono">
            id: {task.id} · created {task.created.slice(0, 10)} · updated{" "}
            {task.updated.slice(0, 10)}
          </div>
        </div>
      )}
    </li>
  );
}
