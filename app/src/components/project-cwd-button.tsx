"use client";

import { useEffect, useState } from "react";

interface Props {
  cwd: string;
  slug: string;
}

// "Open in Windows Explorer" only makes sense when the dashboard is being viewed
// on the host machine itself. Accessed remotely (e.g. over the Tailscale ts.net
// address), the folder would open on the host's monitor where nobody is looking,
// so we render the path as plain, non-interactive text instead.
function hostIsLocal(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

export function ProjectCwdButton({ cwd, slug }: Props) {
  // Start false so the server render and the first client render agree (no
  // hydration mismatch); upgrade to the interactive button after mount if local.
  const [isLocal, setIsLocal] = useState(false);
  useEffect(() => {
    setIsLocal(hostIsLocal());
  }, []);

  if (!isLocal) {
    return (
      <span
        title="Project folder (open it from the host machine)"
        className="block text-[11px] text-muted mt-0.5 font-mono truncate text-left"
      >
        {cwd}
      </span>
    );
  }

  const open = async () => {
    try {
      await fetch(`/api/projects/${encodeURIComponent(slug)}/open`, {
        method: "POST",
      });
    } catch {
      /* best effort */
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title="Open in Windows Explorer"
      className="block text-[11px] text-muted mt-0.5 font-mono truncate text-left cursor-pointer hover:text-foreground hover:underline transition-colors"
    >
      {cwd}
    </button>
  );
}
