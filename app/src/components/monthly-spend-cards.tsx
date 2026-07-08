"use client";

import { useEffect, useState } from "react";
import { CircleDollarSign, Cpu, Wallet } from "lucide-react";
import { SectionHeader } from "./section-header";
import type { MonthlySpend } from "@/lib/monthly-spend";

/*
 * Monthly spend cards for The Bridge: cumulative token consumption and USD
 * value (at API list prices) for the current month, across every project and
 * session, with a per-model breakdown in smaller text. Data comes from
 * /api/spend/monthly (5-min server-side cache); fetched client-side so a cold
 * scan of the session logs never blocks the dashboard render.
 */

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function MonthlySpendCards() {
  const [data, setData] = useState<MonthlySpend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/spend/monthly")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: MonthlySpend) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null; // spend is a nice-to-have; never break the dashboard over it

  const title = data ? `Spend — ${data.monthLabel}` : "Spend — this month";

  return (
    <section>
      <SectionHeader icon={Wallet} title={title} iconClassName="text-accent-2" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SpendCard
          icon={<Cpu className="h-4 w-4 text-accent" />}
          heading="Tokens"
          headline={data ? fmtTokens(data.totalTokens) : null}
          rows={data?.byModel.map((m) => ({
            key: m.model,
            label: m.label,
            value: fmtTokens(m.totalTokens),
          }))}
        />
        <SpendCard
          icon={<CircleDollarSign className="h-4 w-4 text-emerald-500" />}
          heading="USD (at API rates)"
          headline={data ? fmtUsd(data.totalUsd) : null}
          rows={data?.byModel.map((m) => ({
            key: m.model,
            label: m.label,
            value: fmtUsd(m.usd),
          }))}
        />
      </div>
    </section>
  );
}

function SpendCard({
  icon,
  heading,
  headline,
  rows,
}: {
  icon: React.ReactNode;
  heading: string;
  /** null = still loading */
  headline: string | null;
  rows?: Array<{ key: string; label: string; value: string }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-card-bg p-4 shadow-lg shadow-black/30">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs font-semibold text-muted uppercase tracking-wide">
          {heading}
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
        {headline ?? <span className="text-muted animate-pulse">…</span>}
      </div>
      {rows && rows.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border/60 pt-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-baseline justify-between text-[11px] leading-snug"
            >
              <span className="text-muted truncate pr-2">{r.label}</span>
              <span className="text-foreground/80 font-mono tabular-nums shrink-0">
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
