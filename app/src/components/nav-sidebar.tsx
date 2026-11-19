"use client";

import { useEffect, useState, type ReactElement } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Users,
  Sparkles,
  Swords,
  Inbox,
  Settings,
  ListChecks,
  Server,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { InboxUnreadBadge } from "./inbox-unread-badge";
import { ActionItemsBadge } from "./action-items-badge";
import { ServersDownBadge } from "./servers-down-badge";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Slot for trailing content (badges, counters). Receives `collapsed` so the
   *  same item can show a count pill when expanded and a dot when collapsed. */
  TrailingSlot?: (props: { collapsed: boolean }) => ReactElement | null;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "The Bridge", Icon: LayoutDashboard },
  {
    href: "/action-items",
    label: "Action Items",
    Icon: ListChecks,
    TrailingSlot: ({ collapsed }) => <ActionItemsBadge compact={collapsed} />,
  },
  { href: "/projects", label: "Projects", Icon: FolderKanban },
  { href: "/team", label: "Team", Icon: Users },
  { href: "/war-room", label: "War Room", Icon: Swords },
  { href: "/skills", label: "Skills", Icon: Sparkles },
  {
    href: "/inbox",
    label: "Inbox",
    Icon: Inbox,
    TrailingSlot: ({ collapsed }) => <InboxUnreadBadge compact={collapsed} />,
  },
  {
    href: "/servers",
    label: "Servers",
    Icon: Server,
    TrailingSlot: ({ collapsed }) => <ServersDownBadge compact={collapsed} />,
  },
  { href: "/settings", label: "Settings", Icon: Settings },
];

const COLLAPSE_KEY = "aiteam.sidebar.collapsed";

/** Rendered inside both the desktop sidebar and the mobile drawer sheet. */
function NavItems({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      {NAV_ITEMS.map(({ href, label, Icon, TrailingSlot }) => {
        const active = pathname === href || pathname?.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            title={collapsed ? label : undefined}
            onClick={onNavigate}
            className={
              "relative flex items-center rounded-md text-sm transition-colors min-h-[44px] " +
              (collapsed ? "justify-center p-2" : "gap-3 px-3 py-2.5") +
              " " +
              (active
                ? "bg-accent text-accent-fg"
                : "text-foreground/70 hover:text-foreground hover:bg-background/40")
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span>{label}</span>}
            {TrailingSlot && <TrailingSlot collapsed={collapsed} />}
          </Link>
        );
      })}
    </>
  );
}

export function NavSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  // Mobile drawer open/closed state (only relevant on small screens)
  const [mobileOpen, setMobileOpen] = useState(false);

  // Restore collapse state from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(COLLAPSE_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      }
      return next;
    });
  };

  const closeMobile = () => setMobileOpen(false);

  return (
    <>
      {/* ---- Hamburger trigger (mobile only) ---- */}
      {/* Hamburger trigger (mobile only). h-10 inside the 48px top bar, centered
          vertically (4px top/bottom margin) so it doesn't cross the bar, and
          dropped by the status-bar inset like the bar itself (app-chrome.tsx). */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="fixed top-[calc(env(safe-area-inset-top)+0.25rem)] left-[calc(env(safe-area-inset-left)+0.75rem)] z-40 h-10 w-10 flex items-center justify-center rounded-md bg-muted-bg border border-border text-muted hover:text-foreground md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* ---- Mobile drawer backdrop ---- */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* ---- Mobile drawer sheet ---- */}
      <div
        className={
          "fixed inset-y-0 left-0 z-50 w-64 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] bg-muted-bg border-r border-border shadow-xl transition-transform duration-200 md:hidden " +
          (mobileOpen ? "translate-x-0" : "-translate-x-full")
        }
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <span className="text-base font-semibold tracking-tight">aiTeam</span>
          <button
            type="button"
            onClick={closeMobile}
            aria-label="Close navigation"
            className="-mr-2 p-3 rounded text-muted hover:text-foreground hover:bg-background/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 flex flex-col gap-1 p-3 overflow-y-auto">
          <NavItems collapsed={false} onNavigate={closeMobile} />
        </nav>
        <div className="px-5 py-3 border-t border-border text-[11px] text-muted">
          Phase 0 · MVP
        </div>
      </div>

      {/* ---- Desktop sidebar (hidden on mobile) ---- */}
      <aside
        className={
          "hidden md:flex shrink-0 border-r border-border bg-muted-bg flex-col transition-[width] duration-150 " +
          (collapsed ? "w-14" : "w-56")
        }
      >
        <div
          className={
            "flex items-center border-b border-border " +
            (collapsed ? "justify-center px-2 py-3" : "justify-between px-5 py-3")
          }
        >
          {!collapsed && (
            <span className="text-base font-semibold tracking-tight">aiTeam</span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="p-1.5 rounded text-muted hover:text-foreground hover:bg-background/40"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>
        <nav
          className={
            "flex-1 flex flex-col gap-1 " + (collapsed ? "p-2" : "p-3")
          }
        >
          <NavItems collapsed={collapsed} />
        </nav>
        {!collapsed && (
          <div className="px-5 py-3 border-t border-border text-[11px] text-muted">
            Phase 0 · MVP
          </div>
        )}
      </aside>
    </>
  );
}
