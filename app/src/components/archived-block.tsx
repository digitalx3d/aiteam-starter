"use client";

import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, X } from "lucide-react";

export interface ArchivedTranscript {
  /** Full markdown of the archived transcript, straight from the vault
   *  (frontmatter included — stripped before rendering). */
  markdown: string;
  messageCount: number;
  vaultPath: string;
  /** epoch ms — when the archive was written. */
  endedAt: number;
}

const archiveMarkdownComponents: Components = {
  p: ({ ...props }) => <p className="my-2 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="list-disc pl-5 my-2 space-y-0.5" {...props} />,
  ol: ({ ...props }) => <ol className="list-decimal pl-5 my-2 space-y-0.5" {...props} />,
  li: ({ ...props }) => <li className="leading-relaxed" {...props} />,
  h1: ({ ...props }) => <h1 className="text-sm font-semibold mt-3 mb-1.5" {...props} />,
  h2: ({ ...props }) => <h2 className="text-sm font-semibold mt-3 mb-1.5" {...props} />,
  h3: ({ ...props }) => <h3 className="text-xs font-semibold mt-2 mb-1" {...props} />,
  strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
  em: ({ ...props }) => <em className="italic" {...props} />,
  blockquote: ({ ...props }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-foreground/70" {...props} />
  ),
  a: ({ ...props }) => (
    <a
      className="text-accent underline underline-offset-2 hover:opacity-80 break-all"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  table: ({ ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th className="border border-border px-2 py-1 text-left font-medium bg-muted-bg" {...props} />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
};

export function ArchivedBlock({
  archive,
  recapText,
  onDismiss,
}: {
  archive: ArchivedTranscript;
  recapText: string | null;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Frontmatter isn't meant for human eyes — same treatment as /api/chat/primer.
  const body = archive.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

  return (
    <div className="mx-3 sm:mx-6 my-2 rounded-md border border-border bg-background shadow-sm">
      {/* Sticky so the collapse/dismiss controls stay reachable while you scroll
       *  down through the expanded content (or the newer messages below it) —
       *  you shouldn't have to scroll all the way back up just to close this. */}
      {/* Solid background is load-bearing here, not cosmetic: once this bar is
       *  "stuck," the outer wrapper's own background no longer sits behind it
       *  (that box has scrolled elsewhere), so a translucent background lets
       *  message text scrolling underneath show straight through it. */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2 rounded-t-md bg-muted-bg border-b border-border/50">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground/80"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span>
            Previous conversation, archived ({archive.messageCount}{" "}
            {archive.messageCount === 1 ? "message" : "messages"})
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              confirm(
                "Dismiss this archived conversation from view? It's already saved — this only hides it here, it doesn't delete anything."
              )
            ) {
              onDismiss();
            }
          }}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted hover:text-error"
          title="Dismiss"
        >
          <X className="h-3 w-3" />
          <span>Dismiss</span>
        </button>
      </div>
      {expanded && (
        <div className="max-h-[50vh] overflow-y-auto px-3 py-2 opacity-80 border-b border-border/50">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={archiveMarkdownComponents}>
            {body}
          </ReactMarkdown>
        </div>
      )}
      <div className="px-3 py-2">
        {recapText ? (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1">
              Here&rsquo;s where we left off
            </div>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={archiveMarkdownComponents}>
              {recapText}
            </ReactMarkdown>
          </>
        ) : (
          <div className="text-xs text-muted italic">Generating a recap of where you left off...</div>
        )}
      </div>
    </div>
  );
}
