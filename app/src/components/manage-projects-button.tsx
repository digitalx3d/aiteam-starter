"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, X, Loader2, Folder } from "lucide-react";

interface HiddenProject {
  slug: string;
  name: string;
  path: string;
  hidden: boolean;
}

/**
 * Header control for managing project visibility. Lists every project with a
 * show/hide toggle — hidden ones grouped on top so "unhide" is the front-and-
 * center action. Toggles persist immediately (the app's auto-save idiom); the
 * underlying /projects list refreshes when the modal closes.
 */
export function ManageProjectsButton({
  initialHiddenCount,
}: {
  initialHiddenCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<HiddenProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(initialHiddenCount);

  // Load the full list (including hidden) each time the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/projects/hidden");
        if (!res.ok) return;
        const data = (await res.json()) as { projects: HiddenProject[] };
        if (cancelled) return;
        setProjects(data.projects ?? []);
        setHiddenCount((data.projects ?? []).filter((p) => p.hidden).length);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    if (dirty) {
      setDirty(false);
      router.refresh();
    }
  }

  async function toggle(p: HiddenProject) {
    if (busyName) return;
    const nextHidden = !p.hidden;
    setBusyName(p.name);
    // Optimistic local update.
    setProjects((prev) =>
      prev.map((x) => (x.name === p.name ? { ...x, hidden: nextHidden } : x))
    );
    try {
      const res = await fetch("/api/projects/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: p.name, hidden: nextHidden }),
      });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { hidden: string[] };
      setHiddenCount(data.hidden.length);
      setDirty(true);
    } catch {
      // Revert on failure.
      setProjects((prev) =>
        prev.map((x) => (x.name === p.name ? { ...x, hidden: p.hidden } : x))
      );
    } finally {
      setBusyName(null);
    }
  }

  const hidden = projects.filter((p) => p.hidden);
  const shown = projects.filter((p) => !p.hidden);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 max-md:min-h-10 rounded-md border border-border bg-muted-bg/50 hover:bg-muted-bg text-xs font-medium text-foreground/90 transition-colors"
        title="Hide or unhide projects"
      >
        <EyeOff className="h-3.5 w-3.5" />
        {hiddenCount > 0 ? `Hidden · ${hiddenCount}` : "Manage"}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="w-full max-w-md bg-cards-bg border border-border rounded-lg shadow-xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <h2 className="text-sm font-semibold tracking-tight">
                Manage projects
              </h2>
              <button
                type="button"
                onClick={close}
                className="p-1 rounded hover:bg-muted-bg text-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 py-3 overflow-y-auto">
              {loading ? (
                <div className="py-8 text-center text-xs text-muted">
                  <Loader2 className="h-4 w-4 animate-spin inline" />
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted mb-3 leading-relaxed">
                    Hidden projects are removed from this list and the dashboard
                    Top-4. Toggle the eye to show or hide.
                  </p>

                  {hidden.length > 0 && (
                    <div className="mb-4">
                      <div className="text-[10px] uppercase tracking-wider text-muted/70 font-semibold mb-1.5">
                        Hidden ({hidden.length})
                      </div>
                      <ul className="space-y-0.5">
                        {hidden.map((p) => (
                          <ProjectToggleRow
                            key={p.name}
                            project={p}
                            busy={busyName === p.name}
                            onToggle={() => toggle(p)}
                          />
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="text-[10px] uppercase tracking-wider text-muted/70 font-semibold mb-1.5">
                    Shown ({shown.length})
                  </div>
                  {shown.length === 0 ? (
                    <div className="text-xs text-muted italic py-2">
                      Everything is hidden.
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {shown.map((p) => (
                        <ProjectToggleRow
                          key={p.name}
                          project={p}
                          busy={busyName === p.name}
                          onToggle={() => toggle(p)}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end px-4 py-3 border-t border-border shrink-0">
              <button
                type="button"
                onClick={close}
                className="px-3 py-1.5 text-xs rounded bg-accent text-accent-foreground hover:opacity-90 font-medium"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectToggleRow({
  project,
  busy,
  onToggle,
}: {
  project: HiddenProject;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-2 py-1.5 px-1 rounded hover:bg-muted-bg/40">
      <Folder
        className={
          "h-3.5 w-3.5 shrink-0 " +
          (project.hidden ? "text-muted/50" : "text-muted")
        }
      />
      <span
        className={
          "text-sm flex-1 min-w-0 truncate " +
          (project.hidden ? "text-muted line-through" : "text-foreground/90")
        }
      >
        {project.name}
      </span>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        title={project.hidden ? "Show" : "Hide"}
        aria-label={project.hidden ? `Show ${project.name}` : `Hide ${project.name}`}
        className={
          "shrink-0 p-1 rounded transition-colors disabled:opacity-50 " +
          (project.hidden
            ? "text-muted hover:text-accent"
            : "text-muted hover:text-error")
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : project.hidden ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </button>
    </li>
  );
}
