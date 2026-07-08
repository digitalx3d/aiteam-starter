"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2 } from "lucide-react";

/**
 * Quick one-click hide for a project row. Sits beside the row's Link (not inside
 * it, to avoid nesting interactive elements). Hidden on desktop until the row is
 * hovered; faintly visible on touch where there's no hover.
 */
export function HideProjectButton({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function hide(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/projects/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, hidden: true }),
      });
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={hide}
      title={`Hide ${name}`}
      aria-label={`Hide ${name}`}
      className="shrink-0 w-10 flex items-center justify-center text-muted hover:text-error transition-all opacity-50 sm:opacity-0 sm:group-hover:opacity-100"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <EyeOff className="h-4 w-4" />
      )}
    </button>
  );
}
