import { BUILT_IN, KNOBS, changed, cleanPreset, findKnob, knobValue, type Side } from "../shared/knobs";
import type { TunePreset } from "../shared/types";
import type { Action, ActionContext } from "./actions";
import { session, setTunePresets } from "./session";

/**
 * The Tune panel, by voice or typed into Ask: every knob on the map and in
 * the headset, the resets, and the presets (the built-in looks and the ones
 * you saved). The knobs live in the browser; these say what to turn, the
 * browser turns it. Saved presets live on the server, for every device.
 */

const str = (args: Record<string, unknown>, k: string) => String(args[k] ?? "").trim();

/** A preset by name, yours first: exact, then by the start of a word. */
function findPreset(name: string): TunePreset | undefined {
  const n = name.trim().toLowerCase();
  const all = [...session.state.tunePresets, ...BUILT_IN];
  return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().includes(n));
}

/** The knobs as they are on their screen: the defaults, with what they've changed. */
function current(ctx: ActionContext, side: Side): Record<string, number | boolean> {
  return { ...Object.fromEntries(KNOBS.filter((k) => k.side === side).map((k) => [k.key, k.default])), ...(ctx.screen.tune?.[side] ?? {}) };
}

export const TUNE_ACTIONS: Action[] = [
  {
    name: "tune",
    description: [
      "Turn knobs of the Tune panel: how the map looks, moves and lays out, and the headset's own settings (passthrough, the table, hand and controller models, comfort, sound). Instant.",
      "Name each knob by its key from the knob list, with a number (kept to its range), on/off, or 'default'.",
      "For 'more' or 'less', go from its current value by a noticeable step (a fifth to a third of its range).",
    ].join(" "),
    properties: {
      changes: { type: "string", description: "Comma-separated key=value pairs, e.g. 'bloomStrength=1.2, particles=0, handModels=off'" },
    },
    required: ["changes"],
    run: (args, ctx) => {
      const map: Record<string, number | boolean> = {};
      const headset: Record<string, number | boolean> = {};
      const errors: string[] = [];
      const done: string[] = [];
      for (const part of str(args, "changes").split(/[,;\n]+/)) {
        const m = part.match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
        if (!m) {
          if (part.trim()) errors.push(`Couldn't read "${part.trim()}": use key=value.`);
          continue;
        }
        const k = findKnob(m[1]);
        if (!k) {
          errors.push(`No knob "${m[1]}".`);
          continue;
        }
        const v = knobValue(k, m[2]);
        if (typeof v === "string") {
          errors.push(v);
          continue;
        }
        (k.side === "map" ? map : headset)[k.key] = v;
        done.push(`${k.label} ${typeof v === "boolean" ? (v ? "on" : "off") : v}`);
      }
      if (!done.length) return { ok: false, error: errors.join(" ") || "Nothing to change." };
      ctx.command({ cmd: "tune", ...(Object.keys(map).length ? { map } : {}), ...(Object.keys(headset).length ? { headset } : {}) });
      return { ok: true, set: done.join(", "), ...(errors.length ? { skipped: errors.join(" ") } : {}) };
    },
  },
  {
    name: "reset_tune",
    description: "Put Tune knobs back to their defaults: the map's, the headset's, both, or one section by its title (e.g. 'Glow', 'Headset · Sound').",
    properties: { what: { type: "string", description: "'map', 'headset', 'all', or a section title" } },
    required: ["what"],
    run: (args, ctx) => {
      const what = str(args, "what").toLowerCase();
      const pick = KNOBS.filter((k) =>
        what === "all" ? true : what === "map" || what === "headset" ? k.side === what : k.section.toLowerCase() === what || k.section.toLowerCase().replace("headset · ", "") === what,
      ).filter((k) => k.key !== "hintsSeen");
      if (!pick.length) return { ok: false, error: `No section "${str(args, "what")}". Sections: ${[...new Set(KNOBS.map((k) => k.section))].join(", ")}.` };
      const of = (side: Side) => Object.fromEntries(pick.filter((k) => k.side === side).map((k) => [k.key, k.default]));
      const map = of("map");
      const headset = of("headset");
      ctx.command({ cmd: "tune", ...(Object.keys(map).length ? { map } : {}), ...(Object.keys(headset).length ? { headset } : {}) });
      return { ok: true, reset: pick.length };
    },
  },
  {
    name: "use_preset",
    description: "Switch the Tune knobs to a preset: a built-in look or one they saved (names in the preset list). A preset saved in the headset sets the headset's knobs too.",
    properties: { name: { type: "string" } },
    required: ["name"],
    run: (args, ctx) => {
      const p = findPreset(str(args, "name"));
      if (!p) return { ok: false, error: `No preset "${str(args, "name")}". Presets: ${[...BUILT_IN, ...session.state.tunePresets].map((x) => x.name).join(", ")}.` };
      ctx.command({ cmd: "apply_preset", preset: p });
      return { ok: true, preset: p.name };
    },
  },
  {
    name: "save_preset",
    description: "Keep the Tune knobs as they are now as a preset under a name, to switch back to later (the same name replaces it). Saved in the headset, it keeps the headset's own knobs too.",
    properties: { name: { type: "string", description: "A short name, e.g. 'Calm reading'" } },
    required: ["name"],
    run: (args, ctx) => {
      const name = str(args, "name");
      const inHeadset = !!ctx.screen.tune?.mode;
      const p = cleanPreset({ name, map: changed("map", current(ctx, "map")), ...(inHeadset ? { headset: changed("headset", current(ctx, "headset")) } : {}) });
      if (!p) return { ok: false, error: "Call again with a name." };
      void setTunePresets([...session.state.tunePresets.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), p]);
      return { ok: true, saved: p.name, keeps: inHeadset ? "the map's and the headset's knobs" : "the map's knobs" };
    },
  },
  {
    name: "delete_preset",
    description: "Delete a preset they saved. Only when they ask to delete or remove it.",
    properties: { name: { type: "string" } },
    required: ["name"],
    run: (args) => {
      const n = str(args, "name").toLowerCase();
      const p = session.state.tunePresets.find((x) => x.name.toLowerCase() === n) ?? session.state.tunePresets.find((x) => x.name.toLowerCase().includes(n));
      if (!p) return { ok: false, error: BUILT_IN.some((x) => x.name.toLowerCase() === n) ? "That's a built-in look; it can't be deleted." : `No saved preset "${str(args, "name")}".` };
      void setTunePresets(session.state.tunePresets.filter((x) => x !== p));
      return { ok: true, deleted: p.name };
    },
  },
];

/** Carries out a Tune action; null when `name` isn't one. */
export function runTune(name: string, args: Record<string, unknown>, ctx: ActionContext): Record<string, unknown> | null {
  const a = TUNE_ACTIONS.find((x) => x.name === name);
  return a ? a.run(args, ctx) : null;
}

/**
 * The knobs, for the model choosing one: each section on a line, every knob
 * with its key, label, range and value now (marked when changed), and the presets.
 */
export function tuneNote(ctx: Pick<ActionContext, "screen">): string {
  const now = { ...(ctx.screen.tune?.map ?? {}), ...(ctx.screen.tune?.headset ?? {}) };
  const sections = [...new Set(KNOBS.map((k) => k.section))];
  const lines = sections.map((sec) => {
    const ks = KNOBS.filter((k) => k.section === sec && k.key !== "hintsSeen");
    return `  ${sec}: ${ks
      .map((k) => {
        const v = k.key in now ? now[k.key] : k.default;
        const shown = typeof v === "boolean" ? (v ? "on" : "off") : v;
        return `${k.key} (${k.label}${k.toggle ? "" : `, ${k.min}–${k.max}`}) = ${shown}${k.key in now ? "*" : ""}`;
      })
      .join("; ")}`;
  });
  const mine = session.state.tunePresets;
  return [
    "Tune knobs (for tune and reset_tune; * marks one changed from its default):",
    ...lines,
    `Presets (for use_preset): built in — ${BUILT_IN.map((p) => p.name).join(", ")}${mine.length ? `; theirs — ${mine.map((p) => `${p.name}${p.headset ? " (with headset knobs)" : ""}`).join(", ")}` : ""}.`,
    ctx.screen.tune?.mode ? `They're in the headset (${ctx.screen.tune.mode === "ar" ? "passthrough" : "VR"}) now.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
