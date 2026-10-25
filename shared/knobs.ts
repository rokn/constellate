import type { TunePreset } from "./types";
import { DEFAULT_TUNING, PRESETS, SECTIONS, type Tuning } from "./tuning";
import { DEFAULT_XR, XR_SECTIONS, type XRSettings } from "./xrSettings";

/**
 * Every Tune knob, the map's and the headset's, as one list: what the voice
 * offers to change, and what checks a preset before it's kept. The keys of
 * the two never overlap, so a knob is named by its key alone.
 */

export type Side = "map" | "headset";
export type KnobInfo = {
  key: string;
  side: Side;
  label: string;
  section: string;
  default: number | boolean;
  hint?: string;
  toggle?: boolean;
  min?: number;
  max?: number;
  step?: number;
};

/** The headset's knobs that aren't settings anyone tunes: left out of presets and the voice. */
const NOT_TUNED = new Set(["hintsSeen", "listen"]);

export const KNOBS: KnobInfo[] = [
  ...SECTIONS.flatMap((s) => s.knobs.map((k) => ({ ...k, side: "map" as const, section: s.title, default: DEFAULT_TUNING[k.key] }))),
  ...XR_SECTIONS.flatMap((s) => s.knobs.map((k) => ({ ...k, side: "headset" as const, section: s.title, default: DEFAULT_XR[k.key] }))),
].map((k) => ({ ...k, toggle: "toggle" in k ? true : undefined }));

const BY_KEY = new Map(KNOBS.map((k) => [k.key.toLowerCase(), k]));

/** A knob by its key, or by its label, as said ("bloom strength"). */
export function findKnob(name: string): KnobInfo | undefined {
  const n = name.trim().toLowerCase();
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return BY_KEY.get(n) ?? KNOBS.find((k) => plain(k.label) === plain(n)) ?? KNOBS.find((k) => plain(k.key) === plain(n));
}

/**
 * A value for a knob from what was asked: a number (kept to its range and
 * step), on / off, or "default". A string error when it can't be one.
 */
export function knobValue(k: KnobInfo, v: unknown): number | boolean | string {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "default" || s === "reset") return k.default;
  if (k.toggle) {
    if (v === true || ["on", "true", "yes", "1", "show"].includes(s)) return true;
    if (v === false || ["off", "false", "no", "0", "hide"].includes(s)) return false;
    return `${k.label} is on or off.`;
  }
  const n = typeof v === "number" ? v : Number(s);
  if (!Number.isFinite(n)) return `${k.label} takes a number from ${k.min} to ${k.max}.`;
  const step = k.step ?? 0.01;
  const clamped = Math.min(k.max ?? n, Math.max(k.min ?? n, n));
  return Number((Math.round(clamped / step) * step).toFixed(4));
}

/** What differs from the defaults, for one side: how a preset keeps its values. */
export function changed(side: Side, values: Record<string, number | boolean>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const k of KNOBS) if (k.side === side && !NOT_TUNED.has(k.key) && k.key in values && values[k.key] !== k.default) out[k.key] = values[k.key];
  return out;
}

/** Only knobs that exist, with values they can take: a preset as it's kept. */
export function cleanPreset(p: unknown): TunePreset | null {
  const o = p as Partial<TunePreset> | null;
  const name = typeof o?.name === "string" ? o.name.trim().slice(0, 60) : "";
  if (!name || !o?.map || typeof o.map !== "object") return null;
  const side = (s: Side, rec: Record<string, unknown>) => {
    const out: Record<string, number | boolean> = {};
    for (const [key, v] of Object.entries(rec)) {
      const k = KNOBS.find((x) => x.key === key && x.side === s);
      if (!k || NOT_TUNED.has(key) || (typeof v !== "number" && typeof v !== "boolean")) continue;
      const val = knobValue(k, v);
      if (typeof val !== "string") out[key] = val;
    }
    return out;
  };
  return { name, map: side("map", o.map), ...(o.headset && typeof o.headset === "object" ? { headset: side("headset", o.headset) } : {}) };
}

/** A preset's knobs as settings: the map's over the defaults, the headset's over the defaults (or null when it has none). */
export function presetValues(p: TunePreset): { map: Tuning; headset: Partial<XRSettings> | null } {
  return {
    map: { ...DEFAULT_TUNING, ...(p.map as Partial<Tuning>) },
    headset: p.headset ? { ...Object.fromEntries(KNOBS.filter((k) => k.side === "headset" && !NOT_TUNED.has(k.key)).map((k) => [k.key, k.default])), ...p.headset } : null,
  };
}

/** The built-in looks, as presets. */
export const BUILT_IN: TunePreset[] = PRESETS.map((p) => ({ name: p.title, map: p.patch as Record<string, number | boolean> }));

/** Whether the settings are what a preset sets. */
export function presetOn(p: TunePreset, tuning: Tuning, xr?: XRSettings): boolean {
  const v = presetValues(p);
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(a).every((k) => a[k] === b[k]);
  return same(v.map, tuning) && (!v.headset || !xr || same(v.headset, xr as unknown as Record<string, unknown>));
}
