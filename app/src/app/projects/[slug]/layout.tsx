import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Folder } from "lucide-react";
import { resolveExistingProjectCwd, decodeSlug } from "@/lib/projects";
import { ProjectTabs } from "@/components/project-tabs";
import { ProjectHeaderCards } from "@/components/project-header-cards";
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
        <div className="px-4 sm:px-6 pt-1 sm:pt-3 pb-1 sm:pb-2 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            {/* Phones fold the breadcrumb into a back arrow beside the name and
                drop the folder path (it opens Explorer on the host PC, which
                is no use from a phone), saving two lines of header. */}
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted mb-1">
              <Link
                href="/projects"
                className="inline-flex items-center gap-1 hover:text-foreground/80"
              >
                <ChevronLeft className="h-3 w-3" />
                Projects
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/projects"
                aria-label="Back to Projects"
                className="sm:hidden -ml-3 h-11 w-10 shrink-0 inline-flex items-center justify-center text-muted hover:text-foreground"
              >
                <ChevronLeft className="h-5 w-5" />
              </Link>
              <Folder className="hidden sm:block h-4 w-4 text-muted shrink-0" />
              <h1 className="text-lg font-semibold tracking-tight truncate">{name}</h1>
            </div>
            <div className="hidden sm:block">
              <ProjectCwdButton cwd={cwd} slug={slug} />
            </div>
          </div>
        </div>

        <ProjectHeaderCards slug={slug} />

        <div className="px-4 sm:px-6">
          <ProjectTabs slug={slug} />
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
