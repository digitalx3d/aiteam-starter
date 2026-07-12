import { NotesBoard } from "@/components/notes-board";
import { listNotes } from "@/lib/notes";
import { decodeSlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProjectNotesPage({ params }: PageProps) {
  // See projects/[slug]/layout.tsx for why this decode has to happen here.
  const { slug: rawSlug } = await params;
  const slug = decodeSlug(rawSlug);
  const notes = await listNotes(slug);

  return (
    <div className="h-full overflow-y-auto">
      <NotesBoard slug={slug} initialNotes={notes} />
    </div>
  );
}
