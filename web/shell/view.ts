import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * The project's two views, the Code view and the boards, live side by side:
 * once opened, a view stays mounted, and switching only changes which one
 * is on screen. The one that isn't keeps everything as it was (the camera,
 * the open panels, the conversation) but goes quiet: it doesn't draw, it
 * doesn't hear the keyboard, and it lets go of the headset.
 */

export type ViewKind = "code" | "board";

let current: ViewKind | null = null;

/** The shell says which view is on screen (none on the projects page). */
export function setActiveView(v: ViewKind | null) {
  current = v;
}

/**
 * Is this view the one on screen? For listeners on the window (shortcuts,
 * history), which hear everything whichever view is showing.
 */
export const viewOn = (v: ViewKind) => current === v;

/** Whether the view this component is in is the one on screen. */
export const ViewActive = createContext(true);
export const useViewActive = () => useContext(ViewActive);

/** The element a view's dialogs go in, so they leave the screen with it. */
export const viewRoot = (v: ViewKind): HTMLElement => document.getElementById(`view-${v}`) ?? document.body;

/* ------------------------------ the transcript ----------------------------- */

/**
 * The voice's transcript is one panel for the whole app: open on a board, it
 * is still open in the Code view. Pinned, it's open from the start.
 */
export const LOG_KEY = "constellate.log";

function pinned() {
  try {
    for (const k of [LOG_KEY, "codemap.log", "workshop.log"]) {
      const p = JSON.parse(localStorage.getItem(k) ?? "null") as { pinned?: boolean } | null;
      if (p) return !!p.pinned;
    }
  } catch {
    /* nothing kept */
  }
  return false;
}

const log = { open: pinned(), watchers: new Set<() => void>() };

export function setLogOpen(open: boolean | ((was: boolean) => boolean)) {
  const next = typeof open === "function" ? open(log.open) : open;
  if (next === log.open) return;
  log.open = next;
  log.watchers.forEach((f) => f());
}

export function useLogOpen() {
  const open = useSyncExternalStore(
    (f) => (log.watchers.add(f), () => log.watchers.delete(f)),
    () => log.open,
  );
  return [open, setLogOpen] as const;
}
