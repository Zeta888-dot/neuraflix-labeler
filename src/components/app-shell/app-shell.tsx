"use client";

import {
  CaretLeft,
  CaretRight,
  List,
  SignOut,
  X,
  type Icon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { LabelerWordmark } from "@/components/brand/Wordmark";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import {
  isActivePath,
  visibleNavItems,
  type NavItem,
} from "@/components/app-shell/nav-items";
import { Avatar } from "@/components/ui/avatar";
import { Sheet } from "@/components/ui/sheet";
import {
  readCollapsed,
  subscribeCollapsed,
  writeCollapsed,
} from "@/components/app-shell/sidebar-preference";
import { signOut } from "@/lib/actions/sign-out";
import { cn } from "@/lib/cn";
import type { Role } from "@/lib/types";

export type AppShellUser = {
  displayName: string;
  email: string | null;
  role: Role;
};

const COLLAPSED_WIDTH = "lg:pl-[68px]";
const EXPANDED_WIDTH = "lg:pl-64";

export function AppShell({
  user,
  children,
}: {
  user: AppShellUser;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    readCollapsed,
    () => false,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const items = visibleNavItems(user.role);

  function toggleCollapsed() {
    writeCollapsed(!collapsed);
  }

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-solid focus:px-4 focus:py-2 focus:text-body-sm focus:text-on-solid"
      >
        Skip to content
      </a>

      <aside
        aria-label="Sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-hairline bg-surface lg:flex",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <SidebarContent
          items={items}
          pathname={pathname}
          collapsed={collapsed}
          user={user}
          onToggleCollapsed={toggleCollapsed}
        />
      </aside>

      <Sheet
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        label="Main menu"
      >
        <div className="flex h-16 items-center justify-between gap-2 border-b border-hairline px-3">
          <LabelerWordmark size={18} />
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="inline-flex size-9 items-center justify-center rounded-full text-body hover:bg-surface-2 hover:text-ink pointer-coarse:size-11"
          >
            <X size={18} weight="light" aria-hidden="true" />
          </button>
        </div>
        <SidebarContent
          items={items}
          pathname={pathname}
          collapsed={false}
          user={user}
          onNavigate={() => setDrawerOpen(false)}
        />
      </Sheet>

      <div
        className={cn(
          "min-h-dvh transition-[padding] duration-200 ease-[var(--ease-out-quart)]",
          collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        )}
      >
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-hairline bg-canvas/90 px-4 backdrop-blur lg:px-8">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-1 inline-flex size-9 items-center justify-center rounded-full text-body hover:bg-surface-2 hover:text-ink pointer-coarse:size-11 lg:hidden"
          >
            <List size={20} weight="light" aria-hidden="true" />
          </button>
          <span className={cn(collapsed ? "lg:block" : "lg:hidden")}>
            <LabelerWordmark size={16} />
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1400px] px-4 py-8 outline-none lg:px-8 lg:py-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarContent({
  items,
  pathname,
  collapsed,
  user,
  onToggleCollapsed,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  user: AppShellUser;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <>
      {onToggleCollapsed ? (
        <div
          className={cn(
            "flex h-16 shrink-0 items-center gap-2 border-b border-hairline px-3",
            collapsed && "justify-center",
          )}
        >
          {collapsed ? null : <LabelerWordmark size={18} />}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full text-mute hover:bg-surface-2 hover:text-ink pointer-coarse:size-11",
              collapsed ? "" : "ml-auto",
            )}
          >
            {collapsed ? (
              <CaretRight size={18} weight="light" aria-hidden="true" />
            ) : (
              <CaretLeft size={18} weight="light" aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const Icon: Icon = item.icon;
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "relative flex h-9 items-center gap-2.5 rounded-md px-2 text-body-sm transition-colors pointer-coarse:min-h-11",
                    active
                      ? "bg-surface-2 text-ink"
                      : "text-body hover:bg-surface-2 hover:text-ink",
                    collapsed && "justify-center px-0",
                  )}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                    />
                  ) : null}
                  <Icon
                    size={18}
                    weight="light"
                    aria-hidden="true"
                    className="shrink-0"
                  />
                  <span className={cn(collapsed && "sr-only")}>
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <UserMenu user={user} collapsed={collapsed} />
    </>
  );
}

function UserMenu({
  user,
  collapsed,
}: {
  user: AppShellUser;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative shrink-0 border-t border-hairline p-2"
    >
      {open ? (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute bottom-full left-2 z-40 mb-2 w-56 rounded-lg bg-surface p-1 shadow-elev-5"
        >
          <div className="px-3 py-2">
            <p className="truncate text-body-sm text-ink">{user.displayName}</p>
            {user.email ? (
              <p className="truncate text-caption text-mute">{user.email}</p>
            ) : null}
            <p className="mt-1 text-caption text-mute capitalize">
              {user.role}
            </p>
          </div>
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-md px-3 py-2 text-body-sm text-body hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11"
          >
            Account
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-body-sm text-body hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11"
            >
              <SignOut size={16} weight="light" aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.displayName}`}
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 hover:bg-surface-2 pointer-coarse:min-h-11",
          collapsed && "justify-center",
        )}
      >
        <Avatar name={user.displayName} size={28} />
        <span className={cn("min-w-0 flex-1 text-left", collapsed && "sr-only")}>
          <span className="block truncate text-body-sm text-ink">
            {user.displayName}
          </span>
          {user.email ? (
            <span className="block truncate text-caption text-mute">
              {user.email}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
