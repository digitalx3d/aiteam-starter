"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import type { ServerPort, ServerRow, ServersSnapshot } from "@/lib/servers";

const POLL_MS = 15_000;

const STATUS_DOT: Record<ServerRow["status"], string> = {
  up: "bg-emerald-500",
  down: "bg-error",
  conflict: "bg-accent-2",
  stopped: "bg-muted/50",
};

const STATUS_LABEL: Record<ServerRow["status"], string> = {
  up: "Up",
  down: "Down",
  conflict: "Port taken",
  stopped: "Not running",
};

function formatSince(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A link that actually opens from where the owner is sitting. On this PC,
 * localhost always works. From the phone (Tailscale), only servers bound to
 * every network address are reachable, at this machine's name.
 */
function openUrl(p: ServerPort): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (LOCAL_HOSTS.has(host)) return `http://localhost:${p.port}`;
  if (p.address === "0.0.0.0" || p.address === "[::]") return `http://${host}:${p.port}`;
  return null;
}

function PortChip({ p }: { p: ServerPort }) {
  const url = openUrl(p);
  const localOnly = p.address.startsWith("127.") || p.address === "[::1]";
  const body = (
    <>
      :{p.port}
      {url && <ExternalLink className="h-3 w-3" />}
    </>
  );
  const cls =
    "inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 max-md:min-h-9 max-md:px-2.5 font-mono text-[11px]";
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cls + " hover:border-accent hover:text-accent"}
      title={`Open ${url}`}
    >
      {body}
    </a>
  ) : (
    <span className={cls + " text-muted"} title={localOnly ? "Only reachable on this PC" : undefined}>
      {body}
    </span>
  );
}

function Row({ row }: { row: ServerRow }) {
  const since = formatSince(row.uptimeSince);
  const facts = [
    since && `up ${since}`,
    row.restarts !== null && row.restarts > 0 && `${row.restarts} restart${row.restarts === 1 ? "" : "s"}`,
    row.memoryMb !== null && `${row.memoryMb} MB`,
    row.pid !== null && `process ${row.pid}`,
  ].filter(Boolean) as string[];

  return (
    <li className="px-4 py-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span
          className={"h-2.5 w-2.5 rounded-full shrink-0 " + STATUS_DOT[row.status]}
          aria-label={STATUS_LABEL[row.status]}
          title={STATUS_LABEL[row.status]}
        />
        <span className="font-medium text-sm">{row.name}</span>
        {row.project && (
          <span className="text-[11px] rounded bg-muted-bg px-1.5 py-0.5 text-foreground/80">
            {row.project}
          </span>
        )}
        <span className="flex items-center gap-1.5 flex-wrap">
          {row.ports.map((p) => (
            <PortChip key={`${p.address}:${p.port}`} p={p} />
          ))}
          {row.ports.length === 0 && row.expectedPort !== null && (
            <span className="font-mono text-[11px] text-muted">:{row.expectedPort}</span>
          )}
        </span>
        {facts.length > 0 && (
          <span className="ml-auto text-[11px] text-muted">{facts.join(" · ")}</span>
        )}
      </div>
      {row.note && (
        <p
          className={
            "text-xs pl-5 " +
            (row.status === "down"
              ? "text-error"
              : row.status === "conflict"
              ? "text-accent-2"
              : "text-muted")
          }
        >
          {row.note}
        </p>
      )}
      {row.sharedWith.length > 0 && (
        <p className="text-[11px] text-muted pl-5">
          Same port is also set up in {row.sharedWith.join(", ")}.
        </p>
      )}
      {row.command && (
        <p className="text-[11px] text-muted/80 pl-5 font-mono truncate" title={row.command}>
          {row.command}
        </p>
      )}
    </li>
  );
}

function Section({
  title,
  hint,
  rows,
  empty,
}: {
  title: string;
  hint: string;
  rows: ServerRow[];
  empty: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-card-bg overflow-hidden">
      <header className="px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold">
          {title} <span className="text-muted font-normal">({rows.length})</span>
        </h2>
        <p className="text-[11px] text-muted mt-0.5">{hint}</p>
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <Row key={r.key} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ServersView() {
  const [snap, setSnap] = useState<ServersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showStopped, setShowStopped] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/servers", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnap((await res.json()) as ServersSnapshot);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await refresh();
    };
    void run();
    const interval = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const groups = useMemo(() => {
    const rows = snap?.rows ?? [];
    const byProject = (a: ServerRow, b: ServerRow) =>
      (a.project ?? "~").localeCompare(b.project ?? "~") ||
      (a.ports[0]?.port ?? a.expectedPort ?? 0) - (b.ports[0]?.port ?? b.expectedPort ?? 0);
    return {
      alwaysOn: rows
        .filter((r) => r.kind === "always-on")
        .sort((a, b) => Number(b.status === "down") - Number(a.status === "down") || a.name.localeCompare(b.name)),
      running: rows.filter((r) => r.kind === "dev" && r.status === "up").sort(byProject),
      conflicts: rows.filter((r) => r.status === "conflict").sort(byProject),
      stopped: rows.filter((r) => r.status === "stopped").sort(byProject),
    };
  }, [snap]);

  const checked = snap ? new Date(snap.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) : null;

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg flex items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Servers</h1>
          <p className="text-xs text-muted mt-0.5">
            Our local servers on this PC, rechecked every 15 seconds. Look-only.
            {checked && ` Last checked ${checked}.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto p-2 rounded text-muted hover:text-foreground hover:bg-background/40"
          aria-label="Check now"
          title="Check now"
        >
          <RefreshCw className={"h-4 w-4" + (loading ? " animate-spin" : "")} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-4 max-w-5xl w-full [&>*]:shrink-0">
        {error && (
          <p className="text-xs text-error">Couldn&apos;t check the servers: {error}</p>
        )}
        {snap?.pm2Error && (
          <p className="text-xs text-error">
            Couldn&apos;t read the always-on list from pm2 (the program that keeps
            them running): {snap.pm2Error}
          </p>
        )}
        {!snap && !error && <p className="text-xs text-muted">Checking…</p>}
        {snap && (
          <>
            <Section
              title="Always on"
              hint="Background services that should never be down. A red dot here also shows in the sidebar."
              rows={groups.alwaysOn}
              empty="No always-on services found."
            />
            <Section
              title="Running now"
              hint="Dev servers and tools that are up at the moment. These come and go as agents work, so none of this is a problem."
              rows={groups.running}
              empty="No dev servers running."
            />
            {groups.conflicts.length > 0 && (
              <Section
                title="Port already taken"
                hint="A project's server is set to a port that something else is using right now. It would fail to start until that frees up."
                rows={groups.conflicts}
                empty=""
              />
            )}
            <section className="rounded-lg border border-border bg-card-bg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowStopped((v) => !v)}
                className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-background/30"
              >
                {showStopped ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <span className="text-sm font-semibold">
                  Not running <span className="text-muted font-normal">({groups.stopped.length})</span>
                </span>
                <span className="text-[11px] text-muted ml-2 hidden sm:inline">
                  Ports projects are set up to use, currently idle. Normal.
                </span>
              </button>
              {showStopped && (
                <ul className="divide-y divide-border border-t border-border">
                  {groups.stopped.map((r) => (
                    <Row key={r.key} row={r} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
