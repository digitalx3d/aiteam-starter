"use client";

import { useEffect } from "react";

/**
 * Keeps the app exactly as tall as the part of the screen the on-screen
 * keyboard isn't covering, on touch devices only.
 *
 * iOS (Safari and the installed home-screen app alike) does not resize the
 * page when its keyboard opens; it only shrinks the "visual viewport" and pans
 * the page up to reveal the focused field. In an app shell whose chat box is
 * pinned to the bottom, that either hides the box under the keyboard or shoves
 * the header off the top. Writing visualViewport.height into --vvh (read by
 * html.vv-sync in globals.css) makes the whole layout shrink to fit above the
 * keyboard instead, and undoing the pan keeps the header in place.
 *
 * Desktop never adds the class, so its layout keeps the plain 100dvh rule.
 */
export function VisualViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;

    const root = document.documentElement;
    root.classList.add("vv-sync");

    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Pinch-zoom also shrinks the visual viewport. Only follow it at normal
        // zoom, and leave panning alone while zoomed in.
        const zoomed = vv.scale > 1.01;
        root.style.setProperty(
          "--vvh",
          `${Math.round(zoomed ? window.innerHeight : vv.height)}px`
        );
        if (!zoomed && window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.classList.remove("vv-sync");
      root.style.removeProperty("--vvh");
    };
  }, []);

  return null;
}
