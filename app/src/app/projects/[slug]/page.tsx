import { ChatSurface } from "@/components/chat-surface";
import { LiveFeed } from "@/components/live-feed";
import { decodeSlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProjectChatPage({ params }: PageProps) {
  // See projects/[slug]/layout.tsx for why this decode has to happen here.
  const { slug: rawSlug } = await params;
  const slug = decodeSlug(rawSlug);
  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0">
        <ChatSurface projectSlug={slug} />
      </div>
      {/* Live feed hidden on mobile — too narrow to share space with chat */}
      <div className="hidden md:flex">
        <LiveFeed />
      </div>
    </div>
  );
}
