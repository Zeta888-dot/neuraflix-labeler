"use client";

import { Moon, Sun } from "@phosphor-icons/react";
import { useSyncExternalStore } from "react";
import { applyTheme, readTheme, subscribeTheme } from "@/lib/theme";

/**
 * Theme item inside the account menu. The inline script in the root layout
 * sets the theme before first paint; this item only swaps it afterwards and
 * remembers it. The current value is read from the document, so it stays in
 * step with that script and any other tab.
 */
export function ThemeMenuItem() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark");
  const next = theme === "light" ? "dark" : "light";
  const Icon = theme === "light" ? Sun : Moon;

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => applyTheme(next)}
      aria-label={`Theme: ${theme === "light" ? "Light" : "Dark"}. Switch to ${next} theme`}
      className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-body-sm text-body transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <Icon size={16} weight="light" aria-hidden="true" />
      <span>Theme</span>
      <span className="ml-auto text-caption capitalize text-mute">{theme}</span>
    </button>
  );
}
