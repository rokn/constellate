import { useEffect, useState } from "react";
import { BOARD_SECTIONS, BUILT_IN_PRESETS, DEFAULT_BOARD_TUNE, changedTune, type BoardPreset } from "../../shared/boardTune";
import { ACTION_IDS, actionById } from "../../shared/boardActions";
import { T, applyPreset, onTune, resetTune, setTune } from "./tune";

type Macro = { phrase: string; steps: string[] };

/** Voice macros: the phrases the voice was taught, and what each runs. Teach one by voice, or here. */
function Macros() {
  const [list, setList] = useState<Macro[]>([]);
  const [phrase, setPhrase] = useState("");
  const [steps, setSteps] = useState("");
  useEffect(() => {
    void fetch("/api/board/macros")
      .then((r) => r.json())
      .then(setList)
      .catch(() => {});
  }, []);
  const save = (next: Macro[]) => {
    setList(next);
    void fetch("/api/board/macros", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ macros: next }) });
  };
  return (
    <div className="mb-2 rounded border border-cyan-300/10 p-2 text-[12px]">
      <div className="ws-title mb-1">Macros</div>
      {list.map((m) => (
        <div key={m.phrase} className="group mb-1 flex items-start justify-between gap-2">
          <div>
            <span className="text-[#ffd08a]">“{m.phrase}”</span> <span className="text-[#7fa6bd]">{m.steps.join(" → ")}</span>
          </div>
          <button className="hidden text-red-300 group-hover:inline" onClick={() => save(list.filter((x) => x !== m))}>
            ✕
          </button>
        </div>
      ))}
      {!list.length && <div className="mb-1 text-[#7fa6bd]">Say “when I say ship it, run a review, save a version and export”.</div>}
      <div className="mt-1 flex flex-col gap-1">
        <input className="ws-input py-0.5 text-xs" placeholder="Phrase: ship it" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <input className="ws-input py-0.5 text-xs" placeholder="Steps, comma-separated: review, save-version, export" value={steps} onChange={(e) => setSteps(e.target.value)} />
        <button
          className="ws-btn !py-0.5 text-xs"
          disabled={!phrase.trim() || !steps.trim()}
          onClick={() => {
            save([...list.filter((m) => m.phrase !== phrase.trim().toLowerCase()), { phrase: phrase.trim().toLowerCase(), steps: steps.split(",").map((x) => x.trim()).filter(Boolean) }]);
            setPhrase("");
            setSteps("");
          }}
        >
          + Add macro
        </button>
      </div>
    </div>
  );
}

/**
 * Every knob in the workshop, on the desktop. Changes apply live and are kept
 * in this browser; presets (the built-in looks, and yours, kept on the
 * server for every device) set them all at once.
 */
export function TunePanel({ presets, onPresets, onClose }: { presets: BoardPreset[]; onPresets: (p: BoardPreset[]) => void; onClose: () => void }) {
  const [, force] = useState(0);
  useEffect(() => onTune(() => force((n) => n + 1)), []);
  const [open, setOpen] = useState<Record<string, boolean>>({ glow: true, holo: true });
  const [naming, setNaming] = useState<string | null>(null);
  const changed = Object.keys(changedTune(T));

  const save = (name: string) => {
    const n = name.trim();
    if (!n) return;
    const list = [...presets.filter((p) => p.name.toLowerCase() !== n.toLowerCase()), { name: n, values: changedTune(T) }];
    onPresets(list);
    void fetch("/api/board/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presets: list }) });
  };
  const del = (name: string) => {
    const list = presets.filter((p) => p.name !== name);
    onPresets(list);
    void fetch("/api/board/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ presets: list }) });
  };

  return (
    <div className="ws-panel absolute bottom-24 right-4 top-20 z-20 flex w-80 flex-col">
      <div className="flex items-center justify-between border-b border-cyan-300/10 px-3 py-2">
        <div className="ws-brand text-sm">TUNE</div>
        <div className="flex items-center gap-2 text-xs">
          {changed.length > 0 && (
            <button className="text-[#7fa6bd] hover:text-white" onClick={() => resetTune()}>
              reset all ({changed.length})
            </button>
          )}
          <button className="text-[#7fa6bd] hover:text-white" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="border-b border-cyan-300/10 px-3 py-2">
        <div className="ws-title mb-1.5">Presets</div>
        <div className="flex flex-wrap gap-1">
          {[...BUILT_IN_PRESETS, ...presets].map((p) => (
            <span key={p.name} className="group inline-flex items-center">
              <button className={`rounded px-2 py-0.5 text-xs ${p.builtIn ? "border border-cyan-300/25 text-[#cfeaf6]" : "border border-amber-300/40 text-[#ffd08a]"} hover:bg-cyan-300/10`} onClick={() => applyPreset(p.values)}>
                {p.name}
              </button>
              {!p.builtIn && (
                <button className="ml-0.5 hidden text-[10px] text-red-300 group-hover:inline" onClick={() => del(p.name)} title="Delete this preset">
                  ✕
                </button>
              )}
            </span>
          ))}
          {naming === null ? (
            <button className="rounded border border-dashed border-cyan-300/30 px-2 py-0.5 text-xs text-[#7fa6bd] hover:text-white" onClick={() => setNaming("")}>
              + save current
            </button>
          ) : (
            <input
              autoFocus
              className="ws-input w-32 py-0.5 text-xs"
              placeholder="Name, then ↵"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (save(naming), setNaming(null));
                if (e.key === "Escape") setNaming(null);
              }}
              onBlur={() => setNaming(null)}
            />
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto px-3 py-2">
        {BOARD_SECTIONS.map((s) => (
          <div key={s.id} className="mb-1">
            <button className="flex w-full items-center justify-between py-1.5" onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
              <span className="ws-title !text-[#9fc3d6]">
                {s.title}
                {s.where === "headset" && <span className="ml-1 normal-case tracking-normal opacity-50">(in the headset)</span>}
              </span>
              <span className="text-xs text-[#4f7286]">{open[s.id] ? "−" : "+"}</span>
            </button>
            {open[s.id] && s.id === "voice" && <Macros />}
            {open[s.id] && (
              <div className="space-y-2 pb-2">
                {s.knobs.map((k) => {
                  const v = T[k.key] ?? DEFAULT_BOARD_TUNE[k.key];
                  const isChanged = v !== DEFAULT_BOARD_TUNE[k.key];
                  return (
                    <div key={k.key} title={k.hint}>
                      <div className="flex items-center justify-between text-[12.5px]">
                        <span className={isChanged ? "text-[#ffd08a]" : "text-[#b9d8e6]"}>{k.label}</span>
                        {"choices" in k ? (
                          k.choices === ACTION_IDS || k.choices.length > 4 ? (
                            <select className="ws-input max-w-[9.5rem] py-0.5 text-[11px]" value={String(v)} onChange={(e) => setTune({ [k.key]: e.target.value })}>
                              {k.choices.map((ch) => (
                                <option key={ch} value={ch}>
                                  {actionById(ch)?.label ?? ch}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="flex gap-0.5">
                              {k.choices.map((ch) => (
                                <button key={ch} className={`rounded px-1.5 py-0.5 text-[11px] ${v === ch ? "bg-[#ffb547] text-[#02060d]" : "text-[#7fa6bd] hover:text-white"}`} onClick={() => setTune({ [k.key]: ch })}>
                                  {ch}
                                </button>
                              ))}
                            </span>
                          )
                        ) : "toggle" in k ? (
                          <button
                            className={`h-4 w-8 rounded-full transition ${v ? "bg-[#ffb547]" : "bg-[#1d3446]"}`}
                            onClick={() => setTune({ [k.key]: !v })}
                            aria-label={k.label}
                          >
                            <span className={`block h-3 w-3 rounded-full bg-white transition ${v ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                          </button>
                        ) : (
                          <span className="flex items-center gap-1 font-mono text-[11px] text-[#7fa6bd]">
                            {+Number(v).toFixed(3)}
                            {isChanged && (
                              <button className="text-[#4f7286] hover:text-white" onClick={() => setTune({ [k.key]: DEFAULT_BOARD_TUNE[k.key] })} title="Default">
                                ↺
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                      {"min" in k && (
                        <input type="range" className="ws-range w-full" min={k.min} max={k.max} step={k.step} value={Number(v)} onChange={(e) => setTune({ [k.key]: Number(e.target.value) })} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
