import { ChatSurface } from "@/components/chat-surface";
import { LiveFeed } from "@/components/live-feed";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProjectChatPage({ params }: PageProps) {
  const { slug } = await params;
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
