"use client";

import { useState } from "react";
import { chatImageSrcToUrl } from "@/lib/chat-image-url";
import { useLightbox } from "./lightbox";

interface ChatImageProps {
  src: string | undefined;
  alt?: string;
  projectSlug?: string | null;
}

/**
 * Thumbnail-style image renderer used inside chat markdown. Resolves local
 * chat-images paths to /api/files URLs and opens the lightbox on click.
 *
 * Failure modes: if the file 404s, we render a small inline error chip so the
 * user can see what was attempted and Maya/CVB can verify the path they emitted.
 */
export function ChatImage({ src, alt, projectSlug }: ChatImageProps) {
  const url = chatImageSrcToUrl(src, projectSlug);
  const [errored, setErrored] = useState(false);
  const lightbox = useLightbox();

  if (!url) return null;

  if (errored) {
    return (
      <span className="inline-flex items-center gap-1 align-baseline rounded border border-error/40 bg-error-bg px-2 py-0.5 text-[11px] font-mono text-error">
        image failed: {alt ?? src}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt ?? ""}
      onClick={() => lightbox.open(url, alt)}
      onError={() => setErrored(true)}
      className="my-2 inline-block max-h-[220px] max-w-full rounded border border-border bg-tool-bg/40 cursor-zoom-in hover:opacity-90 transition-opacity"
    />
  );
}
