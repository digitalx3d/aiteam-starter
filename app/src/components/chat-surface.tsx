"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Send, Square, ChevronDown, Archive, Paperclip, X as XIcon } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import { ArchivedBlock, type ArchivedTranscript } from "./archived-block";
import { ActivityPanel } from "./activity-panel";
import type { ChatMessage } from "@/lib/types";
import {
  sendMessage as storeSendMessage,
  stopMessage as storeStopMessage,
  setMessages as storeSetMessages,
  subscribe as storeSubscribe,
  getSnapshot as storeGetSnapshot,
  approveToolCall as storeApproveToolCall,
  denyToolCall as storeDenyToolCall,
  scopeKeyFor,
  markScopeSeen as storeMarkScopeSeen,
  type ScopeKey,
} from "@/lib/chat-store";

function archiveDismissedKey(projectSlug?: string | null): string {
  return projectSlug
    ? `aiteam.chat.archiveDismissed.project.${projectSlug}`
    : "aiteam.chat.archiveDismissed";
}

type ModelChoice = "haiku" | "sonnet" | "opus";
const MODEL_LABELS: Record<ModelChoice, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};
const MODEL_STORAGE_KEY = "aiteam.chat.model";
const PERMISSION_MODE_STORAGE_KEY = "aiteam.chat.permissionMode";

type PermissionMode = "acceptEdits" | "bypassPermissions";
const PERMISSION_LABELS: Record<PermissionMode, string> = {
  acceptEdits: "Safe",
  bypassPermissions: "Full access",
};
const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  acceptEdits: "Auto-approves file edits only",
  bypassPermissions: "Approves all tool calls automatically",
};

function transcriptStorageKey(projectSlug?: string | null): string {
  return projectSlug
    ? `aiteam.chat.transcript.project.${projectSlug}`
    : "aiteam.chat.transcript";
}

interface StoredTranscript {
  sessionId: string;
  messages: ChatMessage[];
  savedAt: number;
}

export interface ChatSurfaceProps {
  projectSlug?: string;
}

export function ChatSurface({ projectSlug }: ChatSurfaceProps = {}) {
  const slug = projectSlug ?? null;
  const scopeKey: ScopeKey = useMemo(() => scopeKeyFor(slug), [slug]);
  const transcriptKey = transcriptStorageKey(slug);
  const stateUrl = slug
    ? `/api/chat/state?project=${encodeURIComponent(slug)}`
    : "/api/chat/state";
  const transcriptUrl = slug
    ? `/api/chat/transcript?project=${encodeURIComponent(slug)}`
    : "/api/chat/transcript";
  const primerUrl = slug
    ? `/api/chat/primer?project=${encodeURIComponent(slug)}`
    : "/api/chat/primer";
  const lastArchiveUrl = slug
    ? `/api/chat/last-archive?project=${encodeURIComponent(slug)}`
    : "/api/chat/last-archive";
  const dismissKey = archiveDismissedKey(slug);

  // Subscribe to the per-scope chat state from the module-level store.
  // The store keeps streaming through page navigation — this hook just renders whatever the store currently has.
  const subscribeForScope = useCallback(
    (cb: () => void) => storeSubscribe(scopeKey, cb),
    [scopeKey]
  );
  const getServerSnapshot = useCallback(
    () => storeGetSnapshot(scopeKey),
    [scopeKey]
  );
  const scopeState = useSyncExternalStore(
    subscribeForScope,
    getServerSnapshot,
    getServerSnapshot
  );
  const { messages, busy, errorBanner, errorDetail } = scopeState;

  // The archived-conversation banner is deliberately NOT part of the live
  // `messages` array/store: it's fetched fresh from the vault (the actual
  // authoritative record) on every mount, so it can never go stale from a
  // browser cache and can never get silently overwritten by the live-session
  // reconcile below — both of which were real bugs in the earlier version
  // of this feature (confirmed 2026-07-12: content missing from the archived
  // view and the recap was the local cache lagging, then getting wiped
  // wholesale once the new session's message count passed it).
  const [archivedTranscript, setArchivedTranscript] = useState<ArchivedTranscript | null>(null);
  const [recapText, setRecapText] = useState<string | null>(null);

  const dismissArchived = useCallback(() => {
    if (archivedTranscript && typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey, archivedTranscript.vaultPath);
    }
    setArchivedTranscript(null);
    setRecapText(null);
  }, [archivedTranscript, dismissKey]);

  // Fetch the vault's most recent archive for this scope on every mount —
  // cheap (one small file read) and always accurate, whether the session
  // ended via the button or the background sweep while this tab was closed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(lastArchiveUrl);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { archive: ArchivedTranscript | null };
        if (cancelled || !data.archive) return;
        const dismissedFor =
          typeof window !== "undefined" ? window.localStorage.getItem(dismissKey) : null;
        if (dismissedFor === data.archive.vaultPath) return;
        setArchivedTranscript(data.archive);
      } catch {
        /* no archive to show, not fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, lastArchiveUrl, dismissKey]);

  // Once there's an archive to show, poll for its distilled recap (a real
  // Sonnet call — see claude-distill.ts — so it isn't instant). Gated on
  // updatedAt so a recap from a PREVIOUS archive generation never gets shown
  // against this one. Gives up silently after a handful of tries; the
  // transcript itself is already safely in the vault regardless.
  useEffect(() => {
    if (!archivedTranscript) {
      setRecapText(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const MAX_TRIES = 6;
      const INTERVAL_MS = 8000;
      for (let i = 0; i < MAX_TRIES; i++) {
        if (cancelled) return;
        try {
          const res = await fetch(primerUrl);
          if (res.ok) {
            const data = (await res.json()) as { text: string | null; updatedAt: number | null };
            if (data.text && data.updatedAt && data.updatedAt >= archivedTranscript.endedAt) {
              if (!cancelled) setRecapText(data.text);
              return;
            }
          }
        } catch {
          /* keep trying */
        }
        if (i < MAX_TRIES - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [archivedTranscript, primerUrl]);

  // Mark this scope as "seen" while mounted: on initial mount, on every messages
  // update (so live-streaming responses don't accumulate unread count), and on
  // scope switch. Anything that arrives after we unmount becomes unread.
  useEffect(() => {
    storeMarkScopeSeen(scopeKey);
  }, [scopeKey, messages]);

  const [input, setInput] = useState("");
  interface AttachedImage {
    localId: string;
    file: File;
    previewUrl: string;
  }
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track drag-enter/leave on nested elements so the overlay doesn't flicker.
  const dragCounterRef = useRef(0);
  const [model, setModel] = useState<ModelChoice>("haiku");
  const [permissionMode, setPermissionMode] = useState<"acceptEdits" | "bypassPermissions">("acceptEdits");
  const [openMenu, setOpenMenu] = useState<"model" | "permission" | null>(null);
  const [endingSession, setEndingSession] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<
    { kind: "ok"; vaultPath: string; messageCount: number } | { kind: "noop"; reason: string } | { kind: "err"; error: string } | null
  >(null);
  const [toastVisible, setToastVisible] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  // Track whether the user was near the bottom BEFORE a messages update so
  // the auto-scroll effect doesn't yank them back down while they're reading.
  const wasNearBottomRef = useRef(true);

  // Close popover menu on click outside
  useEffect(() => {
    if (!openMenu) return;
    function handleClick(e: MouseEvent) {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMenu]);

  // Restore model preference
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (stored === "haiku" || stored === "sonnet" || stored === "opus") {
      setModel(stored);
    }
    const storedMode = window.localStorage.getItem(PERMISSION_MODE_STORAGE_KEY);
    if (storedMode === "acceptEdits" || storedMode === "bypassPermissions") {
      setPermissionMode(storedMode);
    }
  }, []);

  const updateModel = useCallback((m: ModelChoice) => {
    setModel(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODEL_STORAGE_KEY, m);
    }
  }, []);

  const updatePermissionMode = useCallback(
    (m: "acceptEdits" | "bypassPermissions") => {
      setPermissionMode(m);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(PERMISSION_MODE_STORAGE_KEY, m);
      }
    },
    []
  );

  // Archive notice renders as a floating toast. Fade out at 2.7s, unmount at 3s,
  // so the CSS opacity transition can play before the node disappears.
  useEffect(() => {
    if (!archiveNotice) {
      setToastVisible(false);
      return;
    }
    setToastVisible(true);
    const fadeT = window.setTimeout(() => setToastVisible(false), 2700);
    const removeT = window.setTimeout(() => setArchiveNotice(null), 3000);
    return () => {
      window.clearTimeout(fadeT);
      window.clearTimeout(removeT);
    };
  }, [archiveNotice]);

  const endSession = useCallback(async () => {
    const confirmed = window.confirm(
      "End this session? The transcript will be archived to the vault and the next message will start fresh."
    );
    if (!confirmed) return;
    setEndingSession(true);
    setArchiveNotice(null);
    try {
      const endpoint = slug
        ? `/api/chat/end-session?project=${encodeURIComponent(slug)}`
        : "/api/chat/end-session";
      const res = await fetch(endpoint, { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        archived: boolean;
        vaultPath?: string;
        messageCount?: number;
        sessionId?: string;
        reason?: string;
        error?: string;
        markdown?: string;
        endedAt?: number;
      };
      if (!data.ok) {
        setArchiveNotice({ kind: "err", error: data.error ?? "unknown error" });
        return;
      }
      // Clear the live conversation — the archive banner (set below when we
      // actually archived something) is now separate state, sourced straight
      // from what the server just wrote to the vault, not from this array.
      storeSetMessages(scopeKey, []);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(transcriptKey);
      }
      if (data.archived && data.vaultPath && data.markdown && data.endedAt) {
        setArchivedTranscript({
          markdown: data.markdown,
          messageCount: data.messageCount ?? 0,
          vaultPath: data.vaultPath,
          endedAt: data.endedAt,
        });
        setRecapText(null);
      }
      if (data.archived && data.vaultPath) {
        setArchiveNotice({
          kind: "ok",
          vaultPath: data.vaultPath,
          messageCount: data.messageCount ?? 0,
        });
      } else {
        setArchiveNotice({
          kind: "noop",
          reason: data.reason ?? "no active session",
        });
      }
    } catch (err) {
      setArchiveNotice({ kind: "err", error: (err as Error).message });
    } finally {
      setEndingSession(false);
    }
  }, [slug, scopeKey, transcriptKey]);

  // Restore transcript on first mount of this scope. Two stages:
  //   1. Optimistic render from localStorage (instant, no flash of empty)
  //   2. Authoritative reconcile from the server's session log (source of truth)
  // The server's `.jsonl` is the actual record of the conversation, so localStorage
  // is treated as a fast-path cache only. If it drifts, the server silently fixes it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      // Stage 1: optimistic localStorage restore (only if store is empty)
      if (messages.length === 0) {
        try {
          const stateRes = await fetch(stateUrl);
          if (stateRes.ok) {
            const stateData = (await stateRes.json()) as {
              state: { sessionId: string; started: boolean } | null;
            };
            const serverSessionId = stateData.state?.sessionId ?? null;
            const raw = window.localStorage.getItem(transcriptKey);
            if (raw && !cancelled) {
              const stored = JSON.parse(raw) as StoredTranscript;
              if (
                stored.sessionId &&
                serverSessionId &&
                stored.sessionId === serverSessionId &&
                Array.isArray(stored.messages) &&
                stored.messages.length > 0
              ) {
                const cleaned = stored.messages.map((m) =>
                  m.pending ? { ...m, pending: false } : m
                );
                storeSetMessages(scopeKey, cleaned);
              } else if (!stored.sessionId || stored.sessionId !== serverSessionId) {
                // The cached session isn't the live one anymore — it ended
                // (button or auto-sweep). Nothing to preserve here: the
                // archived-transcript fetch above (sourced from the vault,
                // not this cache) is what shows the old conversation now.
                window.localStorage.removeItem(transcriptKey);
              }
            }
          }
        } catch {
          /* fall through to server reconcile */
        }
      }

      // Stage 2: authoritative reconcile from session log
      if (cancelled) return;
      try {
        const tRes = await fetch(transcriptUrl);
        if (!tRes.ok || cancelled) return;
        const tData = (await tRes.json()) as {
          messages?: ChatMessage[];
          sessionId?: string | null;
          hasSession?: boolean;
        };
        if (cancelled) return;

        // Don't disturb a live stream
        const current = storeGetSnapshot(scopeKey);
        if (current.messages.some((m) => m.pending)) return;

        // No live session yet for this scope — nothing to reconcile. The
        // archived-transcript fetch (above, sourced from the vault) already
        // covers "show the old conversation"; this array just stays empty
        // until the user's next message starts a fresh session.
        if (!tData.hasSession) {
          if (current.messages.length > 0) {
            storeSetMessages(scopeKey, []);
            window.localStorage.removeItem(transcriptKey);
          }
          return;
        }

        const serverMessages = Array.isArray(tData.messages) ? tData.messages : [];

        // Both empty → nothing to render either way
        if (serverMessages.length === 0 && current.messages.length === 0) return;

        // Server has fewer entries than local → likely a flush race (Claude Code
        // hasn't written the latest turn to .jsonl yet). Keep local intact.
        if (serverMessages.length < current.messages.length) return;

        // Server is authoritative — adopt and persist
        storeSetMessages(scopeKey, serverMessages);
        if (tData.sessionId && serverMessages.length > 0) {
          const payload: StoredTranscript = {
            sessionId: tData.sessionId,
            messages: serverMessages,
            savedAt: Date.now(),
          };
          window.localStorage.setItem(transcriptKey, JSON.stringify(payload));
        }
      } catch {
        /* keep whatever we already have */
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally only run this when scopeKey changes (or on first mount).
    // The messages.length check above prevents clobbering an active stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, stateUrl, transcriptKey, transcriptUrl]);

  // Persist transcript on every change (when not pending).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (messages.length === 0) return;
    if (messages.some((m) => m.pending)) return;
    (async () => {
      try {
        const stateRes = await fetch(stateUrl);
        if (!stateRes.ok) return;
        const data = (await stateRes.json()) as {
          state: { sessionId: string; started: boolean } | null;
        };
        const sessionId = data.state?.sessionId;
        if (!sessionId) return;
        const payload: StoredTranscript = {
          sessionId,
          messages,
          savedAt: Date.now(),
        };
        window.localStorage.setItem(transcriptKey, JSON.stringify(payload));
      } catch {
        /* ignore */
      }
    })();
  }, [messages, stateUrl, transcriptKey]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Auto-scroll on new content — only if the user was already near the bottom.
  // Reading wasNearBottomRef (updated by onScroll) captures "where the user was"
  // before the render, so a fresh 200px of streaming text doesn't push a scrolled-up
  // user back down.
  useEffect(() => {
    if (wasNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    const additions: AttachedImage[] = arr.map((file) => ({
      localId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setAttachedImages((prev) => [...prev, ...additions]);
    setUploadError(null);
  }, []);

  const removeAttachedImage = useCallback((localId: string) => {
    setAttachedImages((prev) => {
      const found = prev.find((p) => p.localId === localId);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  // Revoke all blob URLs when chat-surface unmounts.
  useEffect(() => {
    return () => {
      attachedImages.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
    // We intentionally only clean up on unmount — per-image cleanup happens in removeAttachedImage / send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    const hasImages = attachedImages.length > 0;
    if ((!trimmed && !hasImages) || busy || uploading) return;

    let imageMarkdown = "";
    if (hasImages) {
      setUploading(true);
      setUploadError(null);
      try {
        const formData = new FormData();
        if (slug) formData.append("project", slug);
        for (const img of attachedImages) {
          formData.append("file", img.file, img.file.name);
        }
        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        const data = (await res.json()) as {
          ok?: boolean;
          files?: Array<{ url: string; path: string; name: string }>;
          error?: string;
        };
        if (!res.ok || !data.ok || !data.files) {
          setUploadError(data.error || `Upload failed (${res.status})`);
          setUploading(false);
          return;
        }
        // Reference uploaded files in the message text using absolute paths so
        // Claude's Read tool resolves them as multimodal input. The chat
        // renderer rewrites the same path to /api/files for display.
        // The "Attached images" header is a hint to Claude to actually Read
        // the files — markdown image syntax alone isn't always enough.
        const fileLines = data.files
          .map((f) => `- ![${f.name.replace(/[\[\]]/g, "")}](${f.path})`)
          .join("\n");
        imageMarkdown =
          `\n\n**Attached image${data.files.length === 1 ? "" : "s"}** ` +
          `(use Read on the path${data.files.length === 1 ? "" : "s"} to view):\n` +
          fileLines;
      } catch (err) {
        setUploadError((err as Error).message || "Upload failed");
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const finalText = (trimmed + imageMarkdown).trim();
    setInput("");
    attachedImages.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setAttachedImages([]);

    storeSendMessage(scopeKey, {
      text: finalText,
      model,
      projectSlug: slug ?? undefined,
      permissionMode,
    });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [input, attachedImages, busy, uploading, model, permissionMode, scopeKey, slug]);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragActive(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
      }
      // Reset so picking the same file twice still triggers change.
      e.target.value = "";
    },
    [addFiles]
  );

  const stop = useCallback(() => {
    storeStopMessage(scopeKey);
  }, [scopeKey]);

  const handleApprove = useCallback(
    (toolUseId: string) => {
      storeApproveToolCall(scopeKey, toolUseId, {
        model,
        projectSlug: slug ?? undefined,
        permissionMode,
      });
    },
    [scopeKey, model, slug, permissionMode]
  );

  const handleDeny = useCallback(
    (toolUseId: string) => {
      storeDenyToolCall(scopeKey, toolUseId);
    },
    [scopeKey]
  );

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    send();
  }

  return (
    <div className="flex flex-col h-full relative">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {archivedTranscript && (
          <ArchivedBlock
            archive={archivedTranscript}
            recapText={recapText}
            onDismiss={dismissArchived}
          />
        )}
        {messages.length === 0 && (
          <div className="px-4 sm:px-6 py-12 text-sm text-muted">
            Empty conversation. Type a message below to start.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onApprove={handleApprove}
            onDeny={handleDeny}
            projectSlug={slug}
          />
        ))}
        {errorBanner && (
          <div className="mx-3 sm:mx-6 my-3 rounded-md border border-error/40 bg-error-bg px-3 py-2 text-xs text-error">
            <div>
              <span className="font-semibold">Error: </span>
              {errorBanner}
            </div>
            {errorDetail && (
              <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[10px] text-error/70 leading-snug max-h-32 overflow-y-auto">
                {errorDetail}
              </pre>
            )}
          </div>
        )}
      </div>
      <form
        onSubmit={onSubmit}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className="relative border-t border-border bg-background shrink-0"
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-t-md border-2 border-dashed border-accent bg-accent/10 text-xs font-medium text-accent">
            Drop image to attach
          </div>
        )}
        {(attachedImages.length > 0 || uploadError) && (
          <div className="px-3 sm:px-6 pt-3 pb-1 flex flex-wrap items-center gap-2">
            {attachedImages.map((img) => (
              <div
                key={img.localId}
                className="relative group rounded border border-border bg-tool-bg/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt={img.file.name}
                  className="h-14 w-14 object-cover rounded"
                />
                <button
                  type="button"
                  onClick={() => removeAttachedImage(img.localId)}
                  aria-label={`Remove ${img.file.name}`}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-background border border-border text-muted hover:text-foreground hover:border-foreground/30 p-0.5"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
            {uploadError && (
              <span className="text-[11px] text-error">
                {uploadError}
              </span>
            )}
          </div>
        )}

        {/* Controls row (model / permission / end-session) — always above the textarea */}
        <div ref={menuContainerRef} className="px-3 sm:px-6 pt-2 pb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "model" ? null : "model")}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-1 text-muted hover:text-foreground hover:border-foreground/30 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <span>{MODEL_LABELS[model]}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {openMenu === "model" && (
              <div className="absolute bottom-full left-0 mb-1 z-10 rounded-md border border-border bg-background shadow-lg py-1 min-w-[140px]">
                {(Object.keys(MODEL_LABELS) as ModelChoice[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      updateModel(m);
                      setOpenMenu(null);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-accent/10 ${
                      model === m ? "text-accent font-medium" : "text-foreground"
                    }`}
                  >
                    {MODEL_LABELS[m]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === "permission" ? null : "permission")}
              disabled={busy}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 hover:border-foreground/30 disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${
                permissionMode === "bypassPermissions"
                  ? "border-accent-2/60 bg-accent-2/10 text-accent-2"
                  : "border-border bg-background/50 text-muted hover:text-foreground"
              }`}
              title={PERMISSION_DESCRIPTIONS[permissionMode]}
            >
              <span>{PERMISSION_LABELS[permissionMode]}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {openMenu === "permission" && (
              <div className="absolute bottom-full left-0 mb-1 z-10 rounded-md border border-border bg-background shadow-lg py-1 min-w-[220px]">
                {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      updatePermissionMode(m);
                      setOpenMenu(null);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-accent/10 ${
                      permissionMode === m ? "text-accent font-medium" : "text-foreground"
                    }`}
                  >
                    <div>{PERMISSION_LABELS[m]}</div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {PERMISSION_DESCRIPTIONS[m]}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={endSession}
            disabled={busy || endingSession || messages.length === 0}
            title={
              messages.length === 0
                ? "Nothing to archive yet — send a message first."
                : "Archive this session's transcript to the vault and start fresh."
            }
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background/50 px-2 py-1 text-muted hover:text-foreground hover:border-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Archive className="h-3 w-3" />
            <span>{endingSession ? "Archiving…" : "End session"}</span>
          </button>
        </div>

        {/* Textarea + send/stop row */}
        <div className="px-3 sm:px-6 pb-3 flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={onFilePicked}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || uploading}
            title="Attach image (also accepts paste and drag-and-drop)"
            className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-md border border-border bg-background text-muted hover:text-foreground hover:border-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              busy
                ? "Claude is working..."
                : uploading
                ? "Uploading images..."
                : "Message Claude — Enter to send, Shift+Enter for newline"
            }
            disabled={busy}
            className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              title="Stop the current response"
              className="h-10 w-10 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-error text-sm font-medium text-white hover:opacity-90"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!input.trim() && attachedImages.length === 0) || uploading}
              className="h-10 w-10 shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </form>
      <ActivityPanel messages={messages} />
      {archiveNotice && (
        <div
          className={`pointer-events-none absolute bottom-32 right-6 z-20 rounded-md border bg-background shadow-lg px-3 py-2 text-xs flex items-center gap-2 transition-opacity duration-300 ${
            toastVisible ? "opacity-100" : "opacity-0"
          } ${
            archiveNotice.kind === "err"
              ? "text-error border-error/40"
              : archiveNotice.kind === "ok"
              ? "text-accent-2 border-accent-2/40"
              : "text-muted border-border"
          }`}
        >
          <Archive className="h-3 w-3 shrink-0" />
          {archiveNotice.kind === "ok" && (
            <span>
              Session archived to <code className="font-mono">{archiveNotice.vaultPath}</code> ({archiveNotice.messageCount} msg{archiveNotice.messageCount === 1 ? "" : "s"}).
            </span>
          )}
          {archiveNotice.kind === "noop" && (
            <span>Nothing to archive ({archiveNotice.reason}). Chat reset.</span>
          )}
          {archiveNotice.kind === "err" && (
            <span>End-session failed: {archiveNotice.error}</span>
          )}
        </div>
      )}
    </div>
  );
}
