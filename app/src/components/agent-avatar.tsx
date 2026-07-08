"use client";

import { useState } from "react";

// Color name → Tailwind classes. Listed literally so the JIT compiler picks them up.
const COLORS: Record<string, string> = {
  blue: "bg-blue-600 dark:bg-blue-500",
  green: "bg-emerald-600 dark:bg-emerald-500",
  yellow: "bg-amber-500 dark:bg-amber-400",
  red: "bg-rose-600 dark:bg-rose-500",
  purple: "bg-violet-600 dark:bg-violet-500",
  orange: "bg-orange-600 dark:bg-orange-500",
  pink: "bg-pink-600 dark:bg-pink-500",
  teal: "bg-teal-600 dark:bg-teal-500",
  cyan: "bg-cyan-600 dark:bg-cyan-500",
};

export function avatarColorClass(color: string | undefined): string {
  if (!color) return COLORS.blue;
  return COLORS[color] ?? COLORS.blue;
}

export interface AgentAvatarProps {
  name: string;
  color: string | undefined;
  size?: number;
  /** When provided, the image is rendered on top of the colored letter circle. If it fails to load, we fall back to the letter. */
  imageUrl?: string | null;
}

export function AgentAvatar({
  name,
  color,
  size = 40,
  imageUrl,
}: AgentAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const initial = (name?.charAt(0) ?? "?").toUpperCase();
  const cls = avatarColorClass(color);
  const fontSize = Math.round(size * 0.45);

  const showImage = !!imageUrl && !imgError;

  // Proportional radius — scales cleanly across avatar sizes (32px chat → 84px team detail).
  // 22% gives a modern rounded-rectangle look (similar to iOS app icons) without going full pillow.
  const borderRadius = "22%";

  return (
    <div
      className={
        "inline-flex items-center justify-center text-white font-semibold shrink-0 overflow-hidden relative " +
        cls
      }
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${fontSize}px`,
        borderRadius,
      }}
      aria-hidden="true"
    >
      <span>{initial}</span>
      {showImage && imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          width={size}
          height={size}
          onError={() => setImgError(true)}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
        />
      )}
    </div>
  );
}
