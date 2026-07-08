import { ChatDrawer } from "@/components/chat-drawer";
import { DashboardCards } from "@/components/dashboard-cards";
import { LiveFeed } from "@/components/live-feed";

// Live dashboard — never statically prerendered (ChatDrawer reads search params).
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <h1 className="text-lg font-semibold tracking-tight">The Bridge</h1>
        <p className="text-xs text-muted mt-0.5">
          Your command post: cross-project priorities, your Big 5, and Claude Von Braun
          for anything team-wide. Project-specific talk lives in each project chat.
        </p>
      </header>
      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 relative overflow-hidden">
          <div className="absolute inset-0 overflow-y-auto">
            <DashboardCards />
          </div>
          <ChatDrawer />
        </main>
        {/* Live feed: always rendered for SSE connection, but hidden on mobile.
            The panel has its own open/closed toggle for desktop users. */}
        <div className="hidden md:flex">
          <LiveFeed />
        </div>
      </div>
    </div>
  );
}
