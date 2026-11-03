/**
 * One headset session across both views. The Code view and the boards each
 * draw with a renderer of their own; switching views would end the session
 * and drop you back to the browser. Instead the view that's leaving hands its
 * live session over here, and the view that's coming adopts it: it draws into
 * the same session with its own renderer. You stay in the headset (and in
 * passthrough) the whole way.
 */

export type XRMode = "vr" | "ar";

type Held = { session: XRSession; mode: XRMode; timer: ReturnType<typeof setTimeout>; onEnd: () => void };
let held: Held | null = null;

/** How long a session waits for the next view (a repo opening can take a while) before it ends. */
const WAIT_MS = 90_000;

/**
 * The leaving view lets go of its session without ending it. The renderer
 * that drew into it (three's WebXRManager) and the view's own handlers hear
 * "end" and detach; the session itself runs on, held here.
 */
export function handOff(session: XRSession, mode: XRMode) {
  drop();
  session.dispatchEvent(new Event("end"));
  const onEnd = () => {
    // Really ended (the headset's menu, say) while waiting.
    if (held?.session === session) drop();
  };
  session.addEventListener("end", onEnd, { once: true });
  const timer = setTimeout(() => {
    if (held?.session !== session) return;
    drop();
    void session.end().catch(() => {});
  }, WAIT_MS);
  held = { session, mode, timer, onEnd };
}

/** A session waiting for a view to take it. */
export function heldSession(): { mode: XRMode } | null {
  return held ? { mode: held.mode } : null;
}

/** The coming view takes the session. */
export function takeSession(): { session: XRSession; mode: XRMode } | null {
  const h = held;
  if (!h) return null;
  drop();
  return { session: h.session, mode: h.mode };
}

function drop() {
  if (!held) return;
  clearTimeout(held.timer);
  held.session.removeEventListener("end", held.onEnd);
  held = null;
}

/**
 * After adopting: the controllers and hands already in the session, told to
 * the new renderer as if they'd just arrived (it only hears of new ones).
 */
export function announceInputs(session: XRSession) {
  const e = new Event("inputsourceschange") as Event & { added: XRInputSource[]; removed: XRInputSource[]; session: XRSession };
  e.added = [...session.inputSources];
  e.removed = [];
  e.session = session;
  session.dispatchEvent(e);
}
