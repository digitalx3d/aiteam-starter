"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2 } from "lucide-react";
import { useServerConfig } from "@/lib/use-server-config";

type Mode = "new" | "existing";

export function NewProjectButton() {
  const router = useRouter();
  const cfg = useServerConfig();
  // e.g. "C:\Code\" — separator inferred from the configured path itself.
  const rootPrefix = cfg
    ? `${cfg.projectsRoot}${cfg.projectsRoot.includes("\\") ? "\\" : "/"}`
    : "";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Reset state and focus the name field when the modal opens.
  useEffect(() => {
    if (!open) return;
    setMode("new");
    setName("");
    setDescription("");
    setError(null);
    setSubmitting(false);
    queueMicrotask(() => nameInputRef.current?.focus());
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          name: trimmedName,
          description: description.trim(),
        }),
      });
      const data = (await res.json()) as
        | { ok: true; slug: string; path: string; aiteamPath: string }
        | { ok: false; error: string };

      if (!res.ok || !data.ok) {
        const msg = "error" in data ? data.error : `request failed (${res.status})`;
        setError(msg);
        setSubmitting(false);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 max-md:min-h-10 rounded-md border border-border bg-muted-bg/50 hover:bg-muted-bg text-xs font-medium text-foreground/90 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        New project
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md bg-cards-bg border border-border rounded-lg shadow-xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold tracking-tight">
                New project
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-muted-bg text-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              {/* Mode toggle */}
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                  Mode
                </label>
                <div className="flex gap-1 p-0.5 bg-muted-bg/50 rounded-md border border-border">
                  <button
                    type="button"
                    onClick={() => setMode("new")}
                    className={
                      "flex-1 text-xs py-1.5 px-2 rounded transition-colors " +
                      (mode === "new"
                        ? "bg-background text-foreground font-medium shadow-sm"
                        : "text-muted hover:text-foreground")
                    }
                  >
                    New folder
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("existing")}
                    className={
                      "flex-1 text-xs py-1.5 px-2 rounded transition-colors " +
                      (mode === "existing"
                        ? "bg-background text-foreground font-medium shadow-sm"
                        : "text-muted hover:text-foreground")
                    }
                  >
                    Existing folder
                  </button>
                </div>
                <p className="text-[10px] text-muted mt-1.5 leading-relaxed">
                  {mode === "new"
                    ? `Creates a new folder under ${rootPrefix || "the projects root"} and scaffolds .aiteam/ inside it.`
                    : `Adds .aiteam/ to an existing folder under ${rootPrefix || "the projects root"}. The folder must exist and not already have a .aiteam/.`}
                </p>
              </div>

              {/* Name */}
              <div>
                <label
                  htmlFor="new-project-name"
                  className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5"
                >
                  Name
                </label>
                <input
                  ref={nameInputRef}
                  id="new-project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. MyNewApp"
                  maxLength={64}
                  className="w-full text-sm bg-background border border-border rounded px-2.5 py-1.5 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <p className="text-[10px] text-muted mt-1 font-mono">
                  Will live at {rootPrefix}{trimmedName || "<name>"}
                </p>
              </div>

              {/* Description */}
              <div>
                <label
                  htmlFor="new-project-description"
                  className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5"
                >
                  Description
                </label>
                <textarea
                  id="new-project-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="One sentence about what this project is."
                  maxLength={280}
                  rows={2}
                  className="w-full text-sm bg-background border border-border rounded px-2.5 py-1.5 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                />
                <p className="text-[10px] text-muted mt-1">
                  Goes into project-context.md. {280 - description.length} characters left.
                </p>
              </div>

              {/* Scaffold preview */}
              <div className="text-[11px] text-muted bg-muted-bg/40 border border-border/60 rounded p-2 leading-relaxed">
                <div className="font-semibold text-foreground/70 mb-1">
                  Will create:
                </div>
                <div className="font-mono text-[10px] opacity-90">
                  .aiteam/project-context.md<br />
                  .aiteam/agents/{"{claude,maya,devin,casey,indy,ethan}"}.md<br />
                  .aiteam/tasks/
                </div>
              </div>

              {error && (
                <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-3 py-1.5 text-xs rounded border border-border bg-muted-bg/40 hover:bg-muted-bg text-foreground/80"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                  Create project
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
