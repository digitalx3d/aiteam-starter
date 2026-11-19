import { discoverProjects, getProjectsRoot } from "@/lib/projects";
import { readHiddenProjects } from "@/lib/hidden-projects";
import { getProjectSignals } from "@/lib/project-signals";
import { NewProjectButton } from "@/components/new-project-button";
import { ManageProjectsButton } from "@/components/manage-projects-button";
import { ProjectRows } from "@/components/project-rows";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const [projects, hiddenList] = await Promise.all([
    discoverProjects(),
    readHiddenProjects(),
  ]);
  // Signals are cheap (dispatch tickets, task frontmatter, git) so they render
  // with the page. Spend and time come from the store via a client fetch —
  // see ProjectRows.
  const signals = await getProjectSignals(
    projects.map((p) => ({ slug: p.slug, cwd: p.path, hasGit: p.hasGit }))
  );
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
          <ProjectRows
            projects={projects.map((p) => ({
              slug: p.slug,
              name: p.name,
              path: p.path,
              modifiedMs: p.modifiedMs,
              hasGit: p.hasGit,
              hasPackageJson: p.hasPackageJson,
              hasClaude: p.hasClaude,
            }))}
            signals={signals}
          />
        )}
      </div>
    </div>
  );
}
