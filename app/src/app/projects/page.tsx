import Link from "next/link";
import { Folder, GitBranch, Package, Sparkles } from "lucide-react";
import { discoverProjects, getProjectsRoot, type ProjectListing } from "@/lib/projects";
import { readHiddenProjects } from "@/lib/hidden-projects";
import { ProjectUnreadBadge } from "@/components/project-unread-badge";
import { NewProjectButton } from "@/components/new-project-button";
import { ManageProjectsButton } from "@/components/manage-projects-button";
import { HideProjectButton } from "@/components/hide-project-button";

export const dynamic = "force-dynamic";

function timeAgo(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function ProjectRow({ project }: { project: ProjectListing }) {
  return (
    // The hide button is a sibling of the Link (not nested inside it) so we
    // never put a <button> inside an <a>. The shared `group` drives its hover.
    <div className="flex items-stretch border-b border-border/50 hover:bg-muted-bg/40 transition-colors group">
      <Link
        href={`/projects/${encodeURIComponent(project.slug)}`}
        className="flex items-center gap-3 px-4 sm:px-5 py-3 min-w-0 flex-1"
      >
        <Folder className="h-4 w-4 text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground/90 truncate">
            {project.name}
          </div>
          {/* Path hidden on small screens — too long to be useful at 375px */}
          <div className="hidden sm:block text-xs text-muted truncate font-mono">
            {project.path}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-muted">
          <ProjectUnreadBadge slug={project.slug} />
          {project.hasGit && (
            <span title="git repo">
              <GitBranch className="h-3.5 w-3.5" />
            </span>
          )}
          {project.hasPackageJson && (
            <span title="npm package" className="hidden sm:inline">
              <Package className="h-3.5 w-3.5" />
            </span>
          )}
          {project.hasClaude && (
            <span title=".claude config" className="text-emerald-600 dark:text-emerald-400">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
        {/* Time stamp hidden on smallest screens */}
        <div className="hidden sm:block text-[11px] text-muted shrink-0 w-20 text-right font-mono">
          {timeAgo(project.modifiedMs)}
        </div>
      </Link>
      <HideProjectButton name={project.name} />
    </div>
  );
}

export default async function ProjectsPage() {
  const [projects, hiddenList] = await Promise.all([
    discoverProjects(),
    readHiddenProjects(),
  ]);
  const projectsRoot = getProjectsRoot();

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          <p className="text-xs text-muted mt-0.5 font-mono">
            Scanning {projectsRoot} · {projects.length} project
            {projects.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ManageProjectsButton initialHiddenCount={hiddenList.length} />
          <NewProjectButton />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="px-6 py-12 text-sm text-muted text-center">
            No projects found in{" "}
            <span className="font-mono">{projectsRoot}</span>.
            <div className="mt-2 text-xs opacity-70">
              Looking for directories with .git, .claude, or package.json.
            </div>
          </div>
        ) : (
          <div>
            {projects.map((p) => (
              <ProjectRow key={p.slug} project={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
