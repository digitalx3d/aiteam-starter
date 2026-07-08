"use client";

import { useEffect, useState } from "react";

/**
 * Client-side access to the server's resolved configuration (paths, binary).
 * Fetched once per page load from /api/settings and cached module-wide.
 * The Settings form calls invalidateServerConfig() after a save so other
 * components pick up new values on their next mount.
 */

export interface ServerConfig {
  projectsRoot: string;
  vaultDir: string;
  agentsDir: string;
  skillsDir: string;
  claudeProjectsDir: string;
  aiteamDir: string;
  claudeBin: string;
}

let cached: ServerConfig | null = null;
let pending: Promise<ServerConfig | null> | null = null;

export function fetchServerConfig(): Promise<ServerConfig | null> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { values?: ServerConfig } | null) => {
        cached = data?.values ?? null;
        return cached;
      })
      .catch(() => {
        pending = null;
        return null;
      });
  }
  return pending;
}

export function invalidateServerConfig(): void {
  cached = null;
  pending = null;
}

export function useServerConfig(): ServerConfig | null {
  const [cfg, setCfg] = useState<ServerConfig | null>(cached);
  useEffect(() => {
    if (cfg) return;
    let alive = true;
    fetchServerConfig().then((c) => {
      if (alive && c) setCfg(c);
    });
    return () => {
      alive = false;
    };
  }, [cfg]);
  return cfg;
}
