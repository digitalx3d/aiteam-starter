import Link from "next/link";
import { ChevronLeft, FileText } from "lucide-react";
import { listDigests } from "@/lib/digests";

export const dynamic = "force-dynamic";

export default async function DigestsListPage() {
  const digests = await listDigests();

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <div className="flex items-center gap-2 text-xs text-muted mb-2">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 hover:text-foreground/80"
          >
            <ChevronLeft className="h-3 w-3" />
            Dashboard
          </Link>
        </div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <FileText className="h-5 w-5 text-accent" />
          Research digests
        </h1>
        <p className="text-xs text-muted mt-1">
          {digests.length} digest{digests.length === 1 ? "" : "s"} archived at{" "}
          <code className="font-mono">vault/agents/indy/digests/</code>
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 max-w-4xl">
        {digests.length === 0 ? (
          <p className="text-sm text-muted">
            No digests yet. Any digest saved to that folder shows up here.
          </p>
        ) : (
          <ul className="space-y-3">
            {digests.map((d) => (
              <li key={d.date}>
                <Link
                  href={`/digests/${d.date}`}
                  className="block rounded-lg border border-border bg-card-bg p-4 hover:border-border/80 hover:-translate-y-0.5 transition-all"
                >
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <h2 className="text-sm font-semibold tracking-tight">
                      {d.title}
                    </h2>
                    <span className="text-[10px] uppercase tracking-wide text-muted font-mono shrink-0">
                      {d.date}
                    </span>
                  </div>
                  {d.period && (
                    <p className="text-[11px] text-muted mb-1">Period: {d.period}</p>
                  )}
                  {d.summary && (
                    <p className="text-xs text-foreground/85 leading-relaxed">
                      {d.summary}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
