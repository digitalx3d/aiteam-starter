import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig, getOwnerName } from "./config";
import { readOperatingRules, operatingRulesSection } from "./team-rules";

// Personas live at user level (~/.claude/agents/<name>/ by default). Both the
// persona working dirs and the subagent .md definition files are siblings here.
// Configurable via the Settings page (or CLAUDE_AGENTS_DIR).
function agentsDir(): string {
  return getConfig().agentsDir;
}

export interface SubagentDef {
  name: string;
  description: string;
  tools?: string;
  model?: string;
  /** Reasoning effort default for this agent (low|medium|high|xhigh|max).
   *  Undefined when the frontmatter omits it or the value was invalid. */
  effort?: string;
  color?: string;
}

/** The reasoning-effort levels the `--effort` CLI flag accepts. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Normalizes a reasoning-effort value to a level the CLI accepts, or null.
 * Case-insensitive. Anything unrecognized returns null so callers can fall
 * through to "no --effort flag" rather than handing the CLI garbage — a typo
 * in persona frontmatter must never break a dispatch.
 */
export function normalizeEffort(value: unknown): EffortLevel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as EffortLevel)
    : null;
}

export interface AgentProfile {
  lastName: string;
  strengths: string[];
  weaknesses: string[];
  loves: string[];
  hates: string[];
}

export interface AgentListing {
  name: string;
  /** First name only (e.g. "Maya") — the slug-derived label. */
  displayName: string;
  /** Full display name including the movie-character last name (e.g. "Maya Solo"). */
  fullName: string;
  description: string;
  color: string;
  tools?: string;
  model?: string;
  /** Per-agent reasoning-effort default from frontmatter, if set and valid. */
  effort?: string;
  completedCount: number;
  inboxBytes: number;
  lastActivityMs: number | null;
  hasSubagentDef: boolean;
  /** URL to the persona's avatar image, or null if none exists. */
  avatarUrl: string | null;
  /** Strengths / weaknesses / loves / hates one-liners. Phase 1: hardcoded; Phase 2 will move to a per-agent profile file. */
  profile: AgentProfile | null;
  /** Set for static team members (the owner = "human", Claude = "orchestrator"). Drives the role badge in place of the model badge. */
  role?: StaticRole;
}

export interface AgentDetail extends AgentListing {
  subagentBody: string | null;
  files: {
    soul: string | null;
    agents: string | null;
    heartbeat: string | null;
    tools: string | null;
    inbox: string | null;
    completed: string | null;
    styleBrief: string | null;
  };
}

const TARGETED_FILES = [
  "soul.md",
  "agents.md",
  "heartbeat.md",
  "tools.md",
  "inbox.md",
  "completed.md",
  "style-brief.md",
] as const;

// Static team members — humans and the orchestrator. Not Claude Code subagents,
// so they don't have files in agents/<name>/ and aren't dispatched as workers.
// They appear on the Team page so the team feels complete.
interface StaticTeamMember {
  name: string;
  lastName: string;
  description: string;
  color: string;
  role: "human" | "orchestrator";
  strengths: string[];
  weaknesses: string[];
  loves: string[];
  hates: string[];
}

// A function, not a const: the human entry's names come from the ownerName
// config value, which can change between requests via the Settings page.
// The "owner" slug is the stable internal id (avatar filename, URL segment,
// chat-role mapping) and does not change with the display name.
function staticTeamMembers(): StaticTeamMember[] {
  const owner = getOwnerName();
  return [
    {
      name: "owner",
      lastName: owner.full.split(/\s+/).slice(1).join(" "),
      description: "Founder, product lead, and top of the team hierarchy.",
      color: "purple",
      role: "human",
      strengths: ["vision", "decisiveness", "taste"],
      weaknesses: ["wanting it shipped yesterday"],
      loves: ["real software", "family", "ambitious scope"],
      hates: ["corporate filler", "AI cliches", "sycophancy"],
    },
    {
      name: "claude",
      lastName: "Von Braun",
      description: `Orchestrator and chief of staff. Talks to ${owner.first} in the Dashboard, drafts plans, dispatches the rest of the team.`,
      color: "cyan",
      role: "orchestrator",
      strengths: ["synthesis", "spec writing", "finding the cheap-and-correct path"],
      weaknesses: ["over-explaining", "premature abstraction"],
      loves: ["clean specs", "200 OK", "well-named functions"],
      hates: ["vague briefs", "tangled state", "shipping wrong"],
    },
  ];
}

export type StaticRole = "human" | "orchestrator";

// Per-persona profile data. Last names from iconic movie characters that fit the voice.
// TODO Phase 2: move this to agents/<name>/profile.md for in-app editing.
const AGENT_PROFILES: Record<string, AgentProfile> = {
  maya: {
    lastName: "Solo",
    strengths: ["composition", "color", "restraint"],
    weaknesses: ["shipping \"fine\""],
    loves: ["sketchbooks", "soft window light", "found typography"],
    hates: ["Comic Sans", "AI uncanny faces"],
  },
  devin: {
    lastName: "McClane",
    strengths: ["Lighthouse 100", "the 4px nudge"],
    weaknesses: ["framework FOMO"],
    loves: ["plain HTML", "clean diffs", "the semicolon"],
    hates: ["\"we'll fix it later\"", "jQuery in 2026", "!important"],
  },
  casey: {
    lastName: "Ripley",
    strengths: ["tight verbs", "cold reads", "cutting 25%"],
    weaknesses: ["saying yes to fluff"],
    loves: ["real numbers", "dog-eared paperbacks", "ledes that earn the click"],
    hates: ["em dashes", "\"at the end of the day\"", "AI cliches"],
  },
  indy: {
    lastName: "Brown",
    strengths: ["primary sources", "timestamped citations", "spotting connections"],
    weaknesses: ["nerding out for thirty extra minutes"],
    loves: ["a paper with real evals", "captions that exist", "a good rabbit hole"],
    hates: ["\"AI changes everything\" threads", "stale benchmarks", "press-release headlines"],
  },
  ethan: {
    lastName: "Stark",
    strengths: ["finding the bypass", "five-line findings", "the threat model"],
    weaknesses: ["assuming the worst case"],
    loves: ["parameterized queries", "structured logs", "a tested restore"],
    hates: ["secrets in localStorage", "wildcard CORS", "\"it works on my machine\""],
  },
};

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Returns the public URL if a per-agent avatar webp exists in app/public/avatars/, else null. */
async function avatarUrlIfExists(name: string): Promise<string | null> {
  const p = path.join(process.cwd(), "public", "avatars", `${name}.webp`);
  try {
    await fsp.access(p);
    return `/avatars/${name}.webp`;
  } catch {
    return null;
  }
}

async function statMs(p: string): Promise<number | null> {
  try {
    const s = await fsp.stat(p);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/** Tiny YAML-ish parser for the simple frontmatter our subagent files use. */
function parseSubagentFrontmatter(content: string): SubagentDef | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const body = match[1];
  const fields: Record<string, string> = {};
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }
  if (!fields.name) return null;
  return {
    name: fields.name,
    description: fields.description ?? "",
    tools: fields.tools,
    model: fields.model,
    // Invalid values are dropped here rather than surfaced, so a bad
    // `effort:` line degrades to "no effort set" instead of failing a spawn.
    effort: normalizeEffort(fields.effort) ?? undefined,
    color: fields.color,
  };
}

function bodyAfterFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) return content;
  return content.slice(match[0].length).trimStart();
}

function countCompletedEntries(content: string | null): number {
  if (!content) return 0;
  // Each completed entry is a line starting with a date (YYYY-MM-DD) or "##".
  let count = 0;
  for (const line of content.split("\n")) {
    if (/^\d{4}-\d{2}-\d{2}/.test(line) || /^##\s+/.test(line)) count++;
  }
  return count;
}

/** Validates a name as a safe identifier (no path traversal, no surprises). */
function isSafeAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Resolves what dispatch needs to spawn a top-level worker for an agent:
 *   - systemPrompt: the body of ~/.claude/agents/<name>.md (frontmatter stripped).
 *     This contains the agent's activation procedure, identity, hard rules, and
 *     scope. The worker reads its own soul/agents/tools/heartbeat/projects per
 *     the activation procedure embedded here.
 *   - allowedTools: tool names parsed from the frontmatter `tools:` line.
 *   - model / effort: the agent's spawn defaults from frontmatter. Either may be
 *     null, in which case the caller omits the flag and the CLI default applies.
 *
 * Returns null if the definition file doesn't exist or has no frontmatter.
 */
export async function loadAgentForDispatch(name: string): Promise<{
  systemPrompt: string;
  allowedTools: string[];
  model: string | null;
  effort: string | null;
} | null> {
  if (!isSafeAgentName(name)) return null;
  const { def, body } = await loadSubagentDef(name);
  if (!def || !body) return null;
  const allowedTools = (def.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  // Inject the canonical team operating rules from the single vault source, so every
  // worker has them in context regardless of whether it reads its own files at
  // activation. This is what lets persona files stop restating (and drifting) them.
  const operatingRules = await readOperatingRules();
  const systemPrompt = operatingRules
    ? `${body}\n\n---\n\n${operatingRulesSection(operatingRules)}`
    : body;
  return {
    systemPrompt,
    allowedTools,
    model: def.model ?? null,
    effort: def.effort ?? null,
  };
}

async function loadSubagentDef(name: string): Promise<{
  def: SubagentDef | null;
  body: string | null;
}> {
  const content = await readMaybe(path.join(agentsDir(), `${name}.md`));
  if (!content) return { def: null, body: null };
  const def = parseSubagentFrontmatter(content);
  return { def, body: bodyAfterFrontmatter(content) };
}

async function listAgentNames(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(agentsDir());
  } catch {
    return [];
  }
  const staticNames = new Set(staticTeamMembers().map((m) => m.name));
  const names: string[] = [];
  for (const e of entries) {
    if (e.startsWith(".") || e.startsWith("_")) continue;
    if (staticNames.has(e)) continue;
    const stat = await fsp.stat(path.join(agentsDir(), e)).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    names.push(e);
  }
  return names.sort();
}

async function staticListing(member: StaticTeamMember): Promise<AgentListing> {
  const avatarUrl = await avatarUrlIfExists(member.name);
  // The human's display name comes from config, not from the "owner" slug.
  const displayName =
    member.role === "human" ? getOwnerName().first : capitalize(member.name);
  return {
    name: member.name,
    displayName,
    fullName: member.lastName ? `${displayName} ${member.lastName}` : displayName,
    description: member.description,
    color: member.color,
    completedCount: 0,
    inboxBytes: 0,
    lastActivityMs: null,
    hasSubagentDef: false,
    avatarUrl,
    profile: {
      lastName: member.lastName,
      strengths: member.strengths,
      weaknesses: member.weaknesses,
      loves: member.loves,
      hates: member.hates,
    },
    role: member.role,
  };
}

/**
 * Just the canonical display names for the team, no profile/avatar/inbox
 * reads. Used to reconcile assignee spellings on task files, which agents
 * write by hand and usually spell in lowercase slug form ("devin").
 */
export async function agentDisplayNames(): Promise<string[]> {
  const names = await listAgentNames();
  const statics = staticTeamMembers().map((m) =>
    m.role === "human" ? getOwnerName().first : capitalize(m.name)
  );
  return [...statics, ...names.map((n) => capitalize(n))];
}

export async function discoverAgents(): Promise<AgentListing[]> {
  const names = await listAgentNames();
  const results: AgentListing[] = [];

  // Static members first (the human, then Claude), so the human + orchestrator anchor the page.
  const statics = await Promise.all(staticTeamMembers().map(staticListing));
  results.push(...statics);
  for (const name of names) {
    const dir = path.join(agentsDir(), name);
    const [completedContent, inboxStat, completedStat, def, avatarUrl] =
      await Promise.all([
        readMaybe(path.join(dir, "completed.md")),
        statMs(path.join(dir, "inbox.md")),
        statMs(path.join(dir, "completed.md")),
        loadSubagentDef(name),
        avatarUrlIfExists(name),
      ]);
    const completedCount = countCompletedEntries(completedContent);
    const lastActivityMs =
      completedStat && inboxStat
        ? Math.max(completedStat, inboxStat)
        : completedStat ?? inboxStat;
    let inboxBytes = 0;
    try {
      const s = await fsp.stat(path.join(dir, "inbox.md"));
      inboxBytes = s.size;
    } catch {
      /* ok */
    }
    const profile = AGENT_PROFILES[name] ?? null;
    const displayName = capitalize(name);
    const fullName = profile?.lastName
      ? `${displayName} ${profile.lastName}`
      : displayName;
    results.push({
      name,
      displayName,
      fullName,
      description: def.def?.description ?? "",
      color: def.def?.color ?? "blue",
      tools: def.def?.tools,
      model: def.def?.model,
      effort: def.def?.effort,
      completedCount,
      inboxBytes,
      lastActivityMs,
      hasSubagentDef: def.def !== null,
      avatarUrl,
      profile,
    });
  }
  return results;
}

export async function getAgentDetail(name: string): Promise<AgentDetail | null> {
  // Safety: name must be a simple identifier (no traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;

  // Static team members (the owner, Claude). The owner is human-only (no persona files).
  // Claude (Von Braun) has full persona files at ~/.claude/agents/claude/ — read
  // them like any other agent but keep the static role/description metadata.
  const staticMember = staticTeamMembers().find((m) => m.name === name);
  if (staticMember) {
    const listing = await staticListing(staticMember);
    const dir = path.join(agentsDir(), name);
    const dirStat = await fsp.stat(dir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      return {
        ...listing,
        subagentBody: null,
        files: {
          soul: null,
          agents: null,
          heartbeat: null,
          tools: null,
          inbox: null,
          completed: null,
          styleBrief: null,
        },
      };
    }
    const [soul, agents, heartbeat, tools, inbox, completed, styleBrief] =
      await Promise.all([
        readMaybe(path.join(dir, "soul.md")),
        readMaybe(path.join(dir, "agents.md")),
        readMaybe(path.join(dir, "heartbeat.md")),
        readMaybe(path.join(dir, "tools.md")),
        readMaybe(path.join(dir, "inbox.md")),
        readMaybe(path.join(dir, "completed.md")),
        readMaybe(path.join(dir, "style-brief.md")),
      ]);
    return {
      ...listing,
      subagentBody: null,
      files: { soul, agents, heartbeat, tools, inbox, completed, styleBrief },
    };
  }

  const dir = path.join(agentsDir(), name);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) return null;

  const [
    soul,
    agents,
    heartbeat,
    tools,
    inbox,
    completed,
    styleBrief,
    def,
    avatarUrl,
  ] = await Promise.all([
    readMaybe(path.join(dir, "soul.md")),
    readMaybe(path.join(dir, "agents.md")),
    readMaybe(path.join(dir, "heartbeat.md")),
    readMaybe(path.join(dir, "tools.md")),
    readMaybe(path.join(dir, "inbox.md")),
    readMaybe(path.join(dir, "completed.md")),
    readMaybe(path.join(dir, "style-brief.md")),
    loadSubagentDef(name),
    avatarUrlIfExists(name),
  ]);

  // Reuse the listing logic for top-line stats
  const completedCount = countCompletedEntries(completed);
  const inboxStat = await statMs(path.join(dir, "inbox.md"));
  const completedStat = await statMs(path.join(dir, "completed.md"));
  const lastActivityMs =
    completedStat && inboxStat
      ? Math.max(completedStat, inboxStat)
      : completedStat ?? inboxStat;
  let inboxBytes = 0;
  try {
    const s = await fsp.stat(path.join(dir, "inbox.md"));
    inboxBytes = s.size;
  } catch {
    /* ok */
  }

  const profile = AGENT_PROFILES[name] ?? null;
  const displayName = capitalize(name);
  const fullName = profile?.lastName
    ? `${displayName} ${profile.lastName}`
    : displayName;
  return {
    name,
    displayName,
    fullName,
    description: def.def?.description ?? "",
    color: def.def?.color ?? "blue",
    tools: def.def?.tools,
    model: def.def?.model,
    effort: def.def?.effort,
    completedCount,
    inboxBytes,
    lastActivityMs,
    hasSubagentDef: def.def !== null,
    avatarUrl,
    profile,
    subagentBody: def.body,
    files: {
      soul,
      agents,
      heartbeat,
      tools,
      inbox,
      completed,
      styleBrief,
    },
  };
}

void TARGETED_FILES; // exported list for future reference; quiets unused-warning if any
