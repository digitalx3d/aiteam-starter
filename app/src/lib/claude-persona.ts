import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";
import { readOperatingRules, operatingRulesSection } from "./team-rules";

function cvbDir(): string {
  return path.join(getConfig().agentsDir, "claude");
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function rollingSummaryPath(scope: string): string {
  return path.join(
    getConfig().vaultDir,
    "agents",
    "claude",
    "summaries",
    `${safeScope(scope)}.md`
  );
}

export interface PersonaBuildOptions {
  /** When true, do not include the rolling summary. Used by the distillation
   *  call so the distilling Claude does not see its own past primer. */
  skipRollingSummary?: boolean;
  /** Chat scope identifier ("default" or "project:<slug>"). Required to look up
   *  the matching rolling summary; if omitted, no summary is included. */
  scope?: string;
}

/**
 * Build the chat persona's system prompt for a session.
 *
 * Layers (in order, concatenated with section separators):
 *   1. The persona's single definition file, agents/<slug>.md (body after the
 *      frontmatter) — identity, scope, limits, tools and procedure in one place
 *   2. The canonical team operating rules, injected from the vault
 *   3. (Optional) Project-specific override at <cwd>/.aiteam/agents/<slug>.md
 *   4. (Optional) Rolling primer from the previous session in this scope
 *
 * ONE definition file, deliberately. Until 2026-08-19 a chat persona was
 * assembled from soul.md + agents.md + tools.md while a DISPATCHED worker got
 * agents/<slug>.md instead, so the same teammate had two definitions that drifted
 * apart in wording. Worse, the worker's copy opened by telling the agent to go
 * read the other five files: measured across 280 worker sessions, 215 of them did
 * exactly that, pulling a median 18,000 characters of duplicate instruction into
 * context at turns three through seven, before any work began.
 *
 * Falls back to the old soul/agents/tools assembly when <slug>.md is absent, so a
 * persona that has not been consolidated still loads.
 *
 * Returns null if nothing was found (caller should skip the flag).
 */
/** Drop a leading YAML frontmatter block, if the file has one. */
function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

export async function buildVonBraunSystemPrompt(
  cwd: string,
  opts: PersonaBuildOptions = {}
): Promise<string | null> {
  const scope = opts.scope ?? "default";
  const agentsRoot = getConfig().agentsDir;
  const dir = cvbDir();
  const definition = await readMaybe(path.join(agentsRoot, "claude.md"));

  // Legacy layout: only read the split files when there is no single definition.
  const [soul, agents, tools] = definition
    ? [null, null, null]
    : await Promise.all([
        readMaybe(path.join(dir, "soul.md")),
        readMaybe(path.join(dir, "agents.md")),
        readMaybe(path.join(dir, "tools.md")),
      ]);

  if (!definition && !soul && !agents && !tools) return null;

  const projectOverride = await readMaybe(
    path.join(cwd, ".aiteam", "agents", "claude.md")
  );

  const rollingSummary =
    opts.scope && !opts.skipRollingSummary
      ? await readMaybe(rollingSummaryPath(opts.scope))
      : null;

  const operatingRules = await readOperatingRules();

  // Tell CVB exactly which chat he is in, so he never mistakes a project chat for
  // the main one. This is the fix for CVB claiming a project dispatch reports "to the
  // dashboard": his persona used to hardcode "you are the Dashboard session".
  const inProject = scope.startsWith("project:");
  const scopeName = inProject ? scope.slice("project:".length) : null;
  const wrongChatGuard = inProject
    ? `

**If a message is clearly about a different project, stop and ask which chat they mean. Do not answer it here.** The owner types into whichever chat happens to be open, and an answer here quietly files the whole exchange under ${scopeName}: it stays in this project's context, and the project it was actually about never sees it. One line is enough ("That reads like <other project>. Want me to take it there, or handle it here?"), and then wait. Exception: they may deliberately reference another project as context for ${scopeName} work, which is fine; the test is whether the WORK they are asking for belongs to ${scopeName}.`
    : "";
  const whereLine = inProject
    ? `You are running in **the ${scopeName} project chat** — cwd is the ${scopeName} project folder. Keep this conversation about ${scopeName}. When you dispatch a teammate for ${scopeName} work (with \`--project ${scopeName}\`), their report and your follow-up appear HERE, in this project chat, NOT in The Bridge.${wrongChatGuard}`
    : `You are running in **The Bridge** — the main, cross-project chat (cwd is the aiTeam app folder). This is for team-level and cross-project work. Anything specific to one project belongs in that project's own chat, and a project dispatch's report lands in that project's chat, not here.`;

  const sections: string[] = [];
  sections.push(`# Where you are right now\n\n${whereLine}`);
  if (definition) {
    // Strip the frontmatter: it configures the dispatch loader, not the prompt.
    sections.push("---\n\n" + stripFrontmatter(definition).trim());
  }
  if (soul) sections.push("---\n\n" + soul.trim());
  if (agents) sections.push("---\n\n" + agents.trim());
  if (tools) sections.push("---\n\n" + tools.trim());
  // Canonical team operating rules, injected from the single vault source so they
  // are always present and cannot drift across persona copies.
  if (operatingRules) {
    sections.push("---\n\n" + operatingRulesSection(operatingRules));
  }
  if (projectOverride) {
    sections.push(
      "---\n\n# Project-specific overrides for this chat\n\n" +
        projectOverride.trim()
    );
  }
  if (rollingSummary) {
    sections.push(
      "---\n\n# Rolling primer from your previous session in this scope\n\n" +
        "The following primer was distilled by you (CVB) from your last ended session in this same chat scope. " +
        "It is here so you walk in already oriented to what is in flight, decided, blocked, and open. " +
        "Treat it as fresh context from your immediate past self.\n\n" +
        rollingSummary.trim()
    );
  }

  return sections.join("\n\n");
}
