import { BOARD_KNOBS, DEFAULT_BOARD_TUNE, cleanTune } from "../../shared/boardTune";

/**
 * The workshop's knobs as this browser has them: read everywhere (the scene
 * every frame, the headset's hands, the panels), changed from the Tune panel,
 * a preset, the voice or Jarvis. Kept in localStorage.
 */

const KEY = "workshop.tune";
type Values = Record<string, number | boolean | string>;

function load(): Values {
  try {
    return cleanTune(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export const T: Values = { ...DEFAULT_BOARD_TUNE, ...load() };
const listeners = new Set<(changed: string[]) => void>();
/** The knobs that change how items and links are built: changing one rebuilds them. */
export const DRAW_KEYS = new Set(["labels", "labelSize", "labelBrightness", "tags", "linkLabels", "linkWidth", "arcHeight", "arrows"]);
/** Bumped when a drawing knob changes: what's built from them compares it to know when to rebuild. */
export let tuneRev = 0;

export const num = (k: string) => Number(T[k] ?? DEFAULT_BOARD_TUNE[k] ?? 0);
export const on = (k: string) => (T[k] ?? DEFAULT_BOARD_TUNE[k]) !== false;
/** A choice knob's value (an action id, a mode). */
export const pick = (k: string) => String(T[k] ?? DEFAULT_BOARD_TUNE[k] ?? "");

/** Change knobs: applied at once, kept, and told to everything listening. */
export function setTune(patch: Values) {
  const clean = cleanTune(patch);
  const changed = Object.keys(clean).filter((k) => T[k] !== clean[k]);
  if (!changed.length) return;
  Object.assign(T, clean);
  if (changed.some((k) => DRAW_KEYS.has(k))) tuneRev++;
  try {
    const keep: Values = {};
    for (const k of BOARD_KNOBS) if (T[k.key] !== k.default) keep[k.key] = T[k.key];
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    // Not kept past this page; still applied.
  }
  for (const f of listeners) f(changed);
}

/** Back to the defaults: everything, or the knobs named. */
export function resetTune(keys?: string[]) {
  const patch: Values = {};
  for (const k of BOARD_KNOBS) if (!keys || keys.includes(k.key)) patch[k.key] = k.default;
  setTune(patch);
}

/** A preset: the defaults, with its values over them. */
export function applyPreset(values: Values) {
  const patch: Values = { ...DEFAULT_BOARD_TUNE, ...values };
  setTune(patch);
}

export function onTune(f: (changed: string[]) => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** The knobs that differ from the defaults: what the voice and Jarvis are told. */
export function tuneChanged(): Values {
  const out: Values = {};
  for (const k of BOARD_KNOBS) if (T[k.key] !== k.default) out[k.key] = T[k.key];
  return out;
}
