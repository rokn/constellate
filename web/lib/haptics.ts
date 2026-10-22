/**
 * A tap you can feel, where the device has one (Android; Safari has no
 * vibration, and a desktop just ignores it). Short is a tick, longer is a
 * landing.
 */
export const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not allowed before the page has been touched */
  }
};

/** A finger is the main way in: the touch-only extras show. */
export const touchFirst = () => typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
