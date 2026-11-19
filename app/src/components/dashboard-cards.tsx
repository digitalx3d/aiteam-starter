import Link from "next/link";
import {
  FolderKanban,
  Sparkles,
  Loader2,
  Target,
  MessageSquareText,
} from "lucide-react";
import { Big5Card } from "./big5-card";
import { MonthlySpendCards } from "./monthly-spend-cards";
import { ResearchCard } from "./research-card";
import { SectionHeader } from "./section-header";
import {
  getTopActiveProjects,
  type TopProjectCard,
  type CardItem,
} from "@/lib/dashboard-data";
import type { TaskPriority } from "@/lib/project-tasks";

function timeAgo(ms: number): string {
  if (!ms) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

const PRIORITY_DOT: Record<TaskPriority, string> = {
  high: "bg-error",
  medium: "bg-accent-2",
  low: "bg-muted/60",
};

const PRIORITY_TITLE: Record<TaskPriority, string> = {
  high: "high priority",
  medium: "medium priority",
  low: "low priority",
};

/** The little leading marker that tells the owner where an item came from. */
function ItemMarker({ item }: { item: CardItem }) {
  if (item.source === "big3") {
    return (
      <Target
        className="h-3 w-3 mt-0.5 shrink-0 text-accent-2/80"
        aria-label="Big 3"
      />
    );
  }
  if (item.source === "history") {
    return (
      <MessageSquareText
        className="h-3 w-3 mt-0.5 shrink-0 text-muted/70"
        aria-label="from recent discussion"
      />
    );
  }
  // task
  return (
    <span
      className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
        PRIORITY_DOT[item.priority ?? "medium"]
      }`}
      title={PRIORITY_TITLE[item.priority ?? "medium"]}
    />
  );
}

function ItemLine({ item }: { item: CardItem }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      <ItemMarker item={item} />
      <span
        className={
          "leading-snug flex-1 min-w-0 line-clamp-2 " +
          (item.blocked ? "text-muted line-through" : "text-foreground/85")
        }
      >
        {item.text}
      </span>
      {item.inProgress && (
        <Loader2
          className="h-3 w-3 mt-0.5 shrink-0 text-accent-2 animate-spin"
          aria-label="in progress"
        />
      )}
      {item.assignee && (
        <span className="text-[10px] text-muted shrink-0 mt-0.5 font-mono">
          {item.assignee}
        </span>
      )}
    </li>
  );
}

function ProjectCard({ project }: { project: TopProjectCard }) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.slug)}`}
      className="rounded-lg border border-border bg-card-bg p-4 flex flex-col shadow-lg shadow-black/30 hover:-translate-y-0.5 hover:border-border/80 transition-all"
    >
      <div className="flex items-center gap-2 mb-1">
        <FolderKanban className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold tracking-tight flex-1 truncate">
          {project.name}
        </h3>
        <span className="text-[10px] text-muted font-mono shrink-0">
          {timeAgo(project.activityMs)}
        </span>
      </div>
      <div className="h-px w-full bg-gradient-to-r from-accent via-accent/40 to-transparent mb-3" />
      {project.items.length === 0 ? (
        <div className="text-xs text-muted italic">
          {project.openTaskCount > 0
            ? "Open items on the board."
            : "Quiet here — nothing queued."}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {project.items.map((it, i) => (
            <ItemLine key={`${it.source}-${i}-${it.text.slice(0, 24)}`} item={it} />
          ))}
        </ul>
      )}
    </Link>
  );
}

export async function DashboardCards() {
  const projects = await getTopActiveProjects(4);

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6 space-y-6 bg-cards-bg min-h-full">
      <Big5Card />

      <MonthlySpendCards />

      <section>
        <SectionHeader icon={Sparkles} title="Top 4 projects" />
        {projects.length === 0 ? (
          <div className="rounded-lg border border-border bg-card-bg p-6 text-sm text-muted text-center">
            No project activity yet. Start a chat in any project, or create
            tasks under <code className="font-mono">.aiteam/tasks/</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((p) => (
              <ProjectCard key={p.slug} project={p} />
            ))}
          </div>
        )}
      </section>

      <ResearchCard />
    </div>
  );
}
