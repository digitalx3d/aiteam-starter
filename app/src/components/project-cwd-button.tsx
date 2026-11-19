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
  const [failed, setFailed] = useState(false);
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

  // A silent catch here hid a real outage: the server was launching Explorer
  // onto a desktop nobody could see, and the click looked like a dead button.
  // Failures now say so instead of disappearing.
  const open = async () => {
    setFailed(false);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/open`, {
        method: "POST",
      });
      if (!res.ok) setFailed(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        title="Open in Windows Explorer"
        className="block text-[11px] text-muted mt-0.5 font-mono truncate text-left cursor-pointer hover:text-foreground hover:underline transition-colors"
      >
        {cwd}
      </button>
      {failed && (
        <span className="block text-[11px] text-error mt-0.5">
          Couldn&rsquo;t open that folder on this machine.
        </span>
      )}
    </>
  );
}
