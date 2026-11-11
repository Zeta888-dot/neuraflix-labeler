"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Thin top progress bar for client navigations. It reacts on the click, waits
 * 120 ms so fast transitions do not flash, and clears when the pathname
 * changes. It is presentation only; the route skeleton carries the real
 * loading state.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPending(false);
      setActive(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setActive(true), 120);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // A navigation that never commits must not leave the bar on screen.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(false), 15000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      setActive(false);
      setPending(true);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const visible = pending && active;

  return (
    <div
      role="progressbar"
      aria-label="Loading the page"
      aria-hidden={!visible}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 transition-opacity duration-150",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "h-full w-full bg-accent",
          visible && "animate-pulse motion-reduce:animate-none",
        )}
      />
    </div>
  );
}
