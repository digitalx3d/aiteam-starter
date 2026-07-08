import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText, CalendarDays, Layers } from "lucide-react";
import { readDigest } from "@/lib/digests";
import { DigestRenderer } from "@/components/digest-renderer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ date: string }>;
}

export default async function DigestPage({ params }: PageProps) {
  const { date } = await params;
  const digest = await readDigest(date);
  if (!digest) notFound();

  return (
    <div className="flex flex-col h-full">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted mb-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 hover:text-foreground/80 transition-colors"
          >
            <ChevronLeft className="h-3 w-3" />
            Dashboard
          </Link>
          <span className="opacity-30">/</span>
          <Link
            href="/digests"
            className="hover:text-foreground/80 transition-colors"
          >
            Digests
          </Link>
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 p-2 rounded-lg bg-card-bg border border-border shrink-0">
            <FileText className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-foreground leading-snug">
              Indy&apos;s Digest
            </h1>
            <p className="text-sm text-muted mt-0.5">
              {new Intl.DateTimeFormat("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
                timeZone: "UTC",
              }).format(new Date(digest.date + "T00:00:00Z"))}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2">
              {digest.period && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                  <CalendarDays className="h-3 w-3" />
                  {digest.period}
                </span>
              )}
              {digest.sources && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                  <Layers className="h-3 w-3" />
                  {digest.sources}
                </span>
              )}
            </div>
            {digest.summary && (
              <p className="mt-2 text-xs text-foreground/70 leading-relaxed max-w-2xl">
                {digest.summary}
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-border/40">
          <span className="font-mono text-[10px] opacity-40">
            vault/agents/indy/digests/{date}.md
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Body                                                                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
          <DigestRenderer>{digest.body}</DigestRenderer>
        </div>
      </div>
    </div>
  );
}
