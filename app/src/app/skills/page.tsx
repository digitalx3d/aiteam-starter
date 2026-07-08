import { discoverAllSkills } from "@/lib/skills";
import { SkillsBrowser } from "@/components/skills-browser";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const skills = await discoverAllSkills();

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
        <h1 className="text-lg font-semibold tracking-tight">Skills</h1>
        <p className="text-xs text-muted mt-0.5">
          {skills.length} skill{skills.length === 1 ? "" : "s"} across user,
          installed, plugin, and project locations. Click a card for the full
          SKILL.md.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        {skills.length === 0 ? (
          <div className="px-6 py-12 text-sm text-muted text-center">
            No skills found in any known location.
            <div className="mt-2 text-xs opacity-70">
              Expecting subdirectories that each contain a SKILL.md file.
            </div>
          </div>
        ) : (
          <SkillsBrowser skills={skills} />
        )}
      </div>
    </div>
  );
}
