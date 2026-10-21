"use client";

import { Moon, Sun } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { applyTheme, readTheme, subscribeTheme } from "@/lib/theme";

/**
 * Theme toggle. The inline script in the root layout sets the theme before
 * first paint; this component only swaps it afterwards and remembers it. The
 * current value is read from the document, so it stays in step with that
 * script and any other tab.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark");

  const label =
    theme === "light" ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button
      type="button"
      onClick={() => applyTheme(theme === "light" ? "dark" : "light")}
      aria-label={label}
      title={label}
      className="inline-flex size-9 items-center justify-center rounded-full text-body shadow-elev-1 transition-colors hover:text-ink hover:bg-surface-2 pointer-coarse:size-11"
    >
      {theme === "light" ? (
        <Moon size={18} weight="light" aria-hidden="true" />
      ) : (
        <Sun size={18} weight="light" aria-hidden="true" />
      )}
    </button>
  );
}
