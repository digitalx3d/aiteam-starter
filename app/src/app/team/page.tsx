import Link from "next/link";
import { ChevronRight, CheckCircle2, Cpu } from "lucide-react";
import { discoverAgents, type AgentListing } from "@/lib/agents";
import { getOwnerName } from "@/lib/config";
import { AgentAvatar } from "@/components/agent-avatar";
import { WakeAgentButton } from "@/components/wake-agent-button";

export const dynamic = "force-dynamic";

function timeAgo(ms: number | null): string {
  if (!ms) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function firstSentence(text: string): string {
  if (!text) return "";
  const m = text.match(/^[^.!?]*[.!?]/);
  return (m ? m[0] : text).trim();
}

function ProfileRow({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="text-xs leading-tight flex gap-2">
      <span className="text-muted font-medium w-20 shrink-0">{label}</span>
      <span className="text-foreground/90 min-w-0">{items.join(" · ")}</span>
    </div>
  );
}

function ModelBadge({ model }: { model: string }) {
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wide text-muted font-mono"
      title="Default Claude model when this agent is dispatched (Haiku=fast/cheap · Sonnet=balanced · Opus=most capable)"
    >
      {model}
    </span>
  );
}

function RoleBadge({ role }: { role: "human" | "orchestrator" }) {
  const owner = getOwnerName();
  const label = role === "human" ? "Human" : "Orchestrator";
  const tooltip =
    role === "human"
      ? `${owner.first} is the team's owner and product lead — not an AI agent.`
      : `Claude is the parent Claude Code session that talks with ${owner.first} and dispatches the rest of the team. Not a Claude Code subagent.`;
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wide text-muted font-mono"
      title={tooltip}
    >
      {label}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentListing }) {
  const tagline = firstSentence(agent.description);
  return (
    <Link
      href={`/team/${encodeURIComponent(agent.name)}`}
      className="group flex flex-col gap-4 rounded-lg border border-border bg-background hover:bg-muted-bg/40 transition-colors p-5"
    >
      <div className="flex items-start gap-4">
        <AgentAvatar
          name={agent.displayName}
          color={agent.color}
          imageUrl={agent.avatarUrl}
          size={72}
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold tracking-tight">
            {agent.fullName}
          </h3>
          {tagline && (
            <p className="text-xs text-muted mt-0.5 leading-snug">{tagline}</p>
          )}
          {(agent.role || agent.model) && (
            <div className="mt-1.5">
              {agent.role ? (
                <RoleBadge role={agent.role} />
              ) : (
                agent.model && <ModelBadge model={agent.model} />
              )}
            </div>
          )}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2 mt-1">
          {!agent.role && <WakeAgentButton agentName={agent.name} />}
          <ChevronRight className="h-4 w-4 text-muted opacity-40 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
      {agent.profile && (
        <div className="space-y-1 border-t border-border/50 pt-3">
          <ProfileRow label="Strengths" items={agent.profile.strengths} />
          <ProfileRow label="Weaknesses" items={agent.profile.weaknesses} />
          <ProfileRow label="Loves" items={agent.profile.loves} />
          <ProfileRow label="Hates" items={agent.profile.hates} />
        </div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-muted pt-2 border-t border-border/50">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          {agent.completedCount} completed
        </span>
        <span className="inline-flex items-center gap-1">
          <Cpu className="h-3 w-3" />
          {agent.tools ? agent.tools.split(/[,\s]+/).filter(Boolean).length : 0}{" "}
          tools
        </span>
        <span className="ml-auto font-mono">{timeAgo(agent.lastActivityMs)}</span>
      </div>
    </Link>
  );
}

export default async function TeamPage() {
  const agents = await discoverAgents();

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <h1 className="text-lg font-semibold tracking-tight">Team</h1>
        <p className="text-xs text-muted mt-0.5">
          {agents.length} persona{agents.length === 1 ? "" : "s"} sourced from{" "}
          <code className="font-mono">~/.claude/agents/</code>
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6">
        {agents.length === 0 ? (
          <div className="text-sm text-muted text-center py-12">
            No agent personas found.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {agents.map((a) => (
              <AgentCard key={a.name} agent={a} />
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted/70 mt-6">
          Editing personas (rules, memories, voice) is a Phase 2 feature. Right
          now this is a read-only view of the source files in{" "}
          <code className="font-mono">~/.claude/agents/&lt;name&gt;/</code> and{" "}
          <code className="font-mono">~/.claude/agents/&lt;name&gt;.md</code>.
        </p>
      </div>
    </div>
  );
}
