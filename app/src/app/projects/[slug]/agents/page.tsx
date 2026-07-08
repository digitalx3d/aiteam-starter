import { listTickets } from "@/lib/dispatch-store";
import { discoverAgents } from "@/lib/agents";
import { ProjectAgents } from "@/components/project-agents";
import { decodeSlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// How many recently-finished dispatches to seed on load. The client hides any
// older than its linger window, so this is just an upper bound on the payload.
const MAX_FINISHED_SEED = 20;

export default async function ProjectAgentsPage({ params }: PageProps) {
  // Decode once here: ticket.project is stored decoded (e.g. "Peg Slideshow"),
  // so comparing it against the raw encoded params.slug below would silently
  // never match for project names with spaces or other special characters.
  const { slug: rawSlug } = await params;
  const slug = decodeSlug(rawSlug);
  const [allTickets, agents] = await Promise.all([
    listTickets(),
    discoverAgents(),
  ]);

  const projectTickets = allTickets.filter((t) => t.project === slug);
  const open = projectTickets.filter(
    (t) => t.status === "queued" || t.status === "running"
  );
  // listTickets() is newest-first, so slice takes the most recent finished ones.
  // The client filters these to its linger window — we deliberately avoid reading
  // the clock here (server-render purity rule).
  const finished = projectTickets
    .filter((t) => t.status !== "queued" && t.status !== "running")
    .slice(0, MAX_FINISHED_SEED);
  const initialTickets = [...open, ...finished];

  const agentMeta = agents.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    color: a.color,
    avatarUrl: a.avatarUrl,
  }));

  return (
    <div className="h-full overflow-y-auto">
      <ProjectAgents
        slug={slug}
        initialTickets={initialTickets}
        agents={agentMeta}
      />
    </div>
  );
}
