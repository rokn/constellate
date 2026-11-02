import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_KNOBS, BOARD_SECTIONS, BUILT_IN_PRESETS, DEFAULT_BOARD_TUNE, boardKnobValue, changedTune, cleanTune, findBoardKnob, tuneList, type BoardPreset } from "../../shared/boardTune";
import type { BoardScreen } from "../../shared/board";
import { CACHE_DIR } from "../session";
import { command } from "./store";

/**
 * The workshop's Tune, by voice or by Jarvis: turn any knob, reset a
 * section, switch to a preset, save one. The knobs live in the browser; these
 * say what to turn and every screen on the board turns it. Saved presets
 * live here, for every device.
 */

const FILE = path.join(CACHE_DIR, "board-presets.json");
let presets: BoardPreset[] | null = null;

export async function loadPresets(): Promise<BoardPreset[]> {
  if (presets) return presets;
  try {
    presets = (JSON.parse(await readFile(FILE, "utf8")) as BoardPreset[]).map((p) => ({ name: p.name, values: cleanTune(p.values) }));
  } catch {
    presets = [];
  }
  return presets;
}

export async function savePresets(list: BoardPreset[]) {
  presets = list.filter((p) => p.name?.trim()).map((p) => ({ name: p.name.trim().slice(0, 60), values: cleanTune(p.values) }));
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(presets, null, 1));
  return presets;
}

async function findPreset(name: string) {
  const n = name.trim().toLowerCase();
  const all = [...(await loadPresets()), ...BUILT_IN_PRESETS];
  return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().includes(n));
}

export type TuneTool = { name: string; description: string; properties: Record<string, unknown>; required: string[] };

export const TUNE_TOOLS: TuneTool[] = [
  {
    name: "tune",
    description:
      "Turn knobs of the workshop's Tune panel: glow, holograms, labels, links, the table, the camera, editing, and the headset's placement, panels, hands, sound and voice. Name each by key (from tune_knobs) with a number, on/off or 'default'. For 'more'/'less', step a fifth to a third of its range from where it is. Instant.",
    properties: { changes: { type: "string", description: "Comma-separated key=value, e.g. 'bloomStrength=0.9, labelSize=1.5, dust=off'" } },
    required: ["changes"],
  },
  { name: "tune_knobs", description: "Every Tune knob with its key, range and value now, and the presets. Read it before tuning anything you don't know the key of.", properties: {}, required: [] },
  {
    name: "reset_tune",
    description: "Put knobs back to their defaults: 'all', a section by its title (e.g. 'Glow', 'Headset · Panels'), or comma-separated keys.",
    properties: { what: { type: "string" } },
    required: ["what"],
  },
  { name: "use_preset", description: "Switch every knob to a preset: a built-in look (Stark, Neon, Calm, Readable, Blueprint, Quest performance) or one they saved.", properties: { name: { type: "string" } }, required: ["name"] },
  { name: "save_preset", description: "Keep the knobs as they are now as a preset under a name (the same name replaces it).", properties: { name: { type: "string" } }, required: ["name"] },
  { name: "delete_preset", description: "Delete a preset they saved. Only when they ask.", properties: { name: { type: "string" } }, required: ["name"] },
];

/** Carry out a Tune tool; null when `name` isn't one. */
export async function runBoardTune(name: string, args: Record<string, unknown>, boardId: string, screen: BoardScreen): Promise<Record<string, unknown> | null> {
  const str = (k: string) => String(args[k] ?? "").trim();
  const now = { ...DEFAULT_BOARD_TUNE, ...(screen.tune ?? {}) };
  switch (name) {
    case "tune": {
      const values: Record<string, number | boolean> = {};
      const done: string[] = [];
      const errors: string[] = [];
      for (const part of str("changes").split(/[,;\n]+/)) {
        const m = part.match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
        if (!m) {
          if (part.trim()) errors.push(`Couldn't read "${part.trim()}": use key=value.`);
          continue;
        }
        const k = findBoardKnob(m[1]);
        if (!k) {
          errors.push(`No knob "${m[1]}".`);
          continue;
        }
        const v = boardKnobValue(k, m[2]);
        if (typeof v === "string") errors.push(v);
        else {
          values[k.key] = v;
          done.push(`${k.label} ${typeof v === "boolean" ? (v ? "on" : "off") : v}`);
        }
      }
      if (!done.length) return { ok: false, error: errors.join(" ") || "Nothing to change." };
      command(boardId, { cmd: "tune", values });
      return { ok: true, set: done.join(", "), ...(errors.length ? { skipped: errors.join(" ") } : {}) };
    }
    case "tune_knobs":
      return { ok: true, knobs: tuneList(now, [...BUILT_IN_PRESETS, ...(await loadPresets())]) };
    case "reset_tune": {
      const w = str("what").toLowerCase();
      const sec = BOARD_SECTIONS.find((s) => s.title.toLowerCase() === w || s.title.toLowerCase().replace("headset · ", "") === w || s.id === w);
      const keys = w === "all" ? BOARD_KNOBS.map((k) => k.key) : sec ? sec.knobs.map((k) => k.key) : w.split(/[,\s]+/).map((x) => findBoardKnob(x)?.key).filter((x): x is string => !!x);
      if (!keys.length) return { ok: false, error: `No section or knob "${str("what")}". Sections: ${BOARD_SECTIONS.map((s) => s.title).join(", ")}.` };
      command(boardId, { cmd: "tune", values: Object.fromEntries(keys.map((k) => [k, DEFAULT_BOARD_TUNE[k]])) });
      return { ok: true, reset: keys.length };
    }
    case "use_preset": {
      const p = await findPreset(str("name"));
      if (!p) return { ok: false, error: `No preset "${str("name")}". Presets: ${[...BUILT_IN_PRESETS, ...(await loadPresets())].map((x) => x.name).join(", ")}.` };
      command(boardId, { cmd: "tune", values: { ...DEFAULT_BOARD_TUNE, ...p.values } });
      return { ok: true, preset: p.name };
    }
    case "save_preset": {
      const n = str("name");
      if (!n) return { ok: false, error: "Call again with a name." };
      const list = (await loadPresets()).filter((p) => p.name.toLowerCase() !== n.toLowerCase());
      await savePresets([...list, { name: n, values: changedTune(now) }]);
      command(boardId, { cmd: "presets" });
      return { ok: true, saved: n };
    }
    case "delete_preset": {
      const n = str("name").toLowerCase();
      const list = await loadPresets();
      const p = list.find((x) => x.name.toLowerCase() === n) ?? list.find((x) => x.name.toLowerCase().includes(n));
      if (!p) return { ok: false, error: BUILT_IN_PRESETS.some((x) => x.name.toLowerCase() === n) ? "That's a built-in look; it can't be deleted." : `No saved preset "${str("name")}".` };
      await savePresets(list.filter((x) => x !== p));
      command(boardId, { cmd: "presets" });
      return { ok: true, deleted: p.name };
    }
  }
  return null;
}
