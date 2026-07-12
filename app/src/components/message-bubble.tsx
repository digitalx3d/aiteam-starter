"use client";

import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, ChevronDown, Circle, Check, X, AlertTriangle } from "lucide-react";
import { AgentAvatar } from "./agent-avatar";
import { useOwner } from "./owner-context";
import { ChatImage } from "./chat-image";
import { chatImageSrcToUrl } from "@/lib/chat-image-url";
import type { ChatMessage, ContentBlock, TraceEvent } from "@/lib/types";

// ---------------- Trace (terminal-style rendering of a turn's tool activity) ----------------

interface TurnSummary {
  cost?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function extractTurnSummary(events: TraceEvent[] | undefined): TurnSummary | null {
  if (!events || events.length === 0) return null;
  // Walk backwards — the `result` event is emitted last for a turn.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event as Record<string, unknown> | null;
    if (!ev || typeof ev !== "object") continue;
    if (ev.type !== "result") continue;
    const usage = (ev as { usage?: Record<string, unknown> }).usage ?? {};
    return {
      cost: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
      inputTokens:
        typeof usage.input_tokens === "number"
          ? (usage.input_tokens as number)
          : undefined,
      outputTokens:
        typeof usage.output_tokens === "number"
          ? (usage.output_tokens as number)
          : undefined,
      cacheReadTokens:
        typeof usage.cache_read_input_tokens === "number"
          ? (usage.cache_read_input_tokens as number)
          : undefined,
    };
  }
  return null;
}

function summarizeToolInput(input: unknown): string {
  if (typeof input === "string") return input.length > 80 ? input.slice(0, 77) + "..." : input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Prefer common identifier-style keys
    for (const key of ["file_path", "path", "command", "pattern", "url", "query"]) {
      if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
        const s = obj[key] as string;
        return s.length > 100 ? s.slice(0, 97) + "..." : s;
      }
    }
    // Fallback: shortened JSON
    const json = JSON.stringify(obj);
    if (json.length <= 80) return json;
    return json.slice(0, 77) + "...";
  }
  return "";
}

function ResultPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_LINES = 8;
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) {
    return (
      <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/75">
        {text}
      </pre>
    );
  }
  if (expanded) {
    return (
      <div>
        <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/75 max-h-72 overflow-auto">
          {text}
        </pre>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-[11px] text-muted hover:text-foreground/80 font-mono"
        >
          collapse
        </button>
      </div>
    );
  }
  return (
    <div>
      <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-foreground/75">
        {lines.slice(0, MAX_LINES).join("\n")}
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-1 text-[11px] text-muted hover:text-foreground/80 font-mono"
      >
        ... +{lines.length - MAX_LINES} more lines
      </button>
    </div>
  );
}

function ToolCallTrace({ call }: { call: Extract<ContentBlock, { kind: "tool_use" }> }) {
  const arg = summarizeToolInput(call.input);
  const hasResult = call.result !== undefined;
  const isError = call.resultIsError === true;

  return (
    <div className="py-1.5">
      <div className="flex items-baseline gap-2 font-mono text-xs">
        <Circle className="h-2 w-2 fill-current text-foreground/70 shrink-0 translate-y-0.5" />
        <div className="min-w-0">
          <span className="font-semibold">{call.name}</span>
          {arg && (
            <span className="text-muted">
              (<span className="text-foreground/80 break-all">{arg}</span>)
            </span>
          )}
          {!hasResult && (
            <span className="ml-2 text-muted">running...</span>
          )}
          {isError && <span className="ml-2 text-error">error</span>}
        </div>
      </div>
      {hasResult && (
        <div className="mt-1 ml-4 pl-3 border-l border-border">
          <ResultPreview text={call.result ?? ""} />
        </div>
      )}
    </div>
  );
}

function TurnSummaryFooter({ summary }: { summary: TurnSummary }) {
  const parts: string[] = [];
  if (typeof summary.durationMs === "number") {
    parts.push(`${(summary.durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof summary.cost === "number") {
    parts.push(`$${summary.cost.toFixed(4)}`);
  }
  if (
    typeof summary.inputTokens === "number" ||
    typeof summary.outputTokens === "number"
  ) {
    const i = summary.inputTokens ?? 0;
    const o = summary.outputTokens ?? 0;
    parts.push(`${i} in / ${o} out`);
  }
  if (typeof summary.cacheReadTokens === "number" && summary.cacheReadTokens > 0) {
    parts.push(`${summary.cacheReadTokens} cached`);
  }
  if (parts.length === 0) return null;
  return (
    <div className="pt-2 mt-2 border-t border-border/50 text-[11px] text-muted font-mono">
      {parts.join(" · ")}
    </div>
  );
}

function TraceDisclosure({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const toolCalls = message.blocks.filter(
    (b): b is Extract<ContentBlock, { kind: "tool_use" }> => b.kind === "tool_use"
  );
  const summary = extractTurnSummary(message.traceEvents);
  if (toolCalls.length === 0 && !summary) return null;

  const labelParts: string[] = [];
  if (toolCalls.length > 0) {
    labelParts.push(
      `${toolCalls.length} tool call${toolCalls.length > 1 ? "s" : ""}`
    );
  }
  if (summary?.durationMs !== undefined) {
    labelParts.push(`${(summary.durationMs / 1000).toFixed(1)}s`);
  }
  if (summary?.cost !== undefined) {
    labelParts.push(`$${summary.cost.toFixed(4)}`);
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-foreground/80 font-mono"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>trace · {labelParts.join(" · ")}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-tool-border bg-tool-bg/50 px-3 py-2">
          {toolCalls.length === 0 ? (
            <div className="text-[11px] text-muted font-mono py-1">
              No tool calls on this turn.
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {toolCalls.map((c, i) => (
                <ToolCallTrace key={`${c.id}-${i}`} call={c} />
              ))}
            </div>
          )}
          {summary && <TurnSummaryFooter summary={summary} />}
        </div>
      )}
    </div>
  );
}

function makeMarkdownComponents(projectSlug?: string | null): Components {
  return {
  p: ({ ...props }) => <p className="my-2 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="list-disc pl-5 my-2 space-y-0.5" {...props} />,
  ol: ({ ...props }) => <ol className="list-decimal pl-5 my-2 space-y-0.5" {...props} />,
  li: ({ ...props }) => <li className="leading-relaxed" {...props} />,
  code: ({ children, className, ...props }) => {
    // Inline code (no className means inline). Block code has language-* className.
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} font-mono text-xs`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="px-1 py-0.5 rounded bg-tool-bg border border-tool-border text-xs font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ ...props }) => (
    <pre
      className="my-2 p-3 bg-tool-bg border border-tool-border rounded-md overflow-x-auto text-xs"
      {...props}
    />
  ),
  h1: ({ ...props }) => <h1 className="text-base font-semibold mt-4 mb-2" {...props} />,
  h2: ({ ...props }) => <h2 className="text-sm font-semibold mt-3 mb-2" {...props} />,
  h3: ({ ...props }) => <h3 className="text-sm font-semibold mt-3 mb-1" {...props} />,
  h4: ({ ...props }) => <h4 className="text-sm font-medium mt-2 mb-1" {...props} />,
  a: ({ ...props }) => (
    <a className="underline hover:opacity-80" target="_blank" rel="noreferrer" {...props} />
  ),
  strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
  em: ({ ...props }) => <em className="italic" {...props} />,
  hr: ({ ...props }) => <hr className="my-3 border-border" {...props} />,
  blockquote: ({ ...props }) => (
    <blockquote
      className="border-l-2 border-border pl-3 my-2 text-foreground/75"
      {...props}
    />
  ),
  table: ({ ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th
      className="border border-border px-2 py-1 text-left font-medium bg-muted-bg"
      {...props}
    />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1 align-top" {...props} />,
  img: ({ src, alt }) => (
    <ChatImage
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      projectSlug={projectSlug}
    />
  ),
  };
}

// react-markdown's default urlTransform strips URLs whose protocol isn't
// http(s) / mailto / tel / etc. Windows absolute paths like
// `Z:\GitHub\<project>\chat-images\foo.png` get filtered to "" because `Z:`
// reads as an unknown protocol. We keep the safety net for anchors (so agent-
// emitted text can't sneak `javascript:` URLs into <a href>) but rewrite our
// own chat-images paths into served URLs before the default filter sees them.
const SAFE_PROTOCOL = /^(https?|mailto|tel|xmpp):/i;
function makeUrlTransform(projectSlug?: string | null) {
  return (url: string, key: string): string => {
    // For images we always pass through chatImageSrcToUrl, which handles
    // Windows absolute paths, relative chat-images/ paths, and HTTP(S).
    if (key === "src") return chatImageSrcToUrl(url, projectSlug);
    // For anchor hrefs, keep the safe-protocol filter intact.
    if (key === "href") {
      if (!url) return "";
      const colon = url.indexOf(":");
      if (colon < 0) return url; // relative / fragment / etc.
      if (SAFE_PROTOCOL.test(url.slice(0, colon + 1))) return url;
      return "";
    }
    return url;
  };
}

function MarkdownText({ text, projectSlug }: { text: string; projectSlug?: string | null }) {
  const components = useMemo(
    () => makeMarkdownComponents(projectSlug),
    [projectSlug]
  );
  const urlTransform = useMemo(
    () => makeUrlTransform(projectSlug),
    [projectSlug]
  );
  if (!text) return null;
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Full team-member names. Mirrors the static / registered persona last names from agents.ts.
// The human ("john" slug) comes from the owner-name config via OwnerProvider.
// Phase 2: when this list grows, refactor to a shared registry instead of duplicating.
const FULL_NAMES: Record<string, string> = {
  claude: "Claude Von Braun",
  maya: "Maya Solo",
  devin: "Devin McClane",
  casey: "Casey Ripley",
  indy: "Indy Brown",
  ethan: "Ethan Stark",
};

function displayName(message: ChatMessage, ownerFull: string): string {
  if (message.personaName) {
    const key = message.personaName.toLowerCase();
    if (key === "john") return ownerFull;
    return FULL_NAMES[key] ?? message.personaName;
  }
  if (message.role === "user") return ownerFull;
  if (message.role === "assistant") return FULL_NAMES.claude;
  return message.role;
}

// Map a chat-message role/persona to the corresponding team member's avatar config.
// Phase 2 will expand this when subagents (Maya/Devin/Casey) start posting in chat directly.
function avatarConfig(
  message: ChatMessage,
  ownerFirst: string
): {
  name: string;
  color: string;
  imageUrl: string;
} {
  if (message.role === "user") {
    return {
      name: ownerFirst,
      color: "purple",
      imageUrl: "/avatars/john.webp",
    };
  }
  // assistant — defaults to Claude (the orchestrator). When Maya/Devin/Casey post in chat, set personaName + we'll map here.
  const persona = (message.personaName ?? "claude").toLowerCase();
  const knownPersonas: Record<string, { color: string; imageUrl: string }> = {
    claude: { color: "cyan", imageUrl: "/avatars/claude.webp" },
    maya: { color: "blue", imageUrl: "/avatars/maya.webp" },
    devin: { color: "green", imageUrl: "/avatars/devin.webp" },
    casey: { color: "yellow", imageUrl: "/avatars/casey.webp" },
    indy: { color: "green", imageUrl: "/avatars/indy.webp" },
    ethan: { color: "red", imageUrl: "/avatars/ethan.webp" },
  };
  const cfg = knownPersonas[persona] ?? knownPersonas.claude;
  return {
    name: persona.charAt(0).toUpperCase() + persona.slice(1),
    color: cfg.color,
    imageUrl: cfg.imageUrl,
  };
}

function formatTime(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const sameYear = d.getFullYear() === today.getFullYear();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

function MessageHeader({ message }: { message: ChatMessage }) {
  const name = displayName(message, useOwner().full);
  const created = message.createdAt;
  return (
    <div className="flex items-baseline gap-2 mb-1">
      <span className="text-sm font-extrabold text-foreground/90 tracking-tight">
        {name}
      </span>
      {created !== undefined && (
        <span
          className="text-[11px] text-muted font-mono"
          title={new Date(created).toLocaleString()}
        >
          {formatTime(created, Date.now())}
        </span>
      )}
    </div>
  );
}

function Avatar({ message }: { message: ChatMessage }) {
  const cfg = avatarConfig(message, useOwner().first);
  return (
    <AgentAvatar
      name={cfg.name}
      color={cfg.color}
      imageUrl={cfg.imageUrl}
      size={44}
    />
  );
}

function ApprovalPanel({
  block,
  onApprove,
  onDeny,
}: {
  block: Extract<ContentBlock, { kind: "tool_use" }>;
  onApprove: (toolUseId: string) => void;
  onDeny: (toolUseId: string) => void;
}) {
  const arg = summarizeToolInput(block.input);
  const status = block.approvalStatus ?? "pending";

  if (status === "approved") {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <Check className="h-3 w-3 text-accent" />
        <span>
          Approved <span className="font-mono">{block.name}</span>
        </span>
      </div>
    );
  }
  if (status === "denied") {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        <X className="h-3 w-3 text-error" />
        <span>
          Denied <span className="font-mono">{block.name}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-accent-2/40 bg-accent-2/5 px-3 py-2">
      <div className="text-xs text-foreground/85">
        <span className="font-semibold font-mono">{block.name}</span> wants to run:
      </div>
      {arg && (
        <pre className="mt-1 text-[11px] font-mono text-foreground/75 whitespace-pre-wrap break-words bg-tool-bg/60 border border-tool-border rounded px-2 py-1 max-h-32 overflow-auto">
          {arg}
        </pre>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => onApprove(block.id)}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
        >
          <Check className="h-3 w-3" />
          <span>Approve</span>
        </button>
        <button
          type="button"
          onClick={() => onDeny(block.id)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground hover:border-foreground/30"
        >
          <X className="h-3 w-3" />
          <span>Deny</span>
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-muted">
        Approving will allow <span className="font-mono">{block.name}</span> for the rest of this session.
      </div>
    </div>
  );
}

function MessageBubbleInner({
  message,
  onApprove,
  onDeny,
  projectSlug,
}: {
  message: ChatMessage;
  onApprove?: (toolUseId: string) => void;
  onDeny?: (toolUseId: string) => void;
  projectSlug?: string | null;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="px-3 sm:px-6 py-2">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <div>
            {message.blocks.map((b, i) =>
              b.kind === "text" ? <div key={i}>{b.text}</div> : null
            )}
          </div>
        </div>
      </div>
    );
  }

  // Main chat shows only prose. Tool calls live in the Activity panel now.
  const textBlocks = message.blocks.filter((b) => b.kind === "text");
  const combinedText = textBlocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n\n").trim();
  const hasContent = combinedText.length > 0;

  // Approval prompts also need surfacing in the main chat, even with no text.
  const hasApprovalBlocks = message.blocks.some(
    (b) => b.kind === "tool_use" && b.needsApproval === true
  );

  // If a turn produced only tool calls (no text, no approval), suppress it — the activity panel covers it.
  // Also suppress while pending with no content yet — avoids the "thinking..." bubble flickering
  // on/off between tool calls and causing layout shift / scroll jumps.
  if (!hasContent && !hasApprovalBlocks) return null;

  // Never render the internal [Auto-notify] prompt vb-notifier injects to poke CVB.
  // It's plumbing (meant for CVB, not John) and would otherwise show as John's bubble.
  // Filtering here (not just at hydration) also clears any copy already cached locally.
  if (isUser && combinedText.startsWith("[Auto-notify]")) return null;

  const hasToolCalls = message.blocks.some((b) => b.kind === "tool_use");
  const showTrace =
    !isUser &&
    !message.pending &&
    (hasToolCalls || (message.traceEvents?.length ?? 0) > 0);

  // John's posts get a recessed (darker) background — a shade below the base, distinct from sidebars.
  // Claude's posts sit on the base. The two-level shift makes whose-post-is-whose obvious without bubbles.
  const rowBg = isUser ? "bg-user-bg" : "bg-background";

  return (
    <div
      className={
        "px-3 sm:px-6 py-3 sm:py-4 grid grid-cols-[44px_1fr] gap-2 sm:gap-3 border-b border-border/50 " +
        rowBg
      }
    >
      <Avatar message={message} />
      <div className="text-sm min-w-0">
        <MessageHeader message={message} />
        {hasContent && (
          // Both user and assistant now render through markdown so that pasted
          // images (![](path)) display inline as thumbnails for both sides.
          // User-typed single newlines are normalised to double so they survive
          // markdown's paragraph rules; this preserves the previous "Enter ==
          // new line" muscle memory.
          <MarkdownText
            text={
              isUser
                ? combinedText.replace(/(?<!\n)\n(?!\n)/g, "\n\n")
                : combinedText
            }
            projectSlug={projectSlug}
          />
        )}
        {!isUser &&
          onApprove &&
          onDeny &&
          message.blocks
            .filter(
              (b): b is Extract<ContentBlock, { kind: "tool_use" }> =>
                b.kind === "tool_use" && b.needsApproval === true
            )
            .map((b) => (
              <ApprovalPanel
                key={`approval-${b.id}`}
                block={b}
                onApprove={onApprove}
                onDeny={onDeny}
              />
            ))}
        {showTrace && <TraceDisclosure message={message} />}
      </div>
    </div>
  );
}

// Memoize so typing in the textarea doesn't re-render every bubble on every
// keystroke. Props (message ref, onApprove, onDeny) are stable across renders
// because the chat-store creates new message objects only on real change and
// the callbacks are wrapped in useCallback upstream.
export const MessageBubble = memo(MessageBubbleInner);
