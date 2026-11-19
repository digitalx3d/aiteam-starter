"use client";

import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, BookOpen, Zap, Sparkles, Eye, Volume2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Parse "Confidence: high." or "Confidence: high for X; low for Y."
 * The line may be followed by an explanatory sentence on the same paragraph.
 * We only want the fragment immediately after "Confidence:".
 */
function parseConfidence(
  text: string,
): { level: "high" | "medium" | "low"; label: string } | null {
  if (!/^Confidence:\s/i.test(text)) return null;
  const afterColon = text.replace(/^Confidence:\s*/i, "");
  const firstClause = afterColon.replace(/\.\s+[A-Z].*$/, "").replace(/\.$/, "").trim();
  const raw = firstClause.toLowerCase();
  let level: "high" | "medium" | "low";
  if (raw.startsWith("high") && !raw.includes("medium") && !raw.includes("low")) {
    level = "high";
  } else if (raw.includes("low") || raw.includes("opinion")) {
    level = "low";
  } else {
    level = "medium";
  }
  return { level, label: firstClause };
}

const CONFIDENCE_BADGE: Record<string, string> = {
  high: "bg-emerald-900/40 text-emerald-300 border border-emerald-700/50",
  medium: "bg-yellow-900/40 text-yellow-300 border border-yellow-700/50",
  low: "bg-zinc-700/40 text-zinc-400 border border-zinc-600/50",
};

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-emerald-400",
  medium: "bg-yellow-400",
  low: "bg-zinc-500",
};

function isSourceLine(text: string): boolean {
  return /^Source:\s/.test(text.trim());
}

// ---------------------------------------------------------------------------
// Teammate chip
// ---------------------------------------------------------------------------

const TEAMMATE_COLORS: Record<string, string> = {
  Devin: "bg-blue-900/50 text-blue-300 border border-blue-700/50",
  Maya: "bg-purple-900/50 text-purple-300 border border-purple-700/50",
  Ethan: "bg-red-900/50 text-red-300 border border-red-700/50",
  Casey: "bg-teal-900/50 text-teal-300 border border-teal-700/50",
  Indy: "bg-orange-900/50 text-orange-300 border border-orange-700/50",
  Owner: "bg-amber-900/50 text-amber-300 border border-amber-700/50",
};

function TeammateChip({ name }: { name: string }) {
  const cls =
    TEAMMATE_COLORS[name] ??
    "bg-zinc-700/50 text-zinc-300 border border-zinc-600/50";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Text extraction from React children
// ---------------------------------------------------------------------------

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in (node as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extractText((node as any).props?.children ?? "");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Section color + icon config
// ---------------------------------------------------------------------------

type SectionIcon = "sparkles" | "eye" | "volume2" | "zap" | "none";

interface SectionTheme {
  /** CSS color value for the monogram number */
  color: string;
  /** Tailwind classes for the summary/header background tint */
  headerBg: string;
  /** Tailwind classes for summary text color */
  headerText: string;
  /** Which icon to show */
  icon: SectionIcon;
}

function getSectionTheme(sectionName: string): SectionTheme {
  const n = sectionName.toLowerCase();

  if (n.includes("new releases") || n.includes("what shipped")) {
    return {
      color: "#fb923c",
      headerBg: "bg-[#fb923c]/10 hover:bg-[#fb923c]/15",
      headerText: "text-[#fb923c]",
      icon: "sparkles",
    };
  }
  if (n.includes("worth watching")) {
    return {
      color: "#facc15",
      headerBg: "bg-[#facc15]/10 hover:bg-[#facc15]/15",
      headerText: "text-[#facc15]",
      icon: "eye",
    };
  }
  if (n.includes("overhyped")) {
    return {
      color: "#f87171",
      headerBg: "bg-[#f87171]/10 hover:bg-[#f87171]/15",
      headerText: "text-[#f87171]",
      icon: "volume2",
    };
  }
  if (n.includes("how we should apply") || n.includes("apply this")) {
    return {
      color: "#34d399",
      headerBg: "bg-[#34d399]/10 hover:bg-[#34d399]/15",
      headerText: "text-[#34d399]",
      icon: "zap",
    };
  }
  // Fallback: neutral
  return {
    color: "#6e6e6e",
    headerBg: "bg-[#6e6e6e]/10 hover:bg-[#6e6e6e]/15",
    headerText: "text-foreground",
    icon: "none",
  };
}

function SectionIconEl({ icon, color }: { icon: SectionIcon; color: string }) {
  const cls = "h-4 w-4 shrink-0";
  const style = { color };
  switch (icon) {
    case "sparkles":
      return <Sparkles className={cls} style={style} aria-hidden="true" />;
    case "eye":
      return <Eye className={cls} style={style} aria-hidden="true" />;
    case "volume2":
      return <Volume2 className={cls} style={style} aria-hidden="true" />;
    case "zap":
      return <Zap className={cls} style={style} aria-hidden="true" />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pre-processing: split markdown into sections
// ---------------------------------------------------------------------------

interface Finding {
  /** The ### heading line, e.g. "### 1. Anthropic acquires Stainless" */
  heading: string;
  /** Source lines extracted and moved to top */
  sourceLine: string | null;
  /** Confidence line if present */
  confidenceLine: string | null;
  /** All other body lines */
  bodyLines: string[];
}

interface DigestSection {
  name: string;
  /** Lines before the first ### (intro prose) */
  introProse: string;
  /** Numbered findings (### N. ...) broken out as cards */
  findings: Finding[];
  /** Raw section markdown (for non-finding sections like action / watch / overhyped that have no ### h3 findings) */
  rawContent: string;
  isActionSection: boolean;
}

function splitIntoSections(markdown: string): DigestSection[] {
  const lines = markdown.split("\n");
  const sections: DigestSection[] = [];
  let currentLines: string[] = [];
  let currentName = "";

  const flushSection = () => {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n");
    const section = buildSection(currentName, content);
    sections.push(section);
  };

  for (const line of lines) {
    const h2match = line.match(/^## (.+)/);
    if (h2match) {
      flushSection();
      currentLines = [line];
      currentName = h2match[1].trim();
    } else {
      currentLines.push(line);
    }
  }
  flushSection();
  return sections;
}

function buildSection(name: string, content: string): DigestSection {
  const isActionSection = /how we should apply/i.test(name);
  const lines = content.split("\n");

  // Split at h3 boundaries
  const hasFindings = lines.some((l) => /^###\s/.test(l));

  if (!hasFindings) {
    return { name, introProse: "", findings: [], rawContent: content, isActionSection };
  }

  // Collect intro prose (lines before first ###, after the ## header)
  const introLines: string[] = [];
  let firstH3Index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s/.test(lines[i])) {
      firstH3Index = i;
      break;
    }
    // Skip the ## header line itself from prose
    if (!/^## /.test(lines[i])) {
      introLines.push(lines[i]);
    }
  }

  const introProse = introLines.join("\n").trim();

  if (firstH3Index === -1) {
    return { name, introProse, findings: [], rawContent: content, isActionSection };
  }

  // Parse each ### block into a Finding
  const findings: Finding[] = [];
  let currentFindingLines: string[] = [];
  let currentHeading = "";

  const flushFinding = () => {
    if (!currentHeading) return;
    const finding = parseFinding(currentHeading, currentFindingLines);
    findings.push(finding);
    currentFindingLines = [];
    currentHeading = "";
  };

  for (let i = firstH3Index; i < lines.length; i++) {
    const line = lines[i];
    if (/^###\s/.test(line)) {
      flushFinding();
      currentHeading = line.replace(/^###\s+/, "").trim();
    } else {
      currentFindingLines.push(line);
    }
  }
  flushFinding();

  return { name, introProse, findings, rawContent: content, isActionSection };
}

function parseFinding(heading: string, lines: string[]): Finding {
  let sourceLine: string | null = null;
  let confidenceLine: string | null = null;
  const bodyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Source:\s/i.test(trimmed)) {
      sourceLine = trimmed;
    } else if (/^Confidence:\s/i.test(trimmed)) {
      confidenceLine = trimmed;
    } else {
      bodyLines.push(line);
    }
  }

  return { heading, sourceLine, confidenceLine, bodyLines };
}

// ---------------------------------------------------------------------------
// Component factories
// ---------------------------------------------------------------------------

/** Build a react-markdown Components map. */
function makeComponents(isActionSection: boolean, inFindingCard = false): Components {
  return {
    h1: ({ children: c }) => {
      const id = slugify(extractText(c));
      return (
        <h1
          id={id}
          className="text-2xl font-bold tracking-tight text-foreground mt-8 mb-3 leading-tight scroll-mt-4"
        >
          {c}
        </h1>
      );
    },

    h2: ({ children: c }) => {
      const text = extractText(c);
      const id = slugify(text);
      return (
        <h2
          id={id}
          className="text-lg font-semibold tracking-tight text-foreground mt-10 mb-4 pb-2 border-b border-border/50 flex items-center gap-2 scroll-mt-4"
        >
          {c}
        </h2>
      );
    },

    h3: ({ children: c }) => {
      const id = slugify(extractText(c));
      return (
        <h3
          id={id}
          className="text-base font-semibold text-foreground mb-2 leading-snug scroll-mt-4"
        >
          {c}
        </h3>
      );
    },

    h4: ({ children: c }) => (
      <h4 className="text-sm font-semibold text-foreground/90 mt-5 mb-1 scroll-mt-4">{c}</h4>
    ),

    p: ({ children: c }) => {
      const text = extractText(c);

      // Confidence badge — suppress inside finding cards (rendered separately)
      if (inFindingCard && parseConfidence(text)) return null;

      // Source citation — suppress inside finding cards (rendered separately)
      if (inFindingCard && isSourceLine(text)) return null;

      const conf = parseConfidence(text);
      if (conf) {
        return (
          <p className="my-3 flex items-center gap-2">
            <span className="text-xs text-muted font-medium">Confidence</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${CONFIDENCE_BADGE[conf.level]}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${CONFIDENCE_DOT[conf.level]}`} />
              {conf.label}
            </span>
          </p>
        );
      }

      // Source citation
      if (isSourceLine(text)) {
        return (
          <div className="my-4 flex items-start gap-2 pl-3 border-l-2 border-border/60">
            <BookOpen className="h-3 w-3 mt-0.5 shrink-0 text-muted" />
            <span className="text-xs text-muted leading-relaxed [&_a]:text-muted [&_a]:underline [&_a]:decoration-dotted [&_a:hover]:text-foreground/70">
              {c}
            </span>
          </div>
        );
      }

      return (
        <p className="my-3 leading-[1.7] text-foreground/90 max-w-[72ch]">{c}</p>
      );
    },

    ol: ({ children: c }) => {
      if (isActionSection) {
        return <ol className="my-4 space-y-3 list-none pl-0">{c}</ol>;
      }
      return <ol className="list-decimal pl-5 my-3 space-y-1">{c}</ol>;
    },

    li: ({ children: c }) => {
      if (isActionSection) {
        const text = extractText(c);
        const match = text.match(/\(([A-Z][a-z]+):/);
        const teammate = match && match[1] in TEAMMATE_COLORS ? match[1] : null;
        return (
          <li className="rounded-lg border border-border bg-card-bg p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm leading-[1.65] text-foreground/90 flex-1 [&_strong]:font-semibold [&_a]:text-accent [&_a:hover]:underline">
                {c}
              </div>
              {teammate && (
                <div className="shrink-0 mt-0.5">
                  <TeammateChip name={teammate} />
                </div>
              )}
            </div>
          </li>
        );
      }
      return <li className="leading-relaxed text-foreground/90">{c}</li>;
    },

    ul: ({ children: c }) => (
      <ul className="list-disc pl-5 my-3 space-y-1">{c}</ul>
    ),

    hr: () => (
      <div className="my-8 flex items-center gap-3" aria-hidden="true">
        <div className="flex-1 h-px bg-border/40" />
        <div className="w-1 h-1 rounded-full bg-border/60" />
        <div className="flex-1 h-px bg-border/40" />
      </div>
    ),

    a: ({ href, children: c }) => (
      <a
        href={href}
        className="text-accent hover:text-accent/80 underline decoration-accent/40 hover:decoration-accent inline-flex items-baseline gap-0.5 transition-colors"
        target="_blank"
        rel="noreferrer"
      >
        {c}
        <ExternalLink className="h-2.5 w-2.5 self-center ml-0.5 opacity-60 shrink-0" />
      </a>
    ),

    strong: ({ children: c }) => (
      <strong className="font-semibold text-foreground">{c}</strong>
    ),
    em: ({ children: c }) => (
      <em className="italic text-foreground/80">{c}</em>
    ),

    blockquote: ({ children: c }) => (
      <blockquote className="border-l-[3px] border-accent/50 pl-4 my-4 text-foreground/75 italic">
        {c}
      </blockquote>
    ),

    code: ({ children, className }) => {
      const isBlock =
        typeof className === "string" && className.startsWith("language-");
      if (isBlock) {
        return (
          <code className={`${className ?? ""} font-mono text-xs`}>
            {children}
          </code>
        );
      }
      return (
        <code className="px-1 py-0.5 rounded bg-tool-bg border border-tool-border text-xs font-mono">
          {children}
        </code>
      );
    },

    pre: ({ children: c }) => (
      <pre className="my-3 p-3 bg-tool-bg border border-tool-border rounded-md overflow-x-auto text-xs">
        {c}
      </pre>
    ),
  };
}

// ---------------------------------------------------------------------------
// Source citation sub-component (used inside finding cards at top)
// ---------------------------------------------------------------------------

function SourceCitation({ line }: { line: string }) {
  return (
    <div className="mb-3 flex items-start gap-2 pl-3 border-l-2 border-border/60">
      <BookOpen className="h-3 w-3 mt-0.5 shrink-0 text-muted" />
      <span className="text-xs text-muted leading-relaxed">
        <ReactMarkdown
          components={{
            p: ({ children: c }) => <span>{c}</span>,
            a: ({ href, children: c }) => (
              <a
                href={href}
                className="text-muted underline decoration-dotted hover:text-foreground/70 inline-flex items-baseline gap-0.5 transition-colors"
                target="_blank"
                rel="noreferrer"
              >
                {c}
                <ExternalLink className="h-2.5 w-2.5 self-center ml-0.5 opacity-60 shrink-0" />
              </a>
            ),
          }}
        >
          {line}
        </ReactMarkdown>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence badge sub-component (top-right corner of finding card)
// ---------------------------------------------------------------------------

function ConfidenceBadge({ line }: { line: string }) {
  const conf = parseConfidence(line);
  if (!conf) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${CONFIDENCE_BADGE[conf.level]}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${CONFIDENCE_DOT[conf.level]}`} />
      {conf.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Finding card
// ---------------------------------------------------------------------------

function FindingCard({ finding }: { finding: Finding }) {
  const bodyMarkdown = finding.bodyLines.join("\n").trim();
  const headingId = slugify(finding.heading);

  return (
    <div className="rounded-lg border border-border bg-card-bg shadow-sm overflow-hidden mb-4">
      {/* Card header: title + confidence badge */}
      <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-3">
        <h3
          id={headingId}
          className="text-base font-semibold text-foreground leading-snug scroll-mt-4 flex-1"
        >
          {/* Strip leading "N. " numbering */}
          {finding.heading.replace(/^\d+\.\s+/, "")}
        </h3>
        {finding.confidenceLine && (
          <div className="shrink-0 mt-0.5">
            <ConfidenceBadge line={finding.confidenceLine} />
          </div>
        )}
      </div>

      {/* Source citation — immediately under title */}
      {finding.sourceLine && (
        <div className="px-4 pb-1">
          <SourceCitation line={finding.sourceLine} />
        </div>
      )}

      {/* Body */}
      {bodyMarkdown && (
        <div className="px-4 pb-4">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={makeComponents(false, true)}
          >
            {bodyMarkdown}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section accordion
// ---------------------------------------------------------------------------

interface SectionAccordionProps {
  section: DigestSection;
  defaultOpen: boolean;
  index: number;
}

function SectionAccordion({ section, defaultOpen, index }: SectionAccordionProps) {
  const theme = getSectionTheme(section.name);
  const hasFindings = section.findings.length > 0;
  // Zero-padded two-digit index for the monogram
  const monogram = String(index).padStart(2, "0");

  return (
    <details
      open={defaultOpen || undefined}
      className="group mb-3 rounded-lg border border-border overflow-hidden"
    >
      {/* Summary / header — full breakout width, set by parent wrapper */}
      <summary
        className={`
          flex items-center gap-0 cursor-pointer select-none
          list-none [&::-webkit-details-marker]:hidden
          transition-colors
        `}
        style={{ padding: 0 }}
      >
        {/* Giant section number monogram — editorial left anchor */}
        <div
          className="shrink-0 flex items-center justify-center select-none"
          style={{
            width: "3.5rem",
            minHeight: "3rem",
            backgroundColor: `${theme.color}18`,
            borderRight: `1px solid ${theme.color}30`,
          }}
          aria-hidden="true"
        >
          <span
            className="font-black leading-none tracking-tighter tabular-nums"
            style={{
              fontSize: "1.75rem",
              color: theme.color,
              opacity: 0.7,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {monogram}
          </span>
        </div>

        {/* Header content */}
        <div
          className={`flex-1 flex items-center justify-between px-4 py-3 ${theme.headerBg} transition-colors min-w-0`}
        >
          <span
            className={`text-sm font-semibold tracking-tight ${theme.headerText} flex items-center gap-2 min-w-0`}
          >
            <SectionIconEl icon={theme.icon} color={theme.color} />
            <span className="truncate">{section.name}</span>
            {hasFindings && (
              <span className="text-[10px] font-normal opacity-60 ml-1 shrink-0">
                {section.findings.length} {section.findings.length === 1 ? "finding" : "findings"}
              </span>
            )}
          </span>
          {/* Chevron — rotates when open */}
          <svg
            className="h-4 w-4 opacity-60 transition-transform duration-200 group-open:rotate-180 shrink-0 ml-2"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </summary>

      {/* Accordion body — stays narrow for readability */}
      <div className="bg-background">
        <div className="max-w-3xl mx-auto px-6 py-4">
          {/* Intro prose (if any) */}
          {section.introProse && (
            <div className="mb-4">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={makeComponents(section.isActionSection)}
              >
                {section.introProse}
              </ReactMarkdown>
            </div>
          )}

          {/* Finding cards */}
          {hasFindings && section.findings.map((finding, i) => (
            <FindingCard key={i} finding={finding} />
          ))}

          {/* Fallback: render raw content for sections with no ### headings */}
          {!hasFindings && section.rawContent && (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={makeComponents(section.isActionSection)}
            >
              {/* Strip the ## header line — it's shown in the summary already */}
              {section.rawContent.replace(/^## .+\n?/, "")}
            </ReactMarkdown>
          )}
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Pre-digest header (intro prose above the accordions)
// ---------------------------------------------------------------------------

function DigestHeader({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");

  // Collect only up to the first ## section
  const firstH2 = lines.findIndex((l) => /^## /.test(l));
  const preambleLines = lines.slice(0, firstH2 === -1 ? lines.length : firstH2);
  const preamble = preambleLines.filter((l) => !/^# /.test(l) && !/^---/.test(l)).join("\n").trim();

  if (!preamble) return null;

  return (
    <div className="mb-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={makeComponents(false)}
      >
        {preamble}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface DigestRendererProps {
  children: string;
}

export const DigestRenderer = memo(function DigestRenderer({
  children,
}: DigestRendererProps) {
  if (!children) return null;

  const sections = useMemo(() => splitIntoSections(children), [children]);
  // Only accordion sections that start with ## (i.e., have a name)
  const accordionSections = sections.filter((s) => s.name);

  return (
    <div className="digest-body">
      {/* Preamble / intro prose above sections */}
      <DigestHeader markdown={children} />

      {/* Section accordions — break out of the prose column to 80vw */}
      <div
        className="digest-sections space-y-1"
        style={{
          width: "80vw",
          maxWidth: "1400px",
          minWidth: "min(100%, 480px)",
          position: "relative",
          left: "50%",
          transform: "translateX(-50%)",
        }}
      >
        {accordionSections.map((section, i) => (
          <SectionAccordion
            key={section.name || i}
            section={section}
            defaultOpen={i === 0}
            index={i}
          />
        ))}
      </div>
    </div>
  );
});
