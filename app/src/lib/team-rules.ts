import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";

/**
 * Read the canonical team operating rules from vault/team/operating-rules.md
 * (voice, who-does-the-work, dispatch, task board, reporting).
 *
 * Injected into every agent's system prompt at spawn — CVB via claude-persona.ts,
 * workers via agents.ts — so the rules are GUARANTEED present from a single source.
 * This is what makes single-sourcing real: persona files no longer restate these
 * rules (they can't drift if there's only one copy, and it's always in context).
 *
 * Returns null if the file is missing (callers then fall back to persona text only).
 * Part of the agent-governance-lockdown project.
 */
export async function readOperatingRules(): Promise<string | null> {
  const p = path.join(getConfig().vaultDir, "team", "operating-rules.md");
  try {
    const raw = await fsp.readFile(p, "utf8");
    // Strip YAML frontmatter if present.
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return body || null;
  } catch {
    return null;
  }
}

/** Wrap the canonical rules as a clearly-labelled, authoritative prompt section. */
export function operatingRulesSection(rules: string): string {
  return (
    "# Team operating rules (canonical)\n\n" +
    "These are the single source of truth for how the team operates. " +
    "If any persona text conflicts with them, these win.\n\n" +
    rules
  );
}
