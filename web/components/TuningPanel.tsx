import { useState } from "react";
import { BUILT_IN, presetOn } from "../../shared/knobs";
import type { TunePreset } from "../../shared/types";
import { DEFAULT_TUNING, FORCE_KNOBS, SECTIONS, SHAPE_KNOBS, type Knob, type Tuning } from "../lib/tuning";

/**
 * Every knob on the map. Changes apply live; knobs that rebuild the bodies
 * (sizes, labels) commit when you let go of the slider, so dragging stays
 * smooth on big repos. Presets: the built-in looks, and yours, saved under
 * a name and kept on the server, so the headset has them too.
 */
export function TuningPanel({
  tuning,
  onChange,
  presets,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onRelayout,
  onClose,
}: {
  tuning: Tuning;
  onChange: (t: Tuning) => void;
  presets: TunePreset[];
  onSavePreset: (name: string) => void;
  onApplyPreset: (p: TunePreset) => void;
  onDeletePreset: (name: string) => void;
  onRelayout: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ glow: true, layout: true });
  /** The name being typed for a new preset; null when not saving one. */
  const [naming, setNaming] = useState<string | null>(null);
  const set = (patch: Partial<Tuning>) => onChange({ ...tuning, ...patch });
  const save = () => {
    if (naming?.trim()) onSavePreset(naming);
    setNaming(null);
  };
  const chip = (on: boolean) => `rounded-full px-2.5 py-0.5 text-[12.5px] ${on ? "bg-course/20 text-text ring-1 ring-course/60" : "border border-line text-muted hover:text-text"}`;

  return (
    <aside className="glass rise pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.7)]">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 font-cond text-[19px] font-semibold">Tune the map</h2>
        <button onClick={onRelayout} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:bg-white/5 hover:text-text" title="Let the layout settle again">
          Re-layout
        </button>
        <button onClick={() => onChange(DEFAULT_TUNING)} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:bg-white/5 hover:text-text">
          Reset all
        </button>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:bg-white/5 hover:text-text">
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
        {BUILT_IN.map((p) => (
          <button key={p.name} onClick={() => onApplyPreset(p)} aria-pressed={presetOn(p, tuning)} className={chip(presetOn(p, tuning))}>
            {p.name}
          </button>
        ))}
        {presets.map((p) => (
          <span key={`mine:${p.name}`} className={`${chip(presetOn(p, tuning))} flex items-center gap-1 pr-1`}>
            <button onClick={() => onApplyPreset(p)} title={p.headset ? "Saved in the headset: it sets the headset's knobs too" : undefined}>
              {p.name}
              {p.headset ? " ◐" : ""}
            </button>
            <button onClick={() => onDeletePreset(p.name)} className="px-0.5 text-muted/70 hover:text-bad" aria-label={`Delete ${p.name}`} title="Delete">
              ✕
            </button>
          </span>
        ))}
        {naming === null ? (
          <button onClick={() => setNaming("")} className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-[12.5px] text-muted hover:text-text" title="Keep the knobs as they are now, under a name">
            + Save as…
          </button>
        ) : (
          <input
            autoFocus
            value={naming}
            placeholder="Preset name"
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setNaming(null);
            }}
            onBlur={save}
            className="w-32 rounded-full border border-course/60 bg-transparent px-2.5 py-0.5 text-[12.5px] outline-none"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {SECTIONS.map((sec) => {
          const isOpen = !!open[sec.id];
          const dirty = sec.knobs.some((k) => tuning[k.key] !== DEFAULT_TUNING[k.key]);
          return (
            <section key={sec.id} className="border-b border-line/70">
              <div className="flex items-center px-4">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [sec.id]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex flex-1 items-center gap-2 py-2.5 text-left"
                >
                  <span className={`text-[11px] text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                  <span className="font-cond text-[16px] font-semibold">{sec.title}</span>
                  {dirty && <span className="h-1.5 w-1.5 rounded-full bg-course" title="Changed from default" />}
                </button>
                {dirty && (
                  <button
                    onClick={() => set(Object.fromEntries(sec.knobs.map((k) => [k.key, DEFAULT_TUNING[k.key]])) as Partial<Tuning>)}
                    className="rounded px-1.5 text-[12px] text-muted hover:text-text"
                  >
                    Reset
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="space-y-2.5 px-4 pb-3.5">
                  {sec.knobs.map((k) => (
                    <KnobRow key={k.key} knob={k} value={tuning[k.key]} onChange={(v) => set({ [k.key]: v } as Partial<Tuning>)} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function KnobRow({ knob, value, onChange }: { knob: Knob; value: number | boolean; onChange: (v: number | boolean) => void }) {
  // Shape knobs rebuild every body and force knobs reheat the layout: preview
  // the number while dragging, apply once on release.
  const deferred = SHAPE_KNOBS.includes(knob.key) || FORCE_KNOBS.includes(knob.key);
  const [draft, setDraft] = useState<number | null>(null);

  if ("toggle" in knob) {
    return (
      <label className="flex cursor-pointer items-center justify-between gap-3" title={knob.hint}>
        <span className="text-[13px]">{knob.label}</span>
        <button
          role="switch"
          aria-checked={!!value}
          onClick={() => onChange(!value)}
          className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${value ? "bg-course/70" : "bg-line"}`}
        >
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-text transition-all ${value ? "left-[16px]" : "left-[2px]"}`} />
        </button>
      </label>
    );
  }

  const shown = draft ?? (value as number);
  const digits = knob.step >= 1 ? 0 : knob.step >= 0.1 ? 1 : 2;
  const commit = () => {
    if (draft !== null) onChange(draft);
    setDraft(null);
  };

  return (
    <div title={knob.hint}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px]">{knob.label}</span>
        <span className={`font-mono text-[11.5px] tabular-nums ${shown !== value ? "text-course" : "text-muted"}`}>{shown.toFixed(digits)}</span>
      </div>
      <input
        type="range"
        min={knob.min}
        max={knob.max}
        step={knob.step}
        value={shown}
        aria-label={knob.label}
        onChange={(e) => (deferred ? setDraft(Number(e.target.value)) : onChange(Number(e.target.value)))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="mt-1 w-full accent-[var(--course)]"
      />
      {knob.hint && <p className="text-[11.5px] leading-snug text-muted/80">{knob.hint}</p>}
    </div>
  );
}
