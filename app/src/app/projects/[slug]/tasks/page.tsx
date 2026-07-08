import { TaskBoard } from "@/components/task-board";
import { listTasks } from "@/lib/tasks";
import { discoverAgents } from "@/lib/agents";
import { getOwnerName } from "@/lib/config";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProjectTasksPage({ params }: PageProps) {
  const { slug } = await params;
  const [tasks, agents] = await Promise.all([listTasks(slug), discoverAgents()]);
  const assigneeOptions = agents.map((a) => a.displayName);
  // Always include the human + a generic Unassigned slot.
  const ownerFirst = getOwnerName().first;
  if (!assigneeOptions.includes(ownerFirst)) assigneeOptions.unshift(ownerFirst);

  return (
    <div className="h-full overflow-y-auto">
      <TaskBoard
        slug={slug}
        initialTasks={tasks}
        assigneeOptions={assigneeOptions}
      />
    </div>
  );
}
