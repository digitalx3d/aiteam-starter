"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { Markdown } from "./markdown";
import { ORIGIN_LABELS, type SkillInfo, type SkillOrigin } from "@/lib/skill-types";

/*
 * Skills browser: keyword search + origin filter chips over a card grid, with
 * a scrollable modal for the full SKILL.md (instead of expanding in the grid
 * and shoving every other card around).
 */

const ORIGIN_ORDER: SkillOrigin[] = ["team", "installed", "official", "plugin", "project"];

const ORIGIN_BADGE: Record<SkillOrigin, string> = {
  team: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  installed: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  official: "text-violet-400 border-violet-400/30 bg-violet-400/10",
  plugin: "text-violet-300 border-violet-300/30 bg-violet-300/10",
  project: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
};

function OriginBadge({ origin }: { origin: SkillOrigin }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${ORIGIN_BADGE[origin]}`}
    >
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

export function SkillsBrowser({ skills }: { skills: SkillInfo[] }) {
  const [query, setQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<SkillOrigin | "all">("all");
  const [selected, setSelected] = useState<SkillInfo | null>(null);

  const counts = useMemo(() => {
    const c = new Map<SkillOrigin, number>();
    for (const s of skills) c.set(s.origin, (c.get(s.origin) ?? 0) + 1);
    return c;
  }, [skills]);

  // One searchable lowercase haystack per skill, built once — not re-lowercased
  // on every keystroke (bodies can be tens of KB).
  const haystacks = useMemo(
    () =>
      skills.map((s) =>
        `${s.name} ${s.slug} ${s.description} ${s.plugin ?? ""} ${s.body}`.toLowerCase()
      ),
    [skills]
  );

  const filtered = useMemo(() => {
    // Space-separated keywords AND together: every term must appear somewhere
    // in the skill, so each extra word narrows the results. Terms of 1-2 chars
    // match whole words only ("ui" hits UI, not bUIld/gUIde); longer terms
    // keep substring matching ("imag" still finds "images").
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matchers = terms.map((t) => {
      if (t.length > 2) return (hay: string) => hay.includes(t);
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      return (hay: string) => re.test(hay);
    });
    return skills.filter((s, i) => {
      if (originFilter !== "all" && s.origin !== originFilter) return false;
      return matchers.every((m) => m(haystacks[i]));
    });
  }, [skills, haystacks, query, originFilter]);

  return (
    <div className="p-4 sm:p-6">
      {/* Search + origin filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <div className="relative sm:w-80">
          <Search className="h-3.5 w-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills — add words to narrow…"
            className="w-full text-sm bg-card-bg border border-border rounded-md pl-8 pr-8 py-1.5 text-foreground placeholder:text-muted/70 focus:outline-none focus:border-accent/60"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              title="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            active={originFilter === "all"}
            onClick={() => setOriginFilter("all")}
            label={`All (${skills.length})`}
          />
          {ORIGIN_ORDER.filter((o) => (counts.get(o) ?? 0) > 0).map((o) => (
            <FilterChip
              key={o}
              active={originFilter === o}
              onClick={() => setOriginFilter(originFilter === o ? "all" : o)}
              label={`${ORIGIN_LABELS[o]} (${counts.get(o)})`}
            />
          ))}
        </div>
      </div>

      {/* Card grid */}
      {filtered.length === 0 ? (
        <div className="py-12 text-sm text-muted text-center">
          No skills match{query ? ` “${query}”` : " the current filter"}.
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => (
            <button
              key={s.path}
              type="button"
              onClick={() => setSelected(s)}
              className="rounded-md border border-border bg-cards-bg px-4 py-3 text-left hover:bg-background/40 hover:border-border/70 transition-colors flex items-start gap-3"
            >
              <Sparkles className="h-4 w-4 text-accent shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground/95 truncate">
                    {s.name}
                  </span>
                  <OriginBadge origin={s.origin} />
                </div>
                <div className="text-[10px] font-mono text-muted mt-0.5 truncate">
                  {s.slug}
                </div>
                {s.description && (
                  <p className="text-xs text-muted mt-1 leading-relaxed line-clamp-3">
                    {s.description}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && <SkillModal skill={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-[11px] px-2 py-1 rounded-full border transition-colors " +
        (active
          ? "bg-accent/15 border-accent/50 text-foreground"
          : "bg-card-bg border-border text-muted hover:text-foreground hover:border-border/70")
      }
    >
      {label}
    </button>
  );
}

function SkillModal({ skill, onClose }: { skill: SkillInfo; onClose: () => void }) {
  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Skill: ${skill.name}`}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] rounded-lg border border-border bg-cards-bg shadow-2xl shadow-black/50 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-4 sm:px-5 py-3.5 border-b border-border shrink-0">
          <Sparkles className="h-4 w-4 text-accent shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold tracking-tight">
                {skill.name}
              </span>
              <span className="text-[10px] font-mono text-muted px-1.5 py-0.5 rounded bg-tool-bg border border-tool-border">
                {skill.slug}
              </span>
              <OriginBadge origin={skill.origin} />
            </div>
            <div className="text-[10px] font-mono text-muted/70 mt-1 truncate" title={skill.path}>
              {skill.path}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="p-1.5 rounded hover:bg-background/40 text-muted hover:text-foreground shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 sm:px-5 py-4">
          {skill.description && (
            <p className="text-sm text-foreground/80 leading-relaxed mb-4 pb-4 border-b border-border/60">
              {skill.description}
            </p>
          )}
          {skill.body ? (
            <Markdown>{skill.body}</Markdown>
          ) : (
            <p className="text-xs text-muted italic">
              SKILL.md has no body content beyond its frontmatter.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
