"use client";

/**
 * Sidebar collapse preference, kept in localStorage. React reads it through
 * useSyncExternalStore so the server render (always expanded) never has to
 * match a value only the browser knows.
 */
const COLLAPSED_KEY = "nf-sidebar-collapsed";

const listeners = new Set<() => void>();

export function subscribeCollapsed(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage can be blocked; the change still applies for this page view.
  }
  for (const listener of listeners) listener();
}
