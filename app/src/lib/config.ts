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
    defaultValue: () => "Z:\\GitHub",
  },
  {
    key: "vaultDir",
    label: "Vault",
    description:
      "The Obsidian vault — session transcripts, rolling primers, Indy's digests, and decisions are read and written here.",
    envVar: "VAULT_DIR",
    kind: "dir",
    defaultValue: () => path.join("Z:\\GitHub", "vault"),
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
  },
  {
    key: "openrouterApiKey",
    label: "OpenRouter API key",
    description:
      "Optional. Lets the War Room invite outside consultants (ChatGPT, Gemini, Grok) that answer through OpenRouter. Leave blank to keep the room Claude-only.",
    envVar: "OPENROUTER_API_KEY",
    kind: "command",
    defaultValue: () => "",
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
    return {
      key: field.key,
      label: field.label,
      description: field.description,
      envVar: field.envVar,
      kind: field.kind,
      value,
      source,
      defaultValue: field.defaultValue(),
      exists,
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
