import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Folder } from "lucide-react";
import { resolveExistingProjectCwd, decodeSlug } from "@/lib/projects";
import { ProjectTabs } from "@/components/project-tabs";
import { ProjectBig3Card } from "@/components/project-big3-card";
import { ProjectCostCard } from "@/components/project-cost-card";
import { ProjectCwdButton } from "@/components/project-cwd-button";

export const dynamic = "force-dynamic";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}

export default async function ProjectLayout({ children, params }: LayoutProps) {
  // params.slug arrives still URL-encoded (e.g. "My%20Project"). Decode it
  // once here and pass the clean value to every child — they each re-encode
  // it exactly once when building hrefs/fetch URLs. Passing the raw encoded
  // value down caused double-encoding (404s) for any project name with a
  // space or other special character.
  const { slug: rawSlug } = await params;
  const slug = decodeSlug(rawSlug);
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) notFound();
  const name = slug;

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border">
        {/* Top row: project name + back link */}
        <div className="px-4 sm:px-6 pt-3 pb-2 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-muted mb-1">
              <Link
                href="/projects"
                className="inline-flex items-center gap-1 hover:text-foreground/80"
              >
                <ChevronLeft className="h-3 w-3" />
                Projects
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <Folder className="h-4 w-4 text-muted shrink-0" />
              <h1 className="text-lg font-semibold tracking-tight truncate">{name}</h1>
            </div>
            <ProjectCwdButton cwd={cwd} slug={slug} />
          </div>
        </div>

        {/* Cards row — stacks on mobile, side-by-side on wider screens */}
        <div className="px-4 sm:px-6 pb-2 flex flex-col sm:flex-row gap-2">
          <div className="w-full sm:w-[200px] shrink-0">
            <ProjectCostCard slug={slug} />
          </div>
          <div className="w-full sm:flex-1">
            <ProjectBig3Card slug={slug} />
          </div>
        </div>

        <div className="px-4 sm:px-6">
          <ProjectTabs slug={slug} />
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
