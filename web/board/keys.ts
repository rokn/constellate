/**
 * Keyboard shortcuts in the headset (a Bluetooth keyboard paired to the
 * Quest). Alt + the key runs it — or the key alone, with Tune's "Letter keys"
 * set to shortcuts. 1–8 run the command wheel's slices. Kept in one place so
 * the shortcut map shows exactly what the keys do.
 */

export type Shortcut = { key: string; action: string; group: "tools" | "board" | "panels" | "room" };

export const KEYMAP: Shortcut[] = [
  { key: "v", action: "tool-select", group: "tools" },
  { key: "c", action: "tool-connect", group: "tools" },
  { key: "d", action: "tool-ink", group: "tools" },
  { key: "s", action: "tool-lasso", group: "tools" },
  { key: "x", action: "tool-erase", group: "tools" },
  { key: "e", action: "explode-toggle", group: "board" },
  { key: "j", action: "duplicate", group: "board" },
  { key: "y", action: "lock", group: "board" },
  { key: ".", action: "mark-done", group: "board" },
  { key: "i", action: "inside", group: "board" },
  { key: "u", action: "up", group: "board" },
  { key: "a", action: "ask-selection", group: "board" },
  { key: "m", action: "dictate", group: "board" },
  { key: "r", action: "transcript", group: "panels" },
  { key: "h", action: "scrub", group: "board" },
  { key: "t", action: "tiers", group: "board" },
  { key: "l", action: "labels-toggle", group: "board" },
  { key: "p", action: "palette", group: "panels" },
  { key: ",", action: "tune", group: "panels" },
  { key: "w", action: "wheel", group: "panels" },
  { key: "b", action: "shelf", group: "panels" },
  { key: "k", action: "snapshot", group: "panels" },
  { key: "g", action: "gestures", group: "panels" },
  { key: "]", action: "next-board", group: "room" },
  { key: "[", action: "prev-board", group: "room" },
  { key: "o", action: "recenter", group: "room" },
  { key: "q", action: "passthrough", group: "room" },
];

/** The other keys, always on (for the map). */
export const FIXED_KEYS: [string, string][] = [
  ["Type", "Opens the text bar (Enter sends, Tab: ask / label / note)"],
  ["Space", "Voice on / off"],
  ["Del", "Delete the selection"],
  ["Esc", "Clear the selection; close the bar"],
  ["Ctrl Z", "Undo (Shift: redo)"],
  ["1 – 8", "The wheel's slices (with Alt)"],
  ["F1", "This guide's map"],
];

/**
 * The key pressed, as the map writes it: from the physical key, so Alt on a
 * Mac keyboard (which turns "e" into "´") still reads as "e".
 */
export function keyOf(e: KeyboardEvent): string {
  const c = e.code;
  if (c.startsWith("Key")) return c.slice(3).toLowerCase();
  if (c.startsWith("Digit")) return c.slice(5);
  const named: Record<string, string> = { Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Slash: "/", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=" };
  return named[c] ?? e.key.toLowerCase();
}
