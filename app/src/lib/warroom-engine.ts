import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnClaude } from "./claude-spawn";
import { discoverAgents, type AgentListing } from "./agents";
import { getConfig, getOwnerName } from "./config";
import { openRouterChat } from "./openrouter";
import { buildVaultContext, type VaultContext } from "./warroom-vault";
import {
  addResearchNotes,
  appendMessage,
  createSession,
  drainInterjections,
  emitTyping,
  getSessionSync,
  registerChild,
  setSavedPlanPath,
  setStarted,
  setStatus,
  setTitle,
  unregisterChild,
  type RosterMember,
  type WarRoomMessage,
  type WarRoomResearch,
  type WarRoomRole,
  type WarRoomSession,
} from "./warroom-store";

/** The default brainstorm roster (worker agents with personas). */
export const DEFAULT_ROSTER = ["maya", "devin", "casey", "indy", "ethan"];

/**
 * "Pace" presets. Each bundles a per-bubble word cap (a prompt instruction) and
 * a reasoning-effort level (a real --effort CLI flag on Opus/Sonnet). Lightning
 * = short and snappy, easy to follow live; Deep = longer, deepest thinking.
 */
export const PACE_PRESETS: Record<
  string,
  { wordLimit: number; effort: string }
> = {
  lightning: { wordLimit: 60, effort: "medium" },
  standard: { wordLimit: 120, effort: "high" },
  deep: { wordLimit: 220, effort: "max" },
};

/**
 * Rotating "angle cards": each round every speaker is dealt a distinct lens to
 * think through. Assigned angles decorrelate the room — five smart agents on
 * the same model otherwise drift toward the same safe center. No card in the
 * final converge round.
 */
function angleCards(): string[] {
  return [
    "the cheapest version that could possibly work",
    "the most ambitious version, money and time no object",
    "what a well-funded competitor would do with this same idea",
    "the customer's voice: how this feels to the person paying for it",
    "the case AGAINST: argue this is a bad idea or the wrong time",
    "fastest to ship: what could be live within a week",
    "the boring, reliable, proven way to do this",
    "the money angle: how this makes or saves real dollars",
    "what breaks at 10x: how this holds up if it really takes off",
    `the one-person version: how ${getOwnerName().first} alone could run this day to day`,
  ];
}

const FACILITATOR: RosterMember = {
  name: "claude",
  displayName: "Claude Von Braun",
  color: "cyan",
  avatarUrl: "/avatars/claude.webp",
};

// Per-session cache of agent listings (profile/voice data), populated at start.
const listingCache = new Map<string, Map<string, AgentListing>>();

export interface RosterConfigEntry {
  name: string;
  /** Claude model alias override for this member ("" / undefined = room default). */
  model?: string;
  /** Extra role/context the owner typed for this session. */
  extra?: string;
}

export interface OutsiderInput {
  displayName: string;
  /** OpenRouter model id, e.g. "openai/gpt-5.1". */
  model: string;
  extra?: string;
}

interface StartInput {
  idea: string;
  objective: string;
  model: string;
  roster?: string[];
  rosterConfig?: RosterConfigEntry[];
  outsiders?: OutsiderInput[];
  rounds?: number;
  pace?: string;
  personaWeight?: number;
  research?: WarRoomResearch;
}

const OUTSIDER_COLORS = ["emerald", "violet", "amber", "rose"];

export async function startWarRoom(
  input: StartInput
): Promise<WarRoomSession> {
  const all = await discoverAgents();
  const byName = new Map(all.map((a) => [a.name, a]));

  const configByName = new Map<string, RosterConfigEntry>();
  for (const entry of input.rosterConfig ?? []) {
    if (entry?.name) configByName.set(entry.name, entry);
  }

  const requested =
    input.rosterConfig && input.rosterConfig.length > 0
      ? input.rosterConfig.map((e) => e.name)
      : input.roster && input.roster.length > 0
        ? input.roster
        : DEFAULT_ROSTER;
  const wanted = requested.filter((n) => byName.has(n));

  const rosterMeta: RosterMember[] = wanted.map((n) => {
    const a = byName.get(n)!;
    const cfg = configByName.get(n);
    return {
      name: a.name,
      displayName: a.fullName || a.displayName,
      color: a.color,
      avatarUrl: a.avatarUrl,
      provider: "claude" as const,
      model: cfg?.model?.trim() || undefined,
      extra: cfg?.extra?.trim() || undefined,
    };
  });

  // Outside consultants (OpenRouter). Only seated when a key is configured;
  // the API route surfaces a clear error, this is just the last line of defense.
  const hasOrKey = Boolean(getConfig().openrouterApiKey);
  const outsiders = (input.outsiders ?? []).filter(
    (o) => hasOrKey && o?.displayName?.trim() && o?.model?.trim()
  );
  outsiders.forEach((o, i) => {
    rosterMeta.push({
      name: `guest-${i + 1}`,
      displayName: o.displayName.trim().slice(0, 40),
      color: OUTSIDER_COLORS[i % OUTSIDER_COLORS.length],
      avatarUrl: null,
      provider: "openrouter",
      model: o.model.trim(),
      extra: o.extra?.trim() || undefined,
    });
  });

  const id = randomUUID();
  const rounds = Math.min(Math.max(input.rounds ?? 3, 1), 6);
  const paceKey =
    input.pace && PACE_PRESETS[input.pace] ? input.pace : "standard";
  const preset = PACE_PRESETS[paceKey];
  const personaWeight = Math.min(Math.max(input.personaWeight ?? 35, 0), 100);
  const research: WarRoomResearch =
    input.research === "opening" || input.research === "deep"
      ? input.research
      : "off";

  const session = createSession({
    id,
    idea: input.idea.trim(),
    objective: input.objective.trim(),
    model: input.model || "sonnet",
    pace: paceKey,
    wordLimit: preset.wordLimit,
    effort: preset.effort,
    roster: rosterMeta.map((m) => m.name),
    rosterMeta,
    rounds,
    personaWeight,
    research,
  });

  // Stash listings for the background runner (voice/profile data per agent).
  const lc = new Map<string, AgentListing>();
  for (const n of wanted) lc.set(n, byName.get(n)!);
  listingCache.set(id, lc);

  // Fire-and-forget: the rounds run out-of-band, like dispatch workers.
  runSession(id).catch((err) => {
    appendFacilitator(
      id,
      0,
      `The session hit an error and stopped: ${(err as Error).message}`
    );
    setStatus(id, "failed");
  });

  return session;
}

function mkMessage(
  role: WarRoomRole,
  member: RosterMember,
  text: string,
  round: number
): WarRoomMessage {
  return {
    id: randomUUID(),
    role,
    agent: member.name,
    displayName: member.displayName,
    color: member.color,
    avatarUrl: member.avatarUrl,
    text,
    round,
    ts: Date.now(),
  };
}

function appendFacilitator(id: string, round: number, text: string): void {
  appendMessage(id, mkMessage("facilitator", FACILITATOR, text, round));
}

/** Format the conversation so far for an agent's context (humans + agents only). */
function buildTranscript(session: WarRoomSession): string {
  const lines: string[] = [];
  for (const m of session.messages) {
    if (m.role === "facilitator") continue;
    lines.push(`${m.displayName}: ${m.text}`);
  }
  return lines.join("\n\n");
}

/** House rules every speaker gets, insider or outsider. */
function warRoomRules(wordLimit: number): string[] {
  const owner = getOwnerName();
  return [
    `You are in a live WAR ROOM: a real-time brainstorm with the rest of the team and ${owner.first} in the room. Rules:`,
    `- Speak in plain English for ${owner.first}, a sharp business owner who is NOT a software developer. Explain any technical term in plain words. No jargon, no abbreviations.`,
    `- This is a conversation, not a report. Keep it short: under ${wordLimit} words, like talking out loud in a meeting. Do not exceed the limit.`,
    "- React to what others actually said. Agree, build on it, or push back, by name. If your point substantially overlaps something already said, either add a genuinely new layer or pass.",
    "- If you have nothing useful to add this round, say so in one line and pass.",
    "- Do NOT run any activation procedure, do NOT read or write any files, do NOT use tools. Just talk.",
    "- No preamble like 'Here's my take'. Just say it.",
  ];
}

const SKEPTIC_LINE =
  "- This round you also wear the skeptic's hat for the room: pressure-test the ideas and surface what could go wrong, without being a wet blanket.";

/**
 * The persona section, scaled by the session's persona dial. Low weight (the
 * 35 default) = sharp generalist whose specialty is one occasional lens; high
 * weight = today's stay-in-your-lane specialist.
 */
function personaSection(listing: AgentListing, weight: number): string[] {
  const p = listing.profile;
  const strengths = p?.strengths?.join(", ") || "your specialty";
  const loves = p?.loves?.join(", ") || "good work";
  const hates = p?.hates?.join(", ") || "sloppy work";
  const owner = getOwnerName();
  if (weight >= 70) {
    return [
      `You are ${listing.fullName}, a member of ${owner.full}'s AI team.`,
      listing.description ? `Your role: ${listing.description}` : "",
      `Your strengths: ${strengths}. You love ${loves}. You can't stand ${hates}.`,
      "In this session, speak primarily from your specialty. Stay in your lane; leave points outside it to the others.",
    ];
  }
  if (weight >= 40) {
    return [
      `You are ${listing.fullName}, a member of ${owner.full}'s AI team.`,
      listing.description ? `Your specialty: ${listing.description}` : "",
      `Your strengths: ${strengths}. You love ${loves}. You can't stand ${hates}.`,
      "In this session, your specialty and your general judgment carry equal weight. Speak beyond your lane whenever you have something useful.",
    ];
  }
  return [
    `You are ${listing.fullName}, a member of ${owner.full}'s AI team — and in this session, a sharp generalist first.`,
    listing.description
      ? `Your specialty (${listing.description}) is ONE lens you bring, not your job here. Let it color at most about a third of what you say.`
      : "",
    "Weigh in on anything: business, customers, cost, marketing, risk, timing. The best idea should win no matter whose lane it sits in. Do not force your specialty into every point.",
    `Your personality still shows: you love ${loves} and can't stand ${hates}.`,
  ];
}

function buildAgentSystemPrompt(
  listing: AgentListing,
  opts: {
    isSkeptic: boolean;
    wordLimit: number;
    personaWeight: number;
    extra?: string;
  }
): string {
  const lines = [
    ...personaSection(listing, opts.personaWeight),
    opts.extra ? `For THIS session, ${getOwnerName().first} adds: ${opts.extra}` : "",
    "",
    ...warRoomRules(opts.wordLimit),
  ];
  if (opts.isSkeptic) lines.push(SKEPTIC_LINE);
  return lines.filter(Boolean).join("\n");
}

function buildOutsiderSystemPrompt(
  member: RosterMember,
  session: WarRoomSession,
  isSkeptic: boolean
): string {
  const teammates = session.rosterMeta
    .filter((m) => m.name !== member.name)
    .map((m) => m.displayName)
    .join(", ");
  const owner = getOwnerName();
  const lines = [
    `You are ${member.displayName}, an outside consultant ${owner.full} brought into the team's live brainstorm specifically for fresh outside eyes.`,
    `The regulars in the room: ${teammates}. Claude Von Braun facilitates. You don't share their history or their assumptions — that distance is exactly your value. Say the things an insider wouldn't.`,
    member.extra ? `For THIS session, ${owner.first} adds: ${member.extra}` : "",
    "",
    ...warRoomRules(session.wordLimit),
  ];
  if (isSkeptic) lines.push(SKEPTIC_LINE);
  return lines.filter(Boolean).join("\n");
}

/**
 * Round jobs: Round 1 diverges, middle rounds challenge and build, the last
 * round converges on final positions — and explicitly does NOT write the
 * deliverable, which is CVB's job in synthesis.
 */
function roundInstruction(
  round: number,
  totalRounds: number,
  objective: string
): string {
  const first = getOwnerName().first;
  const isLast = round === totalRounds;
  if (round === 1 && isLast) {
    return `This is the only round. Give your most distinctive take on ${first}'s idea — the angle nobody else in the room would bring — and end with the one concrete recommendation you'd stake your name on, aimed at what ${first} asked for: ${objective}. Do NOT write the full deliverable itself; Claude Von Braun writes that after this round.`;
  }
  if (round === 1) {
    return `Opening round: DIVERGE. Give your most distinctive take on ${first}'s idea — aim for the angle nobody else in the room would bring. Fresh directions beat polish; don't worry about feasibility yet. Keep ${first}'s goal in view (${objective}) but do not try to answer it completely this round.`;
  }
  if (isLast) {
    return [
      "Final round: CONVERGE. Do NOT write the final deliverable, a summary, or a plan — that is Claude Von Braun's job after this round. Give exactly these, briefly:",
      "1) Your top pick from everything discussed (name it specifically).",
      "2) One line on why.",
      "3) Your single biggest concern with where the room is heading.",
      "4) If a piece of this is clearly yours to own, claim it in one line (otherwise skip this).",
    ].join("\n");
  }
  return "Middle round: CHALLENGE and BUILD. React to your teammates by name — push back where you disagree, or combine two ideas into something better. Add something new, or pass if you have nothing.";
}

interface AgentMessageContext {
  /** CVB's between-rounds steer, injected into the following round. */
  steer?: string;
  /** Shared vault background, injected in Round 1 only. */
  vault?: VaultContext | null;
  /** This member's angle card for the round (none in the converge round). */
  angle?: string | null;
  /** This member's private research notes. */
  notes?: string;
}

function buildAgentMessage(
  session: WarRoomSession,
  round: number,
  interjection: string,
  ctx: AgentMessageContext
): string {
  const transcript = buildTranscript(session);
  const parts = [
    `TOPIC (from ${getOwnerName().first}): ${session.idea}`,
    `OBJECTIVE we are driving toward: ${session.objective}`,
  ];
  if (ctx.vault && round === 1) {
    parts.push(
      "",
      "TEAM BACKGROUND (from the team's shared notes — use what's relevant, ignore what isn't):",
      ctx.vault.text
    );
  }
  if (ctx.notes) {
    parts.push(
      "",
      "YOUR PRIVATE RESEARCH NOTES (only you have these; bring the useful facts into the room):",
      ctx.notes
    );
  }
  if (transcript) {
    parts.push("", "CONVERSATION SO FAR:", transcript);
  }
  if (ctx.steer) {
    parts.push(
      "",
      `THE FACILITATOR (Claude Von Braun) JUST STEERED THE ROOM — take it seriously:`,
      ctx.steer
    );
  }
  if (interjection) {
    parts.push("", `${getOwnerName().first.toUpperCase()} JUST SAID: "${interjection}" — take this into account.`);
  }
  parts.push("", roundInstruction(round, session.rounds, session.objective));
  if (ctx.angle) {
    parts.push(
      "",
      `Your assigned angle this round (a lens to think through, not a straitjacket — drop it if it truly doesn't fit): ${ctx.angle}.`
    );
  }
  return parts.join("\n");
}

/** Pull the last assistant-message text out of a stream-json transcript line. */
function extractAssistantText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== "object") return null;
    if (obj.type !== "assistant" || !obj.message) return null;
    const content = obj.message.content;
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const c of content) {
      if (c && c.type === "text" && typeof c.text === "string") texts.push(c.text);
    }
    const joined = texts.join("\n").trim();
    return joined || null;
  } catch {
    return null;
  }
}

const SILENT_TOOLS = [
  "Task",
  "Bash",
  "Write",
  "Edit",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "NotebookEdit",
  "AskUserQuestion",
];

/** Research spawns may search the web; everything else stays blocked. */
const RESEARCH_ALLOWED = ["WebSearch", "WebFetch"];
const RESEARCH_BLOCKED = SILENT_TOOLS.filter(
  (t) => !RESEARCH_ALLOWED.includes(t)
);

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * If the session is paused, hold here (emitting "paused" status) until the owner
 * resumes, cancels, or wraps. Lets them read and type without the rounds racing
 * ahead. Returns when it's safe to continue.
 */
async function waitWhilePaused(id: string): Promise<void> {
  let s = getSessionSync(id);
  if (!s || !s.paused) return;
  setStatus(id, "paused", s.currentRound);
  while (true) {
    s = getSessionSync(id);
    if (!s) return;
    if (!s.paused || s.cancelRequested || s.wrapRequested) break;
    await delay(400);
  }
  const cur = getSessionSync(id);
  if (cur && !cur.cancelRequested && !cur.wrapRequested) {
    setStatus(id, "running", cur.currentRound);
  }
}

/** True when the CLI handed back a transient API error instead of a real reply.
 *  Those should never become a chat bubble — we retry, then skip the speaker. */
function looksLikeApiError(t: string): boolean {
  return /^\s*API Error|Overloaded|\brate.?limit|\b(429|500|503|529)\b|temporarily unavailable|please try again/i.test(
    t.slice(0, 200)
  );
}

interface SpawnTextOpts {
  model?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** One spawn: run an agent/CVB once and return its final assistant text (or null). */
async function spawnText(
  session: WarRoomSession,
  sys: string,
  message: string,
  opts: SpawnTextOpts = {}
): Promise<string | null> {
  const appCwd = path.join(getConfig().aiteamDir, "app");
  let text: string | null = null;
  const { child, exitPromise } = spawnClaude({
    cwd: appCwd,
    sessionId: randomUUID(),
    resume: false,
    message,
    model: opts.model ?? session.model,
    effort: opts.effort ?? session.effort,
    permissionMode: "acceptEdits",
    allowedTools: opts.allowedTools ?? [],
    disallowedTools: opts.disallowedTools ?? SILENT_TOOLS,
    appendSystemPrompt: sys,
  });
  registerChild(session.id, child);
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const t = extractAssistantText(line);
      if (t) text = t;
    }
  });
  await exitPromise;
  unregisterChild(session.id, child);
  if (buffer.trim()) {
    const t = extractAssistantText(buffer.trim());
    if (t) text = t;
  }
  return text;
}

/** Spawn with one retry on a transient API error. Returns clean text, or null
 *  if it never got a real reply (so the caller posts no bubble at all). */
async function spawnTextRetry(
  session: WarRoomSession,
  sys: string,
  message: string,
  attempts = 2,
  opts: SpawnTextOpts = {}
): Promise<string | null> {
  let text: string | null = null;
  for (let i = 0; i < attempts; i++) {
    if (getSessionSync(session.id)?.cancelRequested) return null;
    text = await spawnText(session, sys, message, opts);
    if (text && !looksLikeApiError(text)) return text;
    if (i < attempts - 1) await delay(4000);
  }
  return text && looksLikeApiError(text) ? null : text;
}

/** One OpenRouter reply with a single retry, mirroring spawnTextRetry. */
async function openRouterRetry(
  session: WarRoomSession,
  model: string,
  sys: string,
  message: string
): Promise<string | null> {
  const apiKey = getConfig().openrouterApiKey;
  if (!apiKey) return null;
  for (let i = 0; i < 2; i++) {
    if (getSessionSync(session.id)?.cancelRequested) return null;
    const text = await openRouterChat({ apiKey, model, system: sys, message });
    if (text) return text;
    if (i === 0) await delay(4000);
  }
  return null;
}

/**
 * A short, creative header label generated from the idea. Uses Sonnet (Haiku
 * tends to answer the brainstorm instead of titling it), with a guard that
 * rejects chatty/oversized replies so the UI can fall back to a clean snippet.
 */
async function generateTitle(session: WarRoomSession): Promise<string> {
  const sys =
    "You generate a single short title and nothing else. Output ONLY the title: 3 to 6 words, Title Case, no quotes, no preamble, no explanation, no trailing punctuation.";
  const msg = `Brainstorm topic: ${session.idea}\nDesired outcome: ${session.objective}\n\nReturn just the title:`;
  let t = "";
  try {
    t = (await spawnText(session, sys, msg, { model: "sonnet", effort: "low" })) || "";
  } catch {
    return "";
  }
  if (!t || looksLikeApiError(t)) return "";
  t =
    (t.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "")
      .replace(/\*+/g, "")
      .replace(/^[#>\s"']+/, "")
      .replace(/["'.\s]+$/, "")
      .trim();
  if (!t) return "";
  // Reject conversational / non-title replies; caller falls back to a snippet.
  if (/^(i['’ ]|here\b|sure\b|okay\b|ok\b|let\b|great\b|happy\b|absolutely\b|of course|certainly)/i.test(t))
    return "";
  if (t.split(/\s+/).length > 9 || t.length > 64) return "";
  return t;
}

async function runOneAgent(
  session: WarRoomSession,
  member: RosterMember,
  listing: AgentListing | null,
  round: number,
  interjection: string,
  ctx: AgentMessageContext & { isSkeptic: boolean }
): Promise<void> {
  emitTyping(session.id, member, true);
  const notes = getSessionSync(session.id)?.researchNotes?.[member.name];
  const message = buildAgentMessage(session, round, interjection, {
    ...ctx,
    notes,
  });
  let text: string | null = null;
  try {
    if (member.provider === "openrouter") {
      const sys = buildOutsiderSystemPrompt(member, session, ctx.isSkeptic);
      text = await openRouterRetry(session, member.model || "", sys, message);
    } else {
      if (!listing) return;
      const sys = buildAgentSystemPrompt(listing, {
        isSkeptic: ctx.isSkeptic,
        wordLimit: session.wordLimit,
        personaWeight: session.personaWeight,
        extra: member.extra,
      });
      text = await spawnTextRetry(session, sys, message, 2, {
        model: member.model,
      });
    }
  } finally {
    emitTyping(session.id, member, false);
  }

  // If the session was cancelled while we were waiting, drop the reply.
  if (getSessionSync(session.id)?.cancelRequested) return;

  if (text) {
    appendMessage(session.id, mkMessage("agent", member, text, round));
  }
}

// ---------------------------------------------------------------------------
// Research phases (private web research; notes never become bubbles)
// ---------------------------------------------------------------------------

function buildResearchSystemPrompt(displayName: string): string {
  return [
    `You are ${displayName}, doing PRIVATE prep research before a live team brainstorm.`,
    "Use web search to find concrete, current facts. Do not read or write files; use no tools other than web search and fetching pages.",
    "Output ONLY your research notes: 3 to 5 findings, each a single line with the concrete fact and where it came from (site or publication name). Numbers, competitors, prior art, recent developments.",
    "No opinions, no plan, no preamble. Under 140 words total.",
    "If you could not reach the web, say so in your first line and give your best from memory, clearly labeled as memory.",
  ].join("\n");
}

function buildResearchMessage(
  session: WarRoomSession,
  question: string | null
): string {
  const parts = [
    `TOPIC (from ${getOwnerName().first}): ${session.idea}`,
    `OBJECTIVE the team is driving toward: ${session.objective}`,
  ];
  if (question) {
    parts.push("", `YOUR ASSIGNED QUESTION — research this specifically: ${question}`);
  } else {
    parts.push(
      "",
      "Research whatever would most sharpen your contribution: the market, competitors, prior art, real numbers, recent developments."
    );
  }
  return parts.join("\n");
}

/**
 * Run one private research pass for every member concurrently. Claude members
 * get a tool-enabled spawn; outsiders go through OpenRouter's web plugin
 * (":online"), falling back to a plain call that answers from memory.
 */
async function runResearchPhase(
  session: WarRoomSession,
  questions: Map<string, string> | null
): Promise<void> {
  const id = session.id;
  await Promise.allSettled(
    session.rosterMeta.map(async (member) => {
      if (getSessionSync(id)?.cancelRequested) return;
      const question = questions?.get(member.name) ?? null;
      const message = buildResearchMessage(session, question);
      const sys = buildResearchSystemPrompt(member.displayName);
      emitTyping(id, member, true);
      let notes: string | null = null;
      try {
        if (member.provider === "openrouter") {
          const base = (member.model || "").replace(/:online$/, "");
          const apiKey = getConfig().openrouterApiKey;
          if (!apiKey || !base) return;
          notes = await openRouterChat({
            apiKey,
            model: `${base}:online`,
            system: sys,
            message,
          });
          if (!notes && !getSessionSync(id)?.cancelRequested) {
            notes = await openRouterChat({ apiKey, model: base, system: sys, message });
          }
        } else {
          notes = await spawnTextRetry(session, sys, message, 2, {
            model: member.model,
            effort: "medium",
            allowedTools: RESEARCH_ALLOWED,
            disallowedTools: RESEARCH_BLOCKED,
          });
        }
      } finally {
        emitTyping(id, member, false);
      }
      if (notes && !getSessionSync(id)?.cancelRequested) {
        addResearchNotes(id, member.name, notes);
      }
    })
  );
}

/**
 * For the midpoint research break: CVB assigns each member a DIFFERENT open
 * question from the discussion (five people googling the same thing converge
 * all over again). Falls back to a generic prompt per member on a parse miss.
 */
async function assignResearchQuestions(
  session: WarRoomSession
): Promise<Map<string, string>> {
  const live = getSessionSync(session.id) ?? session;
  const names = live.rosterMeta.map((m) => m.name).join(", ");
  const sys = [
    "You are Claude Von Braun, facilitating a team brainstorm. The team is about to break for a quick research sprint.",
    "From the discussion, pick the open questions that would most change the outcome if answered with real facts.",
    "Assign each person a DIFFERENT question. Output EXACTLY one line per person, formatted as 'name: question', using the names given. No other text.",
  ].join("\n");
  const message = [
    `TOPIC: ${live.idea}`,
    `OBJECTIVE: ${live.objective}`,
    "",
    "DISCUSSION SO FAR:",
    buildTranscript(live),
    "",
    `People (use these exact names, one line each): ${names}`,
  ].join("\n");

  const out = new Map<string, string>();
  const text = await spawnTextRetry(live, sys, message, 2, {
    model: "sonnet",
    effort: "medium",
  });
  if (text) {
    for (const line of text.split("\n")) {
      const m = /^\s*[-*]?\s*([a-z0-9_-]+)\s*[:—–-]\s*(.+)$/i.exec(line);
      if (!m) continue;
      const name = m[1].toLowerCase();
      if (live.rosterMeta.some((r) => r.name === name) && m[2].trim()) {
        out.set(name, m[2].trim());
      }
    }
  }
  const fallback =
    "Find real-world facts that confirm or challenge the direction the room is currently heading.";
  for (const member of live.rosterMeta) {
    if (!out.has(member.name)) out.set(member.name, fallback);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CVB facilitation: between-rounds steering and the closing tally
// ---------------------------------------------------------------------------

function steerSystem(): string {
  return [
    `You are Claude Von Braun, facilitating a live team brainstorm for ${getOwnerName().full}, a sharp business owner who is NOT a developer.`,
    "Plain English, no jargon. You do NOT contribute ideas of your own; you steer the room.",
    "Output, in under 120 words total, exactly three parts:",
    "1) 'Covered:' one line on what the room has now covered well.",
    "2) 'Unexplored:' the one or two most important angles nobody has touched.",
    "3) 'Push:' one pointed question for the next round — aim it at one or two specific people by first name if that helps.",
    "No preamble, no closing remarks.",
  ].join("\n");
}

async function runSteer(
  session: WarRoomSession,
  round: number
): Promise<string | null> {
  const live = getSessionSync(session.id) ?? session;
  const message = [
    `TOPIC: ${live.idea}`,
    `OBJECTIVE: ${live.objective}`,
    "",
    "DISCUSSION SO FAR:",
    buildTranscript(live),
    "",
    `Round ${round} of ${live.rounds} just ended. Steer the room for the next round.`,
  ].join("\n");
  emitTyping(session.id, FACILITATOR, true);
  try {
    return await spawnTextRetry(live, steerSystem(), message, 2, {
      model: "sonnet",
      effort: "medium",
    });
  } finally {
    emitTyping(session.id, FACILITATOR, false);
  }
}

function tallySystem(): string {
  return [
    "You are Claude Von Braun. A team brainstorm just ended with everyone stating final positions.",
    "Tally where the room landed, in under 110 words:",
    "- The leading idea or ideas, and who backed each (by first name).",
    "- Any real disagreement left standing.",
    "- The concerns that must not get lost.",
    `Plain English for ${getOwnerName().first}, a business owner. No preamble, no closing, and do not add your own opinion.`,
  ].join("\n");
}

async function runTally(session: WarRoomSession): Promise<string | null> {
  const live = getSessionSync(session.id) ?? session;
  const message = [
    `TOPIC: ${live.idea}`,
    `OBJECTIVE: ${live.objective}`,
    "",
    "THE FULL DISCUSSION (the last round holds everyone's final positions):",
    buildTranscript(live),
    "",
    "Tally where the room landed.",
  ].join("\n");
  emitTyping(session.id, FACILITATOR, true);
  try {
    return await spawnTextRetry(live, tallySystem(), message, 2, {
      model: "sonnet",
      effort: "medium",
    });
  } finally {
    emitTyping(session.id, FACILITATOR, false);
  }
}

// ---------------------------------------------------------------------------
// Synthesis and archival
// ---------------------------------------------------------------------------

function synthSystem(): string {
  const owner = getOwnerName();
  return [
    `You are Claude Von Braun, the orchestrator of ${owner.full}'s AI team, writing up the result of a War Room brainstorm.`,
    `${owner.first} is a sharp business owner, NOT a software developer.`,
    "Hard rules: plain English, full sentences, explain any technical term inline, no jargon, no abbreviations, no em-dashes, no AI cliches.",
    `THE MOST IMPORTANT RULE: deliver EXACTLY the outcome ${owner.first} asked for, in the exact shape it was asked for. Do not substitute your own format. If the ask was a list of five ideas with brief explanations, output exactly that: five ideas, each with a brief explanation, and nothing more. If the ask was a single plan, write a single plan. If the ask was a recommendation, give a recommendation. If the ask was a pros and cons table, give that. Never expand, collapse, reshape, or add sections beyond what was asked for. Match the requested outcome precisely.`,
  ].join("\n");
}

function buildSynthMessage(
  session: WarRoomSession,
  finalNote = "",
  tally = ""
): string {
  const transcript = session.messages
    .filter((m) => m.role !== "facilitator")
    .map((m) => `${m.displayName}: ${m.text}`)
    .join("\n\n");
  const first = getOwnerName().first;
  const parts = [
    `TOPIC (from ${first}): ${session.idea}`,
    `THE OUTCOME ${first.toUpperCase()} ASKED FOR (deliver EXACTLY this, in this exact shape): ${session.objective}`,
    "",
    "THE FULL DISCUSSION (raw material to draw from):",
    transcript,
  ];
  if (tally) {
    parts.push(
      "",
      "WHERE THE ROOM LANDED (the tally of final positions — give this real weight):",
      tally
    );
  }
  if (finalNote) {
    parts.push("", `${first.toUpperCase()}'S FINAL STEER (weight this heavily): ${finalNote}`);
  }
  parts.push(
    "",
    `Now produce exactly the outcome ${first} asked for: "${session.objective}". Draw on the discussion above as your source material. Plain English. Output ONLY that deliverable, with no preamble, no closing remarks, and no extra sections beyond what was asked.`
  );
  return parts.join("\n");
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "war-room"
  );
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Render the whole conversation as a readable markdown transcript. */
function buildTranscriptMarkdown(session: WarRoomSession): string {
  const lines: string[] = [];
  lines.push("# War Room transcript");
  lines.push("");
  lines.push(`**When:** ${new Date(session.createdAt).toISOString()}`);
  lines.push(`**Topic:** ${session.idea}`);
  lines.push(`**Outcome asked for:** ${session.objective}`);
  lines.push(
    `**Model:** ${session.model}  ·  **Pace:** ${session.pace}  ·  **Rounds:** ${session.rounds}  ·  **Persona strength:** ${session.personaWeight}  ·  **Research:** ${session.research}`
  );
  lines.push(
    `**In the room:** ${session.rosterMeta.map((m) => m.displayName).join(", ")}`
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const m of session.messages) {
    if (m.role === "facilitator" && /^Round \d/.test(m.text)) {
      lines.push("");
      lines.push(`## ${m.text}`);
      lines.push("");
      continue;
    }
    lines.push(`**${m.displayName}**`);
    lines.push("");
    lines.push(m.text);
    lines.push("");
  }
  const notes = session.researchNotes ?? {};
  const withNotes = session.rosterMeta.filter((m) => notes[m.name]);
  if (withNotes.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Private research notes");
    lines.push("");
    for (const m of withNotes) {
      lines.push(`### ${m.displayName}`);
      lines.push("");
      lines.push(notes[m.name]);
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Save a session to its own folder under vault/warroom/sessions/. Always writes
 * transcript.md; writes result.md too when there's a synthesized result.
 * Returns the folder path, or null if saving failed.
 */
async function saveSessionFolder(
  session: WarRoomSession,
  resultText: string | null
): Promise<string | null> {
  try {
    const base = path.join(getConfig().vaultDir, "warroom", "sessions");
    const folderName = `${todayStamp()}-${slugify(session.idea)}-${session.id.slice(0, 8)}`;
    const folder = path.join(base, folderName);
    await fsp.mkdir(folder, { recursive: true });

    await fsp.writeFile(
      path.join(folder, "transcript.md"),
      buildTranscriptMarkdown(session),
      "utf8"
    );

    if (resultText) {
      const frontmatter = [
        "---",
        `title: "War Room result: ${session.idea.replace(/"/g, "'")}"`,
        "type: warroom-result",
        `created: ${todayStamp()}`,
        `objective: "${session.objective.replace(/"/g, "'")}"`,
        `model: ${session.model}`,
        `pace: ${session.pace}`,
        `participants: [${session.roster.join(", ")}]`,
        "---",
        "",
      ].join("\n");
      await fsp.writeFile(
        path.join(folder, "result.md"),
        frontmatter + resultText + "\n",
        "utf8"
      );
    }
    return folder;
  } catch {
    return null;
  }
}

async function synthesize(
  session: WarRoomSession,
  finalNote = "",
  tally = ""
): Promise<void> {
  setStatus(session.id, "synthesizing");
  emitTyping(session.id, FACILITATOR, true);
  let text: string | null = null;
  try {
    text = await spawnTextRetry(
      session,
      synthSystem(),
      buildSynthMessage(session, finalNote, tally),
      2
    );
  } finally {
    emitTyping(session.id, FACILITATOR, false);
  }

  // Save the session folder now: transcript reflects the discussion, and
  // result.md carries the synthesized outcome (when we got one). We save BEFORE
  // appending the result bubble so the transcript stays the conversation, not
  // a copy of the result.
  const live = getSessionSync(session.id) ?? session;
  const folder = await saveSessionFolder(live, text);
  if (folder) setSavedPlanPath(session.id, folder);

  if (!text) {
    appendFacilitator(
      session.id,
      session.currentRound,
      folder
        ? `I couldn't generate the written result this time, but the full conversation is saved as transcript.md in:\n\n${folder}`
        : "I couldn't generate the written result this time. The conversation above is still here."
    );
    setStatus(session.id, "done");
    return;
  }

  appendFacilitator(session.id, session.currentRound, text);
  if (folder) {
    appendFacilitator(
      session.id,
      session.currentRound,
      `Saved to the vault:\n\n${folder}\n\n- result.md (the outcome you asked for)\n- transcript.md (the full conversation)`
    );
  }
  setStatus(session.id, "done");
}

// ---------------------------------------------------------------------------
// The session driver
// ---------------------------------------------------------------------------

async function runSession(id: string): Promise<void> {
  const session = getSessionSync(id);
  if (!session) return;
  const listings = listingCache.get(id);
  if (!listings) {
    setStatus(id, "failed");
    return;
  }
  setStarted(id);

  // Give the session a short, creative title for the header (best-effort).
  const title = await generateTitle(session);
  if (title) setTitle(id, title);

  // Vault grounding: cheap (no AI call), best-effort, shared by the whole room.
  let vault: VaultContext | null = null;
  try {
    vault = await buildVaultContext(session.idea, session.objective);
  } catch {
    vault = null;
  }

  const names = session.rosterMeta.map((m) => m.displayName).join(", ");
  appendFacilitator(
    id,
    0,
    `War Room is open. Topic: ${session.idea}\n\nWe're driving toward: ${session.objective}\n\nIn the room: ${names}. Let's go.`
  );
  if (vault && vault.notes.length > 0) {
    appendFacilitator(
      id,
      0,
      `I pulled ${vault.notes.length} related note${vault.notes.length === 1 ? "" : "s"} from the team vault as shared background:\n${vault.notes.map((n) => `- ${n.title}`).join("\n")}`
    );
  }

  // Opening research: everyone privately hits the web before anyone speaks.
  if (session.research !== "off") {
    await waitWhilePaused(id);
    const pre = getSessionSync(id);
    if (pre && !pre.cancelRequested && !pre.wrapRequested) {
      appendFacilitator(
        id,
        0,
        "Quiet start: everyone is off doing a few minutes of private research before they speak. Their notes stay private — watch what they bring to Round 1."
      );
      await runResearchPhase(session, null);
    }
  }

  // The midpoint research break lands after this round (0 = no midpoint).
  const midRound =
    session.research === "deep" && session.rounds >= 2
      ? Math.floor(session.rounds / 2)
      : 0;

  let steer = "";
  for (let round = 1; round <= session.rounds; round++) {
    let live = getSessionSync(id);
    if (!live || live.cancelRequested || live.wrapRequested) break;

    // Hold here if the owner paused. They read and type; we resume on their click.
    // Draining interjections AFTER the pause means anything they typed while
    // paused folds into this very round.
    await waitWhilePaused(id);
    live = getSessionSync(id);
    if (!live || live.cancelRequested || live.wrapRequested) break;

    setStatus(id, "running", round);

    const interjections = drainInterjections(id).join(" ");
    const label =
      round === 1
        ? `Round 1 of ${session.rounds} — first takes, everyone from a different angle.`
        : round === session.rounds
          ? `Round ${round} of ${session.rounds} (last) — final positions.`
          : `Round ${round} of ${session.rounds} — challenge and build.`;
    appendFacilitator(id, round, label);

    // The skeptic's hat rotates through the roster round by round.
    const skepticName =
      session.rosterMeta[(round - 1) % session.rosterMeta.length]?.name;
    // Angle cards decorrelate the room; none in the converge round. The *7
    // stride (coprime with the deck size) deals a different hand every round.
    const dealAngles = !(round === session.rounds && session.rounds > 1);

    // Fire the whole roster concurrently; bubbles pop in as each agent finishes.
    await Promise.allSettled(
      session.rosterMeta.map((member, i) => {
        const listing = listings.get(member.name) ?? null;
        const current = getSessionSync(id);
        const cards = angleCards();
        const angle = dealAngles ? cards[(i + (round - 1) * 7) % cards.length] : null;
        return runOneAgent(
          current ?? session,
          member,
          listing,
          round,
          interjections,
          {
            steer,
            vault,
            angle,
            isSkeptic: member.name === skepticName,
          }
        );
      })
    );

    let after = getSessionSync(id);
    if (!after || after.cancelRequested || after.wrapRequested) break;

    // Midpoint research break: CVB assigns each member a different open
    // question, then everyone researches privately before the next round.
    if (round === midRound) {
      const questions = await assignResearchQuestions(session);
      after = getSessionSync(id);
      if (!after || after.cancelRequested || after.wrapRequested) break;
      const assignments = session.rosterMeta
        .map((m) => `- ${m.displayName}: ${questions.get(m.name)}`)
        .join("\n");
      appendFacilitator(
        id,
        round,
        `Research break — everyone gets a different question so we don't all google the same thing:\n${assignments}`
      );
      await runResearchPhase(session, questions);
      after = getSessionSync(id);
      if (!after || after.cancelRequested || after.wrapRequested) break;
    }

    // Between rounds CVB actually facilitates: covered / unexplored / push.
    if (round < session.rounds) {
      const s = await runSteer(session, round);
      steer = s ?? "";
      if (s) appendFacilitator(id, round, s);
    }
  }

  // Last chance for the owner to weigh in before the write-up (covers single-round
  // Lightning sessions, where there's no later round to catch a pause).
  await waitWhilePaused(id);

  const final = getSessionSync(id);
  if (final?.cancelRequested) {
    const folder = await saveSessionFolder(final, null);
    if (folder) setSavedPlanPath(id, folder);
    appendFacilitator(
      id,
      final.currentRound,
      folder
        ? `Session cancelled. Transcript saved to:\n\n${folder}`
        : "Session cancelled."
    );
    setStatus(id, "cancelled");
    listingCache.delete(id);
    return;
  }

  // Tally where the room landed — only when the discussion ran its course
  // (an early wrap means there are no converge-round positions to tally).
  let tally = "";
  if (final && !final.wrapRequested) {
    tally = (await runTally(session)) ?? "";
    if (tally) {
      appendFacilitator(
        id,
        final.currentRound,
        `**Where the room landed**\n\n${tally}`
      );
    }
  }

  // Anything typed during the final pause shapes the deliverable too.
  const finalNote = drainInterjections(id).join(" ");
  appendFacilitator(
    id,
    final?.currentRound ?? session.rounds,
    "That's the discussion. Pulling it together into exactly what you asked for..."
  );
  await synthesize(getSessionSync(id) ?? session, finalNote, tally);
  listingCache.delete(id);
}
