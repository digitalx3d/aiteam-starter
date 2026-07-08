import path from "node:path";
import { promises as fsp } from "node:fs";
import { costForUsage, type UsageBlock } from "./project-costs";
import { getConfig } from "./config";

/*
 * monthly-spend.ts — cumulative token + USD spend for the current calendar
 * month, across EVERY Claude Code session on this machine (all projects,
 * dashboard chats, dispatched workers, terminal sessions).
 *
 * Source of truth: ~/.claude/projects/<encoded-cwd>/**\/*.jsonl session logs.
 * Same parsing rules as project-costs.ts: dedupe by message id (a turn streams
 * the same usage block on several events), price from the shared table.
 * "Spend" is what the usage WOULD cost at API list prices — John is on a
 * subscription, so this is a consumption gauge, not an invoice.
 *
 * Cost control: files whose mtime predates the month can't contain this
 * month's messages and are skipped; lines are cheaply pre-filtered before
 * JSON.parse; results are cached for 5 minutes and concurrent callers share
 * one computation.
 */

export interface ModelSpend {
  /** Raw model id, e.g. "claude-haiku-4-5-20251001". */
  model: string;
  /** Human label, e.g. "Haiku 4.5". */
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  usd: number;
}

export interface MonthlySpend {
  /** e.g. "2026-07" */
  month: string;
  /** e.g. "July" */
  monthLabel: string;
  totalTokens: number;
  totalUsd: number;
  /** Sorted by usd descending. */
  byModel: ModelSpend[];
  computedAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: MonthlySpend | null = null;
let inFlight: Promise<MonthlySpend> | null = null;

export async function getMonthlySpend(): Promise<MonthlySpend> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache;
  if (!inFlight) {
    inFlight = computeMonthlySpend()
      .then((r) => {
        cache = r;
        return r;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "claude-fable-5" -> "Fable 5". */
function labelForModel(model: string): string {
  const stripped = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const parts = stripped.split("-");
  const name = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : model;
  const version = parts.slice(1).join(".");
  return version ? `${name} ${version}` : name;
}

async function listMonthActiveFiles(root: string, sinceMs: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.stat(full);
          // Last write predates the month => no in-month messages inside.
          if (st.mtimeMs >= sinceMs) out.push(full);
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(root);
  return out;
}

async function computeMonthlySpend(): Promise<MonthlySpend> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthLabel = now.toLocaleString("en-US", { month: "long" });

  const files = await listMonthActiveFiles(getConfig().claudeProjectsDir, monthStart);

  // Message ids are globally unique; dedupe across ALL files so resumed/forked
  // sessions that replay history don't double-count. Last-seen usage wins.
  const perMessage = new Map<string, { model: string; usage: UsageBlock }>();

  for (const file of files) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      // Cheap pre-filter: only assistant events with a usage block matter.
      if (!line || !line.includes('"usage"') || !line.includes('"timestamp"')) continue;
      let obj: {
        timestamp?: string;
        message?: { id?: string; model?: string; usage?: UsageBlock };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = obj.message;
      if (!msg || !msg.id || !msg.usage) continue;
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (!Number.isFinite(ts) || ts < monthStart || ts >= nextMonthStart) continue;
      perMessage.set(msg.id, { model: msg.model ?? "", usage: msg.usage });
    }
  }

  interface Agg {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    usd: number;
  }
  const byModel = new Map<string, Agg>();
  for (const { model, usage } of perMessage.values()) {
    if (!model || model === "<synthetic>") continue;
    let agg = byModel.get(model);
    if (!agg) {
      agg = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 };
      byModel.set(model, agg);
    }
    agg.input += usage.input_tokens ?? 0;
    agg.output += usage.output_tokens ?? 0;
    agg.cacheWrite +=
      usage.cache_creation
        ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) +
          (usage.cache_creation.ephemeral_1h_input_tokens ?? 0)
        : usage.cache_creation_input_tokens ?? 0;
    agg.cacheRead += usage.cache_read_input_tokens ?? 0;
    agg.usd += costForUsage(usage, model);
  }

  const models: ModelSpend[] = [...byModel.entries()]
    .map(([model, a]) => ({
      model,
      label: labelForModel(model),
      inputTokens: a.input,
      outputTokens: a.output,
      cacheWriteTokens: a.cacheWrite,
      cacheReadTokens: a.cacheRead,
      totalTokens: a.input + a.output + a.cacheWrite + a.cacheRead,
      usd: a.usd,
    }))
    .sort((a, b) => b.usd - a.usd);

  return {
    month,
    monthLabel,
    totalTokens: models.reduce((s, m) => s + m.totalTokens, 0),
    totalUsd: models.reduce((s, m) => s + m.usd, 0),
    byModel: models,
    computedAt: Date.now(),
  };
}
