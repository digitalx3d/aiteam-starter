import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-muted mt-0.5">
          Where the app finds your projects, vault, agents, and the Claude
          binary. Defaults work for this machine; change them when moving to
          another machine or a fresh install.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <SettingsForm />
      </div>
    </div>
  );
}
