"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, TriangleAlert } from "lucide-react";
import { invalidateServerConfig } from "@/lib/use-server-config";

interface FieldInfo {
  key: string;
  label: string;
  description: string;
  envVar: string;
  kind: "dir" | "file" | "command";
  value: string;
  source: "settings" | "env" | "default";
  defaultValue: string;
  exists: boolean;
  /** The server never sends a secret's value, only whether one is saved. */
  secret: boolean;
  isSet: boolean;
  /** Read-only here; changed through the settings file or setup.mjs. */
  webLocked: boolean;
}

interface SettingsPayload {
  values: Record<string, string>;
  settingsFile: string;
  fields: FieldInfo[];
}

function draftFromFields(fields: FieldInfo[]): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const f of fields) {
    // Text in the box = a saved override. Empty box = inherited (env/default),
    // shown via the placeholder. A secret's box always starts empty.
    draft[f.key] = f.source === "settings" && !f.secret ? f.value : "";
  }
  return draft;
}

function SourceBadge({ field }: { field: FieldInfo }) {
  if (field.source === "settings") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">
        saved setting
      </span>
    );
  }
  if (field.source === "env") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-mono">
        env: {field.envVar}
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted-bg text-muted">
      default
    </span>
  );
}

export function SettingsForm() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((payload: SettingsPayload) => {
        if (!alive) return;
        setData(payload);
        setDraft(draftFromFields(payload.fields));
      })
      .catch((err) => {
        if (alive) setError(`Failed to load settings: ${(err as Error).message}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  function onChange(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty((s) => new Set(s).add(key));
    setJustSaved(false);
    setError(null);
  }

  function pendingValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const key of dirty) {
      const field = data?.fields.find((f) => f.key === key);
      if (field?.webLocked) continue;
      // An empty secret box means "leave it alone"; removing a saved key is
      // its own button, so a stray click-and-clear can't wipe it.
      if (field?.secret && !(draft[key] ?? "").trim()) continue;
      values[key] = draft[key] ?? "";
    }
    return values;
  }

  async function save(override?: Record<string, string>) {
    if (saving) return;
    const values = override ?? pendingValues();
    if (Object.keys(values).length === 0) {
      setDraft(data ? draftFromFields(data.fields) : {});
      setDirty(new Set());
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const payload = (await res.json()) as SettingsPayload & { error?: string };
      if (!res.ok) {
        setError(payload.error ?? `Save failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      setData(payload);
      setDraft(draftFromFields(payload.fields));
      setDirty(new Set());
      setJustSaved(true);
      invalidateServerConfig();
    } catch (err) {
      setError(`Save failed: ${(err as Error).message}`);
    }
    setSaving(false);
  }

  if (!data && !error) {
    return (
      <div className="flex items-center gap-2 px-6 py-12 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  return (
    <div className="max-w-3xl px-4 sm:px-6 py-4 sm:py-6 space-y-6">
      {data && (
        <>
          <div className="space-y-5">
            {data.fields.map((field) => {
              const isDirty = dirty.has(field.key);
              const placeholder = field.secret
                ? field.isSet
                  ? "A key is saved (hidden). Type a new one to replace it."
                  : "Not set"
                : field.value;
              return (
                <div key={field.key}>
                  <div className="flex items-center gap-2 mb-1">
                    <label
                      htmlFor={`setting-${field.key}`}
                      className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold"
                    >
                      {field.label}
                    </label>
                    <SourceBadge field={field} />
                    {!field.exists && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-rose-500">
                        <TriangleAlert className="h-3 w-3" />
                        path not found on disk
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted mb-1.5 leading-relaxed">
                    {field.description}
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      id={`setting-${field.key}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      value={field.webLocked ? field.value : (draft[field.key] ?? "")}
                      onChange={(e) => onChange(field.key, e.target.value)}
                      readOnly={field.webLocked}
                      aria-readonly={field.webLocked || undefined}
                      placeholder={placeholder}
                      spellCheck={false}
                      className={
                        "w-full text-sm font-mono bg-background border rounded px-2.5 py-1.5 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent " +
                        (field.webLocked ? "opacity-70 cursor-not-allowed " : "") +
                        (isDirty ? "border-accent/60" : "border-border")
                      }
                    />
                    {field.secret && field.isSet && field.source === "settings" && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Remove the saved ${field.label}?`)) {
                            void save({ [field.key]: "" });
                          }
                        }}
                        disabled={saving}
                        className="shrink-0 px-2.5 py-1.5 text-xs rounded border border-border text-muted hover:text-foreground hover:border-foreground/40 disabled:opacity-50"
                      >
                        Remove key
                      </button>
                    )}
                  </div>
                  {field.webLocked && (
                    <p className="text-[10px] text-muted mt-1">
                      Locked here, because it decides which program the app
                      runs. Change it in{" "}
                      <span className="font-mono">{data.settingsFile}</span> or
                      by re-running <span className="font-mono">setup.mjs</span>.
                    </p>
                  )}
                  {field.secret && field.isSet && field.source === "env" && (
                    <p className="text-[10px] text-muted mt-1">
                      Set by the <span className="font-mono">{field.envVar}</span>{" "}
                      environment variable. A key saved here takes precedence.
                    </p>
                  )}
                  {!field.secret && draft[field.key] === "" && field.source === "settings" && isDirty && (
                    <p className="text-[10px] text-muted mt-1">
                      Empty clears the saved value — reverts to{" "}
                      <span className="font-mono">{field.defaultValue}</span>
                      {" "}(or the env variable if set) on save.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-4 pt-2 border-t border-border">
            <p className="text-[11px] text-muted leading-relaxed">
              Saved to <span className="font-mono">{data.settingsFile}</span>.
              Saved values override environment variables and defaults. Changes
              apply to new requests immediately; live activity streams pick
              them up on reconnect.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              {justSaved && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  Saved
                </span>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={dirty.size === 0 || saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Save changes
              </button>
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/30 rounded p-2">
          {error}
        </div>
      )}
    </div>
  );
}
