import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ChevronLeft,
  CheckCircle2,
  Cpu,
  FileText,
  Heart,
  Inbox,
  ScrollText,
  Sparkles,
  Wrench,
  Palette,
} from "lucide-react";
import { getAgentDetail } from "@/lib/agents";
import { getOwnerName } from "@/lib/config";
import { AgentAvatar } from "@/components/agent-avatar";
import { Markdown } from "@/components/markdown";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string }>;
}

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

function Section({
  title,
  icon: Icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-border bg-background overflow-hidden"
    >
      <summary className="cursor-pointer list-none flex items-center gap-2 px-4 py-3 border-b border-border/60 hover:bg-muted-bg/30">
        <Icon className="h-4 w-4 text-muted shrink-0" />
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-auto text-xs text-muted opacity-60 group-open:hidden">
          expand
        </span>
        <span className="ml-auto text-xs text-muted opacity-60 hidden group-open:inline">
          collapse
        </span>
      </summary>
      <div className="px-5 py-4">{children}</div>
    </details>
  );
}

export default async function AgentDetailPage({ params }: PageProps) {
  const { name } = await params;
  const agent = await getAgentDetail(name);
  if (!agent) notFound();

  const tagline = firstSentence(agent.description);

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <div className="flex items-center gap-2 text-xs text-muted mb-2">
          <Link
            href="/team"
            className="inline-flex items-center gap-1 hover:text-foreground/80"
          >
            <ChevronLeft className="h-3 w-3" />
            Team
          </Link>
        </div>
        <div className="flex items-start gap-4">
          <AgentAvatar
            name={agent.displayName}
            color={agent.color}
            imageUrl={agent.avatarUrl}
            size={84}
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">
              {agent.fullName}
            </h1>
            {tagline && (
              <p className="text-sm text-foreground/80 mt-1">{tagline}</p>
            )}
            {agent.role ? (
              <span
                className="inline-block mt-1.5 text-[10px] uppercase tracking-wide text-muted font-mono px-1.5 py-0.5 rounded border border-border"
                title={
                  agent.role === "human"
                    ? `${getOwnerName().first} is the team's owner and product lead — not an AI agent.`
                    : `Claude is the parent Claude Code session that talks with ${getOwnerName().first} and dispatches the rest of the team. Not a Claude Code subagent.`
                }
              >
                {agent.role === "human" ? "Human" : "Orchestrator"}
              </span>
            ) : (
              agent.model && (
                <span
                  className="inline-block mt-1.5 text-[10px] uppercase tracking-wide text-muted font-mono px-1.5 py-0.5 rounded border border-border"
                  title="Default Claude model when this agent is dispatched (Haiku=fast/cheap · Sonnet=balanced · Opus=most capable)"
                >
                  {agent.model}
                </span>
              )
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted mt-3">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {agent.completedCount} completed
              </span>
              {agent.tools && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <Cpu className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[12rem]">{agent.tools.split(/[,\s]+/).filter(Boolean).join(", ")}</span>
                </span>
              )}
              <span className="sm:ml-auto font-mono">
                last activity {timeAgo(agent.lastActivityMs)}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4 max-w-4xl">
        {agent.profile && (
          <div className="rounded-lg border border-border bg-muted-bg/30 px-5 py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted font-medium mb-1">
                  Strengths
                </div>
                <p className="text-sm text-foreground/85 leading-snug">
                  {agent.profile.strengths.join(" · ")}
                </p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted font-medium mb-1">
                  Weaknesses
                </div>
                <p className="text-sm text-foreground/85 leading-snug">
                  {agent.profile.weaknesses.join(" · ")}
                </p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted font-medium mb-1">
                  Loves
                </div>
                <p className="text-sm text-foreground/85 leading-snug">
                  {agent.profile.loves.join(" · ")}
                </p>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted font-medium mb-1">
                  Hates
                </div>
                <p className="text-sm text-foreground/85 leading-snug">
                  {agent.profile.hates.join(" · ")}
                </p>
              </div>
            </div>
          </div>
        )}

        {agent.files.soul && (
          <Section title="Voice & posture" icon={Heart}>
            <Markdown>{agent.files.soul}</Markdown>
          </Section>
        )}

        {agent.files.agents && (
          <Section title="Scope & responsibilities" icon={ScrollText}>
            <Markdown>{agent.files.agents}</Markdown>
          </Section>
        )}

        {agent.files.heartbeat && (
          <Section
            title="Heartbeat protocol"
            icon={Sparkles}
            defaultOpen={false}
          >
            <Markdown>{agent.files.heartbeat}</Markdown>
          </Section>
        )}

        {agent.files.tools && (
          <Section title="Tools & rules" icon={Wrench} defaultOpen={false}>
            <Markdown>{agent.files.tools}</Markdown>
          </Section>
        )}

        {agent.files.styleBrief && (
          <Section title="Style brief" icon={Palette} defaultOpen={false}>
            <Markdown>{agent.files.styleBrief}</Markdown>
          </Section>
        )}

        {agent.files.inbox && (
          <Section title="Inbox" icon={Inbox} defaultOpen={false}>
            <Markdown>{agent.files.inbox}</Markdown>
          </Section>
        )}

        {agent.files.completed && (
          <Section title="Completed work" icon={CheckCircle2} defaultOpen={false}>
            <Markdown>{agent.files.completed}</Markdown>
          </Section>
        )}

        {agent.subagentBody && (
          <Section title="Subagent prompt" icon={FileText} defaultOpen={false}>
            <Markdown>{agent.subagentBody}</Markdown>
          </Section>
        )}

        <p className="text-[11px] text-muted/70 pt-4">
          Source files: <code className="font-mono">~/.claude/agents/{agent.name}/*.md</code> and{" "}
          <code className="font-mono">~/.claude/agents/{agent.name}.md</code>. Editing
          is Phase 2 — change them on disk for now and refresh.
        </p>
      </div>
    </div>
  );
}
