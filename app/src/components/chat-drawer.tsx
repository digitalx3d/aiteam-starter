"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronUp,
  ChevronsUp,
  ChevronsDown,
  GripHorizontal,
  MessageSquare,
} from "lucide-react";
import { ChatSurface } from "./chat-surface";
import {
  subscribe as storeSubscribe,
  getSnapshot,
  scopeKeyFor,
  sendMessage as storeSendMessage,
} from "@/lib/chat-store";

const HEIGHT_KEY = "aiteam.dashboard.chat.height";
const COLLAPSED_KEY = "aiteam.dashboard.chat.collapsed";
const MIN_OPEN_HEIGHT = 220; // smallest the chat is still usable at
const DEFAULT_OPEN_HEIGHT = 420;
const COLLAPSED_BAR_PX = 44;

export interface ChatDrawerProps {
  projectSlug?: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function ChatDrawer({ projectSlug }: ChatDrawerProps = {}) {
  const [collapsed, setCollapsed] = useState(true);
  const [height, setHeight] = useState(DEFAULT_OPEN_HEIGHT);
  const heightRef = useRef(DEFAULT_OPEN_HEIGHT);
  const drawerRef = useRef<HTMLDivElement>(null);

  const scopeKey = scopeKeyFor(projectSlug ?? null);

  // Restore from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedH = window.localStorage.getItem(HEIGHT_KEY);
    if (storedH) {
      const n = parseInt(storedH, 10);
      if (!isNaN(n) && n >= MIN_OPEN_HEIGHT) {
        setHeight(n);
        heightRef.current = n;
      }
    }
    const storedC = window.localStorage.getItem(COLLAPSED_KEY);
    if (storedC === "0") setCollapsed(false);
  }, []);

  // Keep heightRef synced for use inside drag closures.
  useEffect(() => {
    heightRef.current = height;
  }, [height]);

  // Persist
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  // Auto-open the drawer when a turn starts streaming.
  useEffect(() => {
    let prevBusy = false;
    const check = () => {
      const snap = getSnapshot(scopeKey);
      if (snap.busy && !prevBusy) {
        setCollapsed(false);
      }
      prevBusy = snap.busy;
    };
    const unsubscribe = storeSubscribe(scopeKey, check);
    check();
    return unsubscribe;
  }, [scopeKey]);

  // Wake is now a direct dispatch from the Team page (see wake-agent-button.tsx):
  // it hits /api/dispatch and the worker's report arrives as a normal bubble. It no
  // longer navigates here or injects a Task-tool prompt into this chat.

  const getMaxHeight = useCallback((): number => {
    const parent = drawerRef.current?.parentElement;
    if (!parent) return 800;
    return parent.clientHeight;
  }, []);

  const onDragStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Don't start a drag if the press landed on a button inside the handle bar.
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = heightRef.current;
      const maxH = getMaxHeight();

      // Pointer events unify mouse + touch + pen, so this same drag works on a
      // phone. Paired with `touch-none` on the handle, it also stops the browser
      // from reading a downward drag as pull-to-refresh.
      const onMove = (ev: globalThis.PointerEvent) => {
        const next = clamp(startH + (startY - ev.clientY), MIN_OPEN_HEIGHT, maxH);
        setHeight(next);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
    },
    [getMaxHeight]
  );

  const minimize = useCallback(() => setCollapsed(true), []);
  const maximize = useCallback(() => {
    setCollapsed(false);
    const max = getMaxHeight();
    if (max > 0) setHeight(max);
  }, [getMaxHeight]);

  const expandToDefault = useCallback(() => {
    setCollapsed(false);
    // Use the saved height (already in state) or default.
    if (heightRef.current < MIN_OPEN_HEIGHT) {
      setHeight(DEFAULT_OPEN_HEIGHT);
    }
  }, []);

  if (collapsed) {
    return (
      <div
        ref={drawerRef}
        className="absolute bottom-0 left-0 right-0 shrink-0"
        style={{ height: `${COLLAPSED_BAR_PX}px` }}
      >
        <button
          type="button"
          onClick={expandToDefault}
          className="w-full h-full flex items-center justify-center gap-2 bg-muted-bg hover:bg-muted-bg/80 border-t border-border text-sm text-foreground/85 hover:text-foreground transition-colors"
          title="Open chat"
        >
          <MessageSquare className="h-4 w-4 text-accent" />
          <span>Open chat with Claude</span>
          <ChevronUp className="h-3.5 w-3.5 text-muted ml-2" />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={drawerRef}
      className="absolute bottom-0 left-0 right-0 flex flex-col bg-background border-t border-border shadow-[0_-4px_16px_rgba(0,0,0,0.25)]"
      style={{ height: `${height}px` }}
    >
      <div
        onPointerDown={onDragStart}
        className="shrink-0 h-7 flex items-center justify-between px-3 bg-muted-bg/70 border-b border-border cursor-ns-resize select-none touch-none group"
        title="Drag to resize"
      >
        <div className="flex-1 flex items-center justify-center text-muted/70 group-hover:text-muted">
          <GripHorizontal className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={maximize}
            title="Maximize"
            className="p-1 rounded text-muted hover:text-foreground hover:bg-background/40"
          >
            <ChevronsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={minimize}
            title="Minimize"
            className="p-1 rounded text-muted hover:text-foreground hover:bg-background/40"
          >
            <ChevronsDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ChatSurface projectSlug={projectSlug} />
      </div>
    </div>
  );
}
