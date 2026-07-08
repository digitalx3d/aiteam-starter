"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

interface LightboxState {
  src: string;
  alt?: string;
}

interface LightboxContextValue {
  open: (src: string, alt?: string) => void;
}

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function useLightbox(): LightboxContextValue {
  const ctx = useContext(LightboxContext);
  // Fallback no-op so MessageBubble renders fine outside a provider (tests, etc.).
  if (!ctx) {
    return {
      open: () => {
        /* noop */
      },
    };
  }
  return ctx;
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LightboxState | null>(null);

  const open = useCallback((src: string, alt?: string) => {
    setState({ src, alt });
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  // ESC closes the lightbox.
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, close]);

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {state && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={state.alt ? `Image: ${state.alt}` : "Image preview"}
          onClick={close}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm cursor-zoom-out p-6"
        >
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-4 right-4 rounded-full bg-black/40 text-white hover:bg-black/60 p-2 cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
          {/* Stop propagation so clicking the image itself doesn't close — only backdrop / X does. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.src}
            alt={state.alt ?? ""}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl cursor-default"
          />
          {state.alt && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[80%] truncate rounded bg-black/50 px-3 py-1 text-xs text-white"
            >
              {state.alt}
            </div>
          )}
        </div>
      )}
    </LightboxContext.Provider>
  );
}
