import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Central configuration for every path and binary the app touches.
 *
 * Resolution order (highest wins):
 *   1. Settings file (~/.aiteam/settings.json) — written by the Settings page
 *   2. Environment variable (legacy names preserved, e.g. VAULT_DIR)
 *   3. Built-in default (matches the pre-config hardcoded values)
 *
 * getConfig() re-reads the settings file when its mtime changes, so edits made
 * on the Settings page apply to subsequent requests without an app restart.
 */

export const CONFIG_KEYS = [
  "ownerName",
  "projectsRoot",
  "vaultDir",
  "agentsDir",
  "skillsDir",
  "claudeProjectsDir",
  "aiteamDir",
  "claudeBin",
  "openrouterApiKey",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type AiTeamConfig = Record<ConfigKey, string>;

export interface ConfigFieldDef {
  key: ConfigKey;
  label: string;
  description: string;
  envVar: string;
  /** "dir" and "file" get an existence check on the Settings page; "command" doesn't. */
  kind: "dir" | "file" | "command";
  defaultValue: () => string;
  /** Never sent to the browser: the Settings page only learns whether it is set. */
  secret?: boolean;
  /**
   * The web Settings page may not change it; only setup.mjs or a hand edit of
   * the settings file can. For values that decide what program the app runs.
   */
  webLocked?: boolean;
}

export const CONFIG_FIELDS: ConfigFieldDef[] = [
  {
    key: "ownerName",
    label: "Owner name",
    description:
      'Your name, as the team should use it (e.g. "Jane Smith"). Shown across the dashboard and included in every agent prompt.',
    envVar: "AITEAM_OWNER_NAME",
    kind: "command",
    defaultValue: () => "Boss",
  },
  {
    key: "projectsRoot",
    label: "Projects root",
    description:
      "Folder scanned for projects. New projects are created here; project chats run with their folder as the working directory.",
    envVar: "PROJECTS_ROOT",
    kind: "dir",
    // The folder the aiTeam repo sits in (cwd is app/), same default setup.mjs offers.
    defaultValue: () => path.resolve(process.cwd(), "..", ".."),
  },
  {
    key: "vaultDir",
    label: "Vault",
    description:
      "The Obsidian vault. Session transcripts, rolling primers, research digests and decisions are read and written here.",
    envVar: "VAULT_DIR",
    kind: "dir",
    defaultValue: () => path.resolve(process.cwd(), "..", "..", "vault"),
  },
  {
    key: "agentsDir",
    label: "Agent personas",
    description:
      "User-level folder holding each persona's soul/agents/tools files, inboxes, and the live-feed log (~/.claude/agents).",
    envVar: "CLAUDE_AGENTS_DIR",
    kind: "dir",
    defaultValue: () => path.join(os.homedir(), ".claude", "agents"),
  },
  {
    key: "skillsDir",
    label: "Skills",
    description:
      "Team-authored Claude Code skills surfaced on the Skills page (~/.claude/skills).",
    envVar: "CLAUDE_SKILLS_DIR",
    kind: "dir",
    defaultValue: () => path.join(os.homedir(), ".claude", "skills"),
  },
  {
    key: "claudeProjectsDir",
    label: "Claude Code session logs",
    description:
      "Claude Code's own session-log store (~/.claude/projects). Read to recover transcripts and compute per-project costs.",
    envVar: "CLAUDE_PROJECTS_DIR",
    kind: "dir",
    defaultValue: () => path.join(os.homedir(), ".claude", "projects"),
  },
  {
    key: "aiteamDir",
    label: "aiTeam home",
    description:
      "The aiTeam repo root — inbox-shared.md and big5.md live here. Defaults to the parent of the app folder.",
    envVar: "AITEAM_DIR",
    kind: "dir",
    defaultValue: () => path.resolve(process.cwd(), ".."),
  },
  {
    key: "claudeBin",
    label: "Claude binary",
    description:
      'The Claude Code executable used to spawn chat sessions and distillations. A bare command resolved on PATH ("claude") or an absolute path.',
    envVar: "CLAUDE_BIN",
    kind: "command",
    defaultValue: () => "claude",
    webLocked: true,
  },
  {
    key: "openrouterApiKey",
    label: "OpenRouter API key",
    description:
      "Optional. Lets the War Room invite outside consultants (ChatGPT, Gemini, Grok) that answer through OpenRouter. Leave blank to keep the room Claude-only.",
    envVar: "OPENROUTER_API_KEY",
    kind: "command",
    defaultValue: () => "",
    secret: true,
  },
];

export const SETTINGS_FILE =
  process.env.AITEAM_SETTINGS_FILE ||
  path.join(os.homedir(), ".aiteam", "settings.json");

interface SettingsCache {
  mtimeMs: number | null;
  values: Partial<AiTeamConfig>;
}

let cache: SettingsCache | null = null;

function readSettingsFile(): Partial<AiTeamConfig> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    cache = { mtimeMs: null, values: {} };
    return cache.values;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.values;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<
      string,
      unknown
    >;
    const values: Partial<AiTeamConfig> = {};
    for (const key of CONFIG_KEYS) {
      const v = raw[key];
      if (typeof v === "string" && v.trim().length > 0) values[key] = v.trim();
    }
    cache = { mtimeMs, values };
  } catch {
    // Unreadable or malformed file: fall back to env/defaults rather than crash.
    cache = { mtimeMs, values: {} };
  }
  return cache.values;
}

export function getConfig(): AiTeamConfig {
  const saved = readSettingsFile();
  const cfg = {} as AiTeamConfig;
  for (const field of CONFIG_FIELDS) {
    cfg[field.key] =
      saved[field.key] ?? process.env[field.envVar] ?? field.defaultValue();
  }
  return cfg;
}

/**
 * The dispatch queue's off switch: `"dispatchQueue": false` in settings.json.
 * On by default. When off, `dispatch.mjs --after` is refused and nothing already
 * waiting is started (it stays listed and cancellable). See
 * docs/dispatch-queue.md, "How to undo".
 */
export function isDispatchQueueEnabled(): boolean {
  const v = readRawSettings().dispatchQueue;
  if (v === false) return false;
  if (typeof v === "string" && /^(false|off|no|0)$/i.test(v.trim())) return false;
  return true;
}

/** The main dashboard's port: settings.json appPort, else the reserved 3900.
 *  Same rule as scripts/dispatch.mjs; never the ambient PORT variable. */
export function getAppPort(): string {
  const v = readRawSettings().appPort;
  return v !== undefined && v !== null && String(v).trim() ? String(v).trim() : "3900";
}

export interface OwnerName {
  /** Full display name, e.g. "Jane Smith". */
  full: string;
  /** First word of the full name, used where the team speaks casually. */
  first: string;
}

/** The human owner's name, from config ("Owner name" on the Settings page). */
export function getOwnerName(): OwnerName {
  const full = getConfig().ownerName.trim() || "Boss";
  return { full, first: full.split(/\s+/)[0] };
}

export interface ConfigFieldInfo {
  key: ConfigKey;
  label: string;
  description: string;
  envVar: string;
  kind: "dir" | "file" | "command";
  value: string;
  source: "settings" | "env" | "default";
  defaultValue: string;
  /** Whether the path exists on disk. Always true for kind "command" (not checked). */
  exists: boolean;
  /** Secret field: `value` and `defaultValue` are always "", `isSet` says whether one is saved. */
  secret: boolean;
  isSet: boolean;
  /** Not editable from the web Settings page. */
  webLocked: boolean;
}

/** Every resolved value except the secret ones; what the browser may see. */
export function getPublicConfig(): Partial<AiTeamConfig> {
  const cfg = getConfig();
  const out: Partial<AiTeamConfig> = {};
  for (const field of CONFIG_FIELDS) {
    if (!field.secret) out[field.key] = cfg[field.key];
  }
  return out;
}

/**
 * Settings the web PUT may change. claudeBin is excluded: it is the program
 * the app launches for every chat, so only setup.mjs or a hand edit of the
 * settings file may set it.
 */
export const WEB_EDITABLE_KEYS: readonly ConfigKey[] = CONFIG_FIELDS.filter(
  (f) => !f.webLocked
).map((f) => f.key);

interface RawCache {
  mtimeMs: number | null;
  values: Record<string, unknown>;
}
let rawCache: RawCache | null = null;

/** The whole settings file, including keys outside CONFIG_KEYS. {} if missing or malformed. */
function readRawSettings(): Record<string, unknown> {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    rawCache = { mtimeMs: null, values: {} };
    return rawCache.values;
  }
  if (rawCache && rawCache.mtimeMs === mtimeMs) return rawCache.values;
  let values: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      values = raw as Record<string, unknown>;
    }
  } catch {
    // Malformed: no extras.
  }
  rawCache = { mtimeMs, values };
  return values;
}

/**
 * Extra host names the dashboard answers to, beyond localhost, 127.0.0.1 and
 * ::1 (lib/request-guard.ts). Set by hand in the settings file, for example
 * `"allowedHosts": ["my-pc.tail1234.ts.net"]` for Tailscale, or one
 * comma-separated string. Names only, no scheme or port; lowercased.
 * Deliberately not on the Settings page: it widens the front door.
 */
export function getExtraAllowedHosts(): string[] {
  const v = readRawSettings().allowedHosts;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

export function getConfigInfo(): {
  settingsFile: string;
  fields: ConfigFieldInfo[];
} {
  const saved = readSettingsFile();
  const fields = CONFIG_FIELDS.map((field) => {
    const fromFile = saved[field.key];
    const fromEnv = process.env[field.envVar];
    const value = fromFile ?? fromEnv ?? field.defaultValue();
    const source: ConfigFieldInfo["source"] = fromFile
      ? "settings"
      : fromEnv
        ? "env"
        : "default";
    let exists = true;
    if (field.kind !== "command") {
      try {
        fs.statSync(value);
      } catch {
        exists = false;
      }
    }
    const secret = Boolean(field.secret);
    return {
      key: field.key,
      label: field.label,
      description: field.description,
      envVar: field.envVar,
      kind: field.kind,
      // A secret never leaves the server, not even to the owner's own page.
      value: secret ? "" : value,
      source,
      defaultValue: secret ? "" : field.defaultValue(),
      exists,
      secret,
      isSet: value.length > 0,
      webLocked: Boolean(field.webLocked),
    };
  });
  return { settingsFile: SETTINGS_FILE, fields };
}

/**
 * Merge updates into the settings file. An empty/whitespace value clears the
 * key (reverting that setting to env/default). Unknown keys in the existing
 * file are preserved for forward compatibility.
 */
export function saveSettings(
  updates: Partial<Record<ConfigKey, string>>
): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // Missing or malformed: start fresh.
  }
  for (const key of CONFIG_KEYS) {
    if (!(key in updates)) continue;
    const v = updates[key];
    if (typeof v === "string" && v.trim().length > 0) {
      existing[key] = v.trim();
    } else {
      delete existing[key];
    }
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2) + "\n", "utf8");
  cache = null;
}
