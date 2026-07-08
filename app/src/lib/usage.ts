import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * usage.ts — read the live Claude subscription usage (5-hour + weekly windows)
 * the same numbers the interactive `/usage` command shows.
 *
 * There is no headless `/usage` command and no on-disk cache of the live quota, so
 * we do what Claude Code does internally: make one tiny authenticated call to the
 * Anthropic API using the user's own OAuth token (read from ~/.claude/.credentials.json,
 * used only in memory) and read the usage out of the response headers:
 *   anthropic-ratelimit-unified-5h-utilization / -5h-reset / -5h-status
 *   anthropic-ratelimit-unified-7d-utilization / -7d-reset / -7d-status
 *
 * NOTE: these headers are undocumented, so this can break if Anthropic renames them.
 * Fails gracefully (ok:false) so the widget just hides rather than erroring.
 * Result is cached ~60s so multiple dashboard tabs share one probe call.
 */

export interface UsageWindow {
  /** Percent used, 0-100. */
  pct: number;
  /** Reset time in epoch ms. */
  resetAt: number;
  /** allowed | allowed_warning | rejected | ... */
  status: string;
}

export interface UsageData {
  ok: boolean;
  reason?: string;
  fiveHour?: UsageWindow;
  week?: UsageWindow;
  fetchedAt: number;
}

const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const TTL_MS = 60_000;
const PROBE_MODEL = "claude-haiku-4-5-20251001";

let cache: UsageData | null = null;
let inFlight: Promise<UsageData> | null = null;

function findToken(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/access[_-]?token/i.test(k) && typeof v === "string") return v;
    if (v && typeof v === "object") {
      const t = findToken(v);
      if (t) return t;
    }
  }
  return null;
}

function readToken(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_PATH, "utf8")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return raw?.claudeAiOauth?.accessToken ?? findToken(raw);
  } catch {
    return null;
  }
}

async function fetchUsage(): Promise<UsageData> {
  const now = Date.now();
  const token = readToken();
  if (!token) return { ok: false, reason: "no-token", fetchedAt: now };

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    });
  } catch {
    return { ok: false, reason: "fetch-error", fetchedAt: now };
  }

  const h = res.headers;
  const num = (name: string): number | null => {
    const v = h.get(name);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const util5 = num("anthropic-ratelimit-unified-5h-utilization");
  const reset5 = num("anthropic-ratelimit-unified-5h-reset");
  if (util5 == null || reset5 == null) {
    return { ok: false, reason: `no-headers-${res.status}`, fetchedAt: now };
  }

  const util7 = num("anthropic-ratelimit-unified-7d-utilization");
  const reset7 = num("anthropic-ratelimit-unified-7d-reset");

  return {
    ok: true,
    fetchedAt: now,
    fiveHour: {
      pct: Math.round(util5 * 100),
      resetAt: reset5 * 1000,
      status: h.get("anthropic-ratelimit-unified-5h-status") ?? "",
    },
    week:
      util7 != null && reset7 != null
        ? {
            pct: Math.round(util7 * 100),
            resetAt: reset7 * 1000,
            status: h.get("anthropic-ratelimit-unified-7d-status") ?? "",
          }
        : undefined,
  };
}

/** Get subscription usage, cached ~60s. Coalesces concurrent callers. */
export async function getUsage(): Promise<UsageData> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = fetchUsage()
    .then((data) => {
      cache = data;
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
