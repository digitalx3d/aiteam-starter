"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Swords,
  Send,
  Loader2,
  CheckCircle2,
  Square,
  Sparkles,
  ArrowDown,
  Pause,
  Play,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { AgentAvatar } from "./agent-avatar";

interface RosterMember {
  name: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
}

interface WarRoomMessage {
  id: string;
  role: "facilitator" | "agent" | "human";
  agent: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
  text: string;
  round: number;
  ts: number;
}

type Status =
  | "running"
  | "paused"
  | "synthesizing"
  | "done"
  | "cancelled"
  | "failed"
  | "idle";

const MD_COMPONENTS: Components = {
  p: ({ ...p }) => <p className="my-1.5 leading-relaxed" {...p} />,
  ul: ({ ...p }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...p} />,
  ol: ({ ...p }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...p} />,
  li: ({ ...p }) => <li className="leading-relaxed" {...p} />,
  h1: ({ ...p }) => <h1 className="text-sm font-bold mt-3 mb-1" {...p} />,
  h2: ({ ...p }) => <h2 className="text-sm font-bold mt-3 mb-1" {...p} />,
  h3: ({ ...p }) => <h3 className="text-sm font-semibold mt-2 mb-1" {...p} />,
  strong: ({ ...p }) => <strong className="font-semibold" {...p} />,
  em: ({ ...p }) => <em className="italic" {...p} />,
  code: ({ ...p }) => (
    <code
      className="px-1 py-0.5 rounded bg-tool-bg border border-tool-border text-xs font-mono"
      {...p}
    />
  ),
  a: ({ ...p }) => (
    <a className="underline hover:opacity-80" target="_blank" rel="noreferrer" {...p} />
  ),
  hr: ({ ...p }) => <hr className="my-2 border-border" {...p} />,
};

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A short facilitator "Round N" line renders as a centered divider, not a bubble. */
function isRoundDivider(m: WarRoomMessage): boolean {
  return m.role === "facilitator" && /^Round \d/.test(m.text);
}

function RoundDivider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 my-4 px-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[11px] uppercase tracking-wider text-muted font-semibold shrink-0">
        {text}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Bubble({ m }: { m: WarRoomMessage }) {
  const isHuman = m.role === "human";
  return (
    <div
      className={
        "flex items-start gap-2.5 max-w-[88%] " +
        (isHuman ? "ml-auto flex-row-reverse" : "")
      }
    >
      <div className="shrink-0 mt-0.5">
        <AgentAvatar
          name={m.displayName}
          color={m.color}
          imageUrl={m.avatarUrl}
          size={34}
        />
      </div>
      <div className="min-w-0">
        <div
          className={
            "flex items-baseline gap-2 mb-0.5 " + (isHuman ? "justify-end" : "")
          }
        >
          <span className="text-xs font-bold text-foreground/90 tracking-tight">
            {m.displayName}
          </span>
        </div>
        <div
          className={
            "rounded-2xl px-3.5 py-2 " +
            (isHuman
              ? "bg-accent text-accent-fg rounded-tr-sm"
              : m.role === "facilitator"
                ? "bg-muted-bg/60 border border-border rounded-tl-sm"
                : "bg-card-bg border border-border rounded-tl-sm")
          }
        >
          <Markdown text={m.text} />
        </div>
      </div>
    </div>
  );
}

function TypingBubble({ m }: { m: RosterMember }) {
  return (
    <div className="flex items-start gap-2.5 max-w-[88%]">
      <div className="shrink-0 mt-0.5">
        <AgentAvatar
          name={m.displayName}
          color={m.color}
          imageUrl={m.avatarUrl}
          size={34}
        />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-bold text-foreground/60 tracking-tight mb-0.5">
          {m.displayName}
        </div>
        <div className="rounded-2xl rounded-tl-sm px-3.5 py-2.5 bg-card-bg border border-border inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted/70 animate-bounce [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted/70 animate-bounce [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted/70 animate-bounce" />
        </div>
      </div>
    </div>
  );
}

const MODELS = [
  { value: "opus", label: "Opus (deepest, default)" },
  { value: "sonnet", label: "Sonnet (faster, cheaper)" },
  { value: "haiku", label: "Haiku (quick / trivial)" },
];

const PACES = [
  { value: "lightning", label: "⚡ Lightning", desc: "~60 words · faster thinking" },
  { value: "standard", label: "Standard", desc: "~120 words · balanced" },
  { value: "deep", label: "🔎 Deep", desc: "longer · deepest thinking" },
];

const RESEARCH_OPTIONS = [
  { value: "off", label: "Off", desc: "straight to talking" },
  {
    value: "opening",
    label: "🔍 Research first",
    desc: "private web research before Round 1",
  },
  {
    value: "deep",
    label: "🔍 + Midpoint",
    desc: "opening research plus a mid-session break",
  },
] as const;

type ResearchValue = (typeof RESEARCH_OPTIONS)[number]["value"];

interface OutsiderRow {
  key: string;
  displayName: string;
  model: string;
  enabled: boolean;
  /** The custom row lets John type both the name and the model id. */
  customName?: boolean;
}

// Preset outside consultants. Model IDs are editable in the form — providers
// rename models faster than we ship, so nothing is locked in.
const OUTSIDER_PRESETS: OutsiderRow[] = [
  { key: "chatgpt", displayName: "ChatGPT (OpenAI)", model: "openai/gpt-5.1", enabled: false },
  { key: "gemini", displayName: "Gemini (Google)", model: "google/gemini-3-pro-preview", enabled: false },
  { key: "grok", displayName: "Grok (xAI)", model: "x-ai/grok-4", enabled: false },
  { key: "custom", displayName: "", model: "", enabled: false, customName: true },
];

const AGENT_MODELS = [
  { value: "", label: "Room default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function personaLabel(w: number): string {
  if (w < 40) return "Generalists first — specialty is one lens among many";
  if (w < 70) return "Balanced — specialty and general judgment weigh equally";
  return "Specialists — everyone stays in their lane";
}

// Remembers the active session so navigating away and back rejoins it live.
const ACTIVE_KEY = "aiteam.warroom.active";

// Short fallback header label shown until the AI title arrives. Never the full
// prompt — just the first sentence, clipped, so the header always reads clean.
function shortTitle(idea?: string): string {
  if (!idea) return "War Room";
  const first = idea.split(/(?<=[.?!])\s/)[0] || idea;
  const words = first.trim().split(/\s+/);
  let s = words.slice(0, 9).join(" ");
  if (words.length > 9) s += "…";
  return s.length > 70 ? s.slice(0, 70).trim() + "…" : s;
}

export function WarRoom() {
  const [phase, setPhase] = useState<"setup" | "live">("setup");

  // setup form
  const [idea, setIdea] = useState("");
  const [objective, setObjective] = useState("");
  const [model, setModel] = useState("opus");
  const [rounds, setRounds] = useState(3);
  const [pace, setPace] = useState("standard");
  const [workers, setWorkers] = useState<RosterMember[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [personaWeight, setPersonaWeight] = useState(35);
  const [research, setResearch] = useState<ResearchValue>("off");
  const [agentConfig, setAgentConfig] = useState<
    Record<string, { model: string; extra: string }>
  >({});
  const [showFineTune, setShowFineTune] = useState(false);
  const [orConfigured, setOrConfigured] = useState(false);
  const [outsiders, setOutsiders] = useState<OutsiderRow[]>(() =>
    OUTSIDER_PRESETS.map((p) => ({ ...p }))
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // live session
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    idea: string;
    objective: string;
    rounds: number;
    title: string;
  } | null>(null);
  const [messages, setMessages] = useState<WarRoomMessage[]>([]);
  const [typing, setTyping] = useState<RosterMember[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [currentRound, setCurrentRound] = useState(0);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [interject, setInterject] = useState("");
  // True between clicking Pause and the engine actually holding (round in flight).
  const [pauseReq, setPauseReq] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pinned-to-bottom tracking for smart auto-scroll.
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // On mount, rejoin a remembered session if it still exists on the server.
  // This is what makes navigating away and back not lose the conversation.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ACTIVE_KEY);
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/warroom/${saved}`);
        if (!res.ok) {
          window.localStorage.removeItem(ACTIVE_KEY);
          return;
        }
        if (cancelled) return;
        // The SSE effect connects on sessionId and replays the whole transcript.
        setSessionId(saved);
        setPhase("live");
      } catch {
        /* stay on the setup form */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the worker roster for the setup checkboxes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agents");
        if (!res.ok) return;
        const data = (await res.json()) as {
          agents?: Array<{
            name: string;
            fullName?: string;
            displayName: string;
            color: string;
            avatarUrl: string | null;
            role?: string;
          }>;
        };
        if (cancelled || !Array.isArray(data.agents)) return;
        const ws = data.agents
          .filter((a) => !a.role) // workers have no static role (john/claude do)
          .map((a) => ({
            name: a.name,
            displayName: a.fullName || a.displayName,
            color: a.color,
            avatarUrl: a.avatarUrl,
          }));
        setWorkers(ws);
        setSelected(new Set(ws.map((w) => w.name)));
      } catch {
        /* ignore — engine falls back to its default roster */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Is OpenRouter configured? Gates the outside-consultants section.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/warroom/config");
        if (!res.ok) return;
        const data = (await res.json()) as { openrouterConfigured?: boolean };
        if (!cancelled) setOrConfigured(Boolean(data.openrouterConfigured));
      } catch {
        /* section stays gated */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-follow the conversation, but ONLY when the reader is already at the
  // bottom. The moment they scroll up to read, we stop yanking them down.
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  // Track whether the reader is pinned to the bottom. Crossing ~80px from the
  // bottom turns auto-follow off and reveals the "jump to latest" button.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  };

  // SSE subscription for the live session.
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/warroom/${sessionId}/stream`);
    es.onmessage = (ev) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const type = data.type as string;
      if (type === "init") {
        setMeta({
          idea: data.idea as string,
          objective: data.objective as string,
          rounds: data.rounds as number,
          title: (data.title as string) ?? "",
        });
      } else if (type === "title") {
        const t = (data.title as string) ?? "";
        setMeta((prev) => (prev ? { ...prev, title: t } : prev));
      } else if (type === "message") {
        const msg = data.message as WarRoomMessage;
        setMessages((prev) =>
          prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]
        );
        // An arrived message clears that agent's typing indicator.
        setTyping((prev) => prev.filter((t) => t.name !== msg.agent));
      } else if (type === "typing") {
        const member: RosterMember = {
          name: data.agent as string,
          displayName: data.displayName as string,
          color: data.color as string,
          avatarUrl: (data.avatarUrl as string | null) ?? null,
        };
        const on = data.on as boolean;
        setTyping((prev) => {
          const without = prev.filter((t) => t.name !== member.name);
          return on ? [...without, member] : without;
        });
      } else if (type === "status") {
        const next = data.status as Status;
        setStatus(next);
        setCurrentRound(data.currentRound as number);
        if (data.savedPlanPath) setSavedPath(data.savedPlanPath as string);
        // The "pausing..." hint only applies while a round is still running.
        if (next !== "running") setPauseReq(false);
        // Clear lingering typing indicators when paused or ended.
        if (
          next === "paused" ||
          next === "done" ||
          next === "cancelled" ||
          next === "failed"
        ) {
          setTyping([]);
        }
      }
    };
    es.onerror = () => {
      // The stream closes when the session ends; that's expected. Keep whatever
      // we have. (Live sessions auto-close after the plan is written.)
    };
    return () => es.close();
  }, [sessionId]);

  const toggleWorker = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const canStart =
    idea.trim().length > 0 && objective.trim().length > 0 && !starting;

  const start = useCallback(async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      const rosterConfig =
        workers.length > 0
          ? Array.from(selected).map((name) => ({
              name,
              model: agentConfig[name]?.model || undefined,
              extra: agentConfig[name]?.extra?.trim() || undefined,
            }))
          : undefined;
      const chosenOutsiders = outsiders
        .filter((o) => o.enabled && o.displayName.trim() && o.model.trim())
        .map((o) => ({
          displayName: o.displayName.trim(),
          model: o.model.trim(),
        }));
      const res = await fetch("/api/warroom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea: idea.trim(),
          objective: objective.trim(),
          model,
          rounds,
          pace,
          personaWeight,
          research,
          rosterConfig,
          outsiders: chosenOutsiders.length > 0 ? chosenOutsiders : undefined,
        }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.error || `Failed to start (${res.status})`);
        setStarting(false);
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACTIVE_KEY, data.id);
      }
      setSessionId(data.id);
      setMeta({ idea: idea.trim(), objective: objective.trim(), rounds, title: "" });
      setStatus("running");
      setPhase("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setStarting(false);
    }
  }, [
    canStart,
    idea,
    objective,
    model,
    rounds,
    pace,
    personaWeight,
    research,
    agentConfig,
    outsiders,
    workers.length,
    selected,
  ]);

  const sendInterjection = useCallback(async () => {
    const text = interject.trim();
    if (!text || !sessionId) return;
    setInterject("");
    try {
      await fetch(`/api/warroom/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      /* best effort; the bubble echoes back over SSE */
    }
  }, [interject, sessionId]);

  const wrap = useCallback(
    async (save: boolean) => {
      if (!sessionId) return;
      try {
        await fetch(`/api/warroom/${sessionId}/wrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ save }),
        });
      } catch {
        /* best effort */
      }
    },
    [sessionId]
  );

  const setPausedRemote = useCallback(
    async (paused: boolean) => {
      if (!sessionId) return;
      if (paused) setPauseReq(true);
      else setPauseReq(false);
      try {
        await fetch(`/api/warroom/${sessionId}/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paused }),
        });
      } catch {
        /* best effort */
      }
    },
    [sessionId]
  );

  const startAnother = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(ACTIVE_KEY);
    }
    setSessionId(null);
    setMessages([]);
    setTyping([]);
    setStatus("idle");
    setMeta(null);
    setSavedPath(null);
    setCurrentRound(0);
    setInterject("");
    setError(null);
    setStarting(false);
    setIdea("");
    setObjective("");
    setPhase("setup");
  }, []);

  const ended =
    status === "done" || status === "cancelled" || status === "failed";

  const statusLine = useMemo(() => {
    if (status === "synthesizing") return "Writing up exactly what you asked for...";
    if (status === "paused")
      return "Paused. Take your time, type if you want, then Resume.";
    if (status === "running" && pauseReq)
      return "Pausing after the current round finishes...";
    if (status === "running" && currentRound === 0)
      return "Getting the room ready (title, background, research)...";
    if (status === "running")
      return meta
        ? `Round ${currentRound} of ${meta.rounds} - the team is talking`
        : "The team is talking";
    if (status === "done") return "Done. Saved to the vault.";
    if (status === "cancelled") return "Session cancelled.";
    if (status === "failed") return "Session ended with an error.";
    return "";
  }, [status, currentRound, meta, pauseReq]);

  // ---------------- Setup screen ----------------
  if (phase === "setup") {
    return (
      <div className="flex flex-col h-full">
        <header className="px-4 sm:px-6 py-4 border-b border-border bg-cards-bg">
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <Swords className="h-5 w-5 text-accent" />
            War Room
          </h1>
          <p className="text-xs text-muted mt-0.5">
            Drop an idea and watch the whole team talk it through, live. You get
            a plain-English plan at the end.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                The idea
              </label>
              <textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. A private app for our household to forecast our cash flow 30 days out."
                rows={3}
                className="w-full text-sm bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                The outcome you want (you get back exactly this)
              </label>
              <input
                type="text"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. A simple list of 5 ideas, each with a brief explanation."
                className="w-full text-sm bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <p className="text-[10px] text-muted mt-1">
                Be specific about the shape. The team delivers this exactly, not its
                own format.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                  Model
                </label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                  Rounds
                </label>
                <select
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {[2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n} rounds
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                Pace
              </label>
              <div className="grid grid-cols-3 gap-2">
                {PACES.map((p) => {
                  const on = pace === p.value;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPace(p.value)}
                      className={
                        "rounded-md border px-2 py-2 text-left transition-colors " +
                        (on
                          ? "border-accent/60 bg-accent/10"
                          : "border-border bg-background hover:border-foreground/30")
                      }
                    >
                      <div className="text-xs font-medium text-foreground/90">
                        {p.label}
                      </div>
                      <div className="text-[10px] text-muted mt-0.5 leading-tight">
                        {p.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted mt-1">
                Lightning keeps replies short and snappy, easiest to follow live.
              </p>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                Personality strength
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={personaWeight}
                onChange={(e) => setPersonaWeight(Number(e.target.value))}
                className="w-full accent-current text-accent"
              />
              <div className="flex items-baseline justify-between gap-2 mt-1">
                <span className="text-[10px] text-muted shrink-0">Generalist</span>
                <span className="text-[10px] text-foreground/80 text-center">
                  {personaLabel(personaWeight)}
                </span>
                <span className="text-[10px] text-muted shrink-0">Specialist</span>
              </div>
              <p className="text-[10px] text-muted mt-1">
                How much each person leans on their specialty. For open
                brainstorms, generalist-leaning gets more varied ideas.
              </p>
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-1.5">
                Research
              </label>
              <div className="grid grid-cols-3 gap-2">
                {RESEARCH_OPTIONS.map((r) => {
                  const on = research === r.value;
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setResearch(r.value)}
                      className={
                        "rounded-md border px-2 py-2 text-left transition-colors " +
                        (on
                          ? "border-accent/60 bg-accent/10"
                          : "border-border bg-background hover:border-foreground/30")
                      }
                    >
                      <div className="text-xs font-medium text-foreground/90">
                        {r.label}
                      </div>
                      <div className="text-[10px] text-muted mt-0.5 leading-tight">
                        {r.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted mt-1">
                Everyone researches privately, then speaks — so first takes stay
                independent. Midpoint adds a break where each person researches a
                different open question. Research makes the session slower and
                better informed.
              </p>
            </div>

            {workers.length > 0 && (
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-2">
                  {"Who's in the room"}
                </label>
                <div className="flex flex-wrap gap-2">
                  {workers.map((w) => {
                    const on = selected.has(w.name);
                    return (
                      <button
                        key={w.name}
                        type="button"
                        onClick={() => toggleWorker(w.name)}
                        className={
                          "inline-flex items-center gap-2 rounded-full border pl-1 pr-3 py-1 text-xs transition-colors " +
                          (on
                            ? "border-accent/60 bg-accent/10 text-foreground"
                            : "border-border bg-background text-muted hover:text-foreground")
                        }
                      >
                        <AgentAvatar
                          name={w.displayName}
                          color={w.color}
                          imageUrl={w.avatarUrl}
                          size={22}
                        />
                        {w.displayName}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted mt-1.5">
                  Claude Von Braun runs the room, steers between rounds, and
                  writes the final result.
                </p>
                <button
                  type="button"
                  onClick={() => setShowFineTune((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  {showFineTune ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  Fine-tune the room (per-person model and extra context)
                </button>
                {showFineTune && (
                  <div className="mt-2 space-y-2">
                    {workers
                      .filter((w) => selected.has(w.name))
                      .map((w) => {
                        const cfg = agentConfig[w.name] ?? {
                          model: "",
                          extra: "",
                        };
                        return (
                          <div
                            key={w.name}
                            className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2"
                          >
                            <div className="flex items-center gap-2 sm:w-40 shrink-0">
                              <AgentAvatar
                                name={w.displayName}
                                color={w.color}
                                imageUrl={w.avatarUrl}
                                size={20}
                              />
                              <span className="text-xs text-foreground/90 truncate">
                                {w.displayName}
                              </span>
                            </div>
                            <select
                              value={cfg.model}
                              onChange={(e) =>
                                setAgentConfig((prev) => ({
                                  ...prev,
                                  [w.name]: { ...cfg, model: e.target.value },
                                }))
                              }
                              className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent sm:w-32 shrink-0"
                            >
                              {AGENT_MODELS.map((m) => (
                                <option key={m.value} value={m.value}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                            <input
                              type="text"
                              value={cfg.extra}
                              onChange={(e) =>
                                setAgentConfig((prev) => ({
                                  ...prev,
                                  [w.name]: { ...cfg, extra: e.target.value },
                                }))
                              }
                              placeholder="Extra role or context for this session (optional)"
                              className="flex-1 min-w-0 text-xs bg-background border border-border rounded px-2 py-1 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted/80 font-semibold block mb-2">
                Outside consultants (other AIs, via OpenRouter)
              </label>
              {!orConfigured ? (
                <p className="text-[11px] text-muted">
                  Add an OpenRouter API key on the{" "}
                  <a href="/settings" className="underline hover:opacity-80">
                    Settings page
                  </a>{" "}
                  to invite outside models like ChatGPT, Gemini, or Grok into
                  the room. Fresh eyes from a different AI are the strongest
                  cure for groupthink.
                </p>
              ) : (
                <div className="space-y-2">
                  {outsiders.map((o, i) => (
                    <div key={o.key} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setOutsiders((prev) =>
                            prev.map((row, j) =>
                              j === i ? { ...row, enabled: !row.enabled } : row
                            )
                          )
                        }
                        className={
                          "inline-flex items-center rounded-full border px-3 py-1 text-xs transition-colors shrink-0 " +
                          (o.enabled
                            ? "border-accent/60 bg-accent/10 text-foreground"
                            : "border-border bg-background text-muted hover:text-foreground")
                        }
                      >
                        {o.customName ? "Custom" : o.displayName}
                      </button>
                      {o.enabled && o.customName && (
                        <input
                          type="text"
                          value={o.displayName}
                          onChange={(e) =>
                            setOutsiders((prev) =>
                              prev.map((row, j) =>
                                j === i
                                  ? { ...row, displayName: e.target.value }
                                  : row
                              )
                            )
                          }
                          placeholder="Name (e.g. Llama)"
                          className="w-32 text-xs bg-background border border-border rounded px-2 py-1 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      )}
                      {o.enabled && (
                        <input
                          type="text"
                          value={o.model}
                          onChange={(e) =>
                            setOutsiders((prev) =>
                              prev.map((row, j) =>
                                j === i ? { ...row, model: e.target.value } : row
                              )
                            )
                          }
                          placeholder="OpenRouter model id"
                          className="flex-1 min-w-0 text-xs font-mono bg-background border border-border rounded px-2 py-1 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent"
                        />
                      )}
                    </div>
                  ))}
                  <p className="text-[10px] text-muted">
                    Outsiders join every round with fresh outside eyes. Their
                    replies are billed to your OpenRouter account, and the model
                    IDs are editable in case a provider renames one.
                  </p>
                </div>
              )}
            </div>

            {error && (
              <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={start}
              disabled={!canStart}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-accent text-accent-fg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
            >
              {starting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Swords className="h-4 w-4" />
              )}
              Start the War Room
            </button>
            <p className="text-[10px] text-muted text-center">
              Heads up: a full-team session runs several agents at once and costs
              more than a single chat. Run it for the big ideas.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ---------------- Live screen ----------------
  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 py-3.5 border-b border-border bg-cards-bg">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-accent font-semibold">
          <Swords className="h-3.5 w-3.5" />
          War Room
        </div>
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight mt-1 leading-snug truncate">
          {meta?.title?.trim() ? meta.title : shortTitle(meta?.idea)}
        </h1>
        {meta?.objective && (
          <p className="text-xs text-muted mt-0.5 truncate">Goal: {meta.objective}</p>
        )}
      </header>

      {/* status strip */}
      <div className="px-4 sm:px-6 py-1.5 border-b border-border/60 bg-background/50 flex items-center gap-2 text-xs text-muted">
        {status === "paused" ? (
          <Pause className="h-3 w-3 text-accent-2" />
        ) : status === "running" || status === "synthesizing" ? (
          <Loader2 className="h-3 w-3 animate-spin text-accent" />
        ) : status === "done" ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        ) : null}
        <span>{statusLine}</span>
        {savedPath && (
          <span className="ml-auto font-mono text-[10px] truncate max-w-[50%]">
            {savedPath}
          </span>
        )}
      </div>

      {/* conversation */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto bg-cards-bg"
        >
          <div className="max-w-3xl mx-auto px-3 sm:px-6 py-5 space-y-4">
            {messages.map((m) =>
              isRoundDivider(m) ? (
                <RoundDivider key={m.id} text={m.text} />
              ) : (
                <Bubble key={m.id} m={m} />
              )
            )}
            {typing.map((t) => (
              <TypingBubble key={`typing-${t.name}`} m={t} />
            ))}
          </div>
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-accent-fg text-xs font-medium shadow-lg shadow-black/30 hover:opacity-90"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </button>
        )}
      </div>

      {/* interjection bar + session controls (kept together, by your hands) */}
      {!ended && (
        <div className="border-t border-border bg-cards-bg px-3 sm:px-6 py-3">
          <div className="max-w-3xl mx-auto">
            {/* controls row */}
            <div className="flex items-center gap-2 mb-2">
              {status === "paused" ? (
                <button
                  type="button"
                  onClick={() => setPausedRemote(false)}
                  title="Resume the conversation"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent text-accent-fg hover:opacity-90 text-xs font-medium"
                >
                  <Play className="h-3.5 w-3.5" />
                  Resume
                </button>
              ) : status !== "synthesizing" ? (
                <button
                  type="button"
                  onClick={() => setPausedRemote(true)}
                  disabled={pauseReq}
                  title="Pause so you can read and type (holds after the current round)"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-muted-bg/50 hover:bg-muted-bg text-xs text-muted hover:text-foreground disabled:opacity-50"
                >
                  <Pause className="h-3.5 w-3.5" />
                  {pauseReq ? "Pausing..." : "Pause"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => wrap(true)}
                disabled={status === "synthesizing"}
                title="Finish up now and save the result"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent text-accent-fg hover:opacity-90 disabled:opacity-50 text-xs font-medium"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Wrap up
              </button>
              <button
                type="button"
                onClick={() => wrap(false)}
                title="Stop now without saving a result"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-muted-bg/50 hover:bg-muted-bg text-xs text-muted hover:text-foreground"
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </button>
            </div>
            {/* input row */}
            <div className="flex items-end gap-2">
              <textarea
                value={interject}
                onChange={(e) => setInterject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendInterjection();
                  }
                }}
                placeholder={
                  status === "paused"
                    ? "You're paused — type your message, then hit Resume."
                    : "Jump in and steer the team (folded into the next round)..."
                }
                rows={1}
                className="flex-1 text-sm bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-accent resize-none max-h-32"
              />
              <button
                type="button"
                onClick={sendInterjection}
                disabled={!interject.trim()}
                className="inline-flex items-center justify-center h-9 w-9 rounded-md bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40 shrink-0"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {ended && (
        <div className="border-t border-border bg-cards-bg px-3 sm:px-6 py-3">
          <div className="max-w-3xl mx-auto">
            <button
              type="button"
              onClick={startAnother}
              className="text-xs text-accent hover:underline"
            >
              Start another War Room
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
