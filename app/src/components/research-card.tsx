import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";
import { listDigests } from "@/lib/digests";
import { SectionHeader } from "./section-header";

function timeAgo(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export async function ResearchCard() {
  const digests = await listDigests();
  const latest = digests[0];

  return (
    <section>
      <SectionHeader icon={FileText} title="Indy's research" />

      {!latest ? (
        <div className="rounded-lg border border-border bg-card-bg p-4 text-xs text-muted">
          No digests yet. Indy runs Mon + Thu at 7am Phoenix.
        </div>
      ) : (
        <Link
          href={`/digests/${latest.date}`}
          className="block rounded-lg border border-border bg-card-bg p-4 shadow-lg shadow-black/30 hover:-translate-y-0.5 hover:border-border/80 transition-all"
        >
          <div className="flex items-center justify-between gap-3 mb-1">
            <h3 className="text-sm font-semibold tracking-tight truncate">
              {latest.title}
            </h3>
            <span className="text-[10px] uppercase tracking-wide text-muted font-mono shrink-0">
              {timeAgo(latest.date)}
            </span>
          </div>
          {latest.period && (
            <p className="text-[11px] text-muted mb-2">Period: {latest.period}</p>
          )}
          {latest.summary && (
            <p className="text-xs text-foreground/85 leading-relaxed line-clamp-3">
              {latest.summary}
            </p>
          )}
          <div className="flex items-center gap-1 mt-3 text-xs text-accent">
            <span>Read full brief</span>
            <ArrowRight className="h-3 w-3" />
          </div>
        </Link>
      )}

      {digests.length > 1 && (
        <Link
          href="/digests"
          className="block mt-2 text-[11px] text-muted hover:text-foreground/80"
        >
          {digests.length - 1} earlier digest{digests.length === 2 ? "" : "s"} →
        </Link>
      )}
    </section>
  );
}
