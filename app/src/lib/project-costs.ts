import path from "node:path";
import { promises as fsp } from "node:fs";
import { resolveExistingProjectCwd } from "@/lib/projects";
import { getConfig } from "@/lib/config";

/**
 * Per-million-token pricing in USD, from the official Anthropic pricing page
 * https://platform.claude.com/docs/en/about-claude/pricing (re-verified against
 * the claude-api reference 2026-07-02). Cache write = 1.25x input (5m TTL) or
 * 2x input (1h TTL); cache read = 0.1x input.
 *
 * Keys are date-less model prefixes — pricingFor() matches dated IDs like
 * "claude-haiku-4-5-20251001" by prefix, so new snapshot suffixes keep working.
 *
 * Note: do NOT use the `total_cost_usd` field that Claude Code emits in
 * stream-json result events — that field is known to be inflated 10x-100x
 * (anthropics/claude-code#53371). The per-message `usage` token counts are
 * accurate; cost must be computed manually from those.
 */
interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": {
    input: 10,
    output: 50,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
  },
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
  },
  "claude-opus-4-7": {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
  },
  "claude-opus-4-6": {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
  },
  "claude-opus-4-5": {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
  },
  // Sonnet 5 standard rates ($2/$10 intro pricing runs through 2026-08-31;
  // we book at the standard sticker so estimates stay conservative).
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
  },
};

const FALLBACK: ModelPricing = PRICING["claude-sonnet-4-6"];

export interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Exact match first, then date-less prefix (dated snapshot IDs), then the
 *  Sonnet-tier fallback. Returns null for synthetic/empty models (not billed). */
function pricingFor(model: string): ModelPricing | null {
  if (!model || model === "<synthetic>") return null;
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return FALLBACK;
}

export function costForUsage(usage: UsageBlock, model: string): number {
  const p = pricingFor(model);
  if (!p) return 0;
  const inCost = (usage.input_tokens ?? 0) * p.input;
  const outCost = (usage.output_tokens ?? 0) * p.output;
  // Prefer the detailed ephemeral breakdown; Claude Code uses 1h cache.
  let cwCost = 0;
  if (usage.cache_creation) {
    const t5m = usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
    const t1h = usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
    cwCost = t5m * p.cacheWrite5m + t1h * p.cacheWrite1h;
  } else {
    // Fallback: assume 1h since that's Claude Code's default.
    cwCost = (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite1h;
  }
  const crCost = (usage.cache_read_input_tokens ?? 0) * p.cacheRead;
  return (inCost + outCost + cwCost + crCost) / 1_000_000;
}

function encodeCwdForClaude(absCwd: string): string {
  // Claude Code names project dirs by replacing `\`, `/`, `:` with `-`.
  return absCwd.replace(/[\\/:]/g, "-");
}


/**
 * Walk ~/.claude/projects/<encoded-project-cwd>/ and split cost into two buckets:
 *   - chat: top-level .jsonl files (primary CVB chat sessions with you)
 *   - agents: .jsonl files in any subdirectory (subagents spawned via the Task
 *     tool, stored at <parentSessionId>/subagents/agent-*.jsonl)
 *
 * Anything that ran with cwd != the project dir lands in a different encoded
 * folder and is excluded automatically. CVB Dashboard default chat runs from
 * aiTeam/app/ and writes to Z--GitHub-aiTeam-app/ — not counted per the rule
 * that aiTeam-spawned overhead doesn't belong to a specific project.
 */
async function chatAndAgentsCost(
  projectCwd: string
): Promise<{ chat: number; agents: number }> {
  const encoded = encodeCwdForClaude(projectCwd);
  const projectDir = path.join(getConfig().claudeProjectsDir, encoded);
  return splitWalk(projectDir, 0);
}

async function splitWalk(
  dir: string,
  depth: number
): Promise<{ chat: number; agents: number }> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { chat: 0, agents: 0 };
  }
  let chat = 0;
  let agents = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await splitWalk(full, depth + 1);
      chat += sub.chat;
      agents += sub.agents;
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let cost = 0;
      try {
        cost = await costFromJsonlFile(full);
      } catch {
        /* skip unreadable file */
      }
      if (depth === 0) chat += cost;
      else agents += cost;
    }
  }
  return { chat, agents };
}

/**
 * Each assistant turn streams as multiple events that all carry the same
 * `message.id` and the same `usage` block. We must dedupe by message id to
 * avoid triple-counting. We use the LAST seen usage per id (they should all
 * agree once the message is complete, but the final one is the safest pick).
 */
async function costFromJsonlFile(filePath: string): Promise<number> {
  const raw = await fsp.readFile(filePath, "utf8");
  const perMessage = new Map<string, { model: string; usage: UsageBlock }>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: {
      message?: { id?: string; model?: string; usage?: UsageBlock };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message;
    if (!msg || typeof msg !== "object") continue;
    const id = msg.id;
    const usage = msg.usage;
    if (!id || !usage) continue;
    perMessage.set(id, { model: msg.model ?? "", usage });
  }
  let total = 0;
  for (const { model, usage } of perMessage.values()) {
    total += costForUsage(usage, model);
  }
  return total;
}

export interface ProjectCost {
  total: number;
  chat: number;
  agents: number;
}

export async function getProjectCost(slug: string): Promise<ProjectCost | null> {
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return null;
  const { chat, agents } = await chatAndAgentsCost(cwd);
  return {
    chat,
    agents,
    total: chat + agents,
  };
}
