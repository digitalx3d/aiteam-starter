"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Register on first idle to avoid contending with page paint.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* installable-only; silent if blocked (e.g. private mode) */
      });
    };
    if ("requestIdleCallback" in window) {
      (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(register);
    } else {
      setTimeout(register, 1000);
    }
  }, []);
  return null;
}
