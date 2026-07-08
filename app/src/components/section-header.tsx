import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  /** Tailwind color class for the icon, e.g. "text-accent" or "text-accent-2". */
  iconClassName?: string;
  /** Optional right-aligned content (e.g. a "see all" link or status pill). */
  right?: ReactNode;
}

export function SectionHeader({
  icon: Icon,
  title,
  iconClassName = "text-accent",
  right,
}: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`h-4 w-4 ${iconClassName}`} />
      <h2 className="text-xs uppercase tracking-wide text-muted font-semibold">
        {title}
      </h2>
      {right && <div className="ml-auto flex items-center">{right}</div>}
    </div>
  );
}
