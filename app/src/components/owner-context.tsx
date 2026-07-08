"use client";

import { createContext, useContext } from "react";
import type { OwnerName } from "@/lib/config";

// Server components read getOwnerName() from lib/config directly; client
// components can't (it touches the filesystem), so the root layout resolves
// the name once and provides it here.
const OwnerContext = createContext<OwnerName>({ full: "Boss", first: "Boss" });

export function OwnerProvider({
  owner,
  children,
}: {
  owner: OwnerName;
  children: React.ReactNode;
}) {
  return <OwnerContext.Provider value={owner}>{children}</OwnerContext.Provider>;
}

export function useOwner(): OwnerName {
  return useContext(OwnerContext);
}
