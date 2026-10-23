import { DEFAULT_TUNING, type Tuning } from "../../shared/tuning";

export * from "../../shared/tuning";

const KEY = "codeflight.tuning";

export function loadTuning(): Tuning {
  try {
    // Merged over the defaults, so a knob added later doesn't come back undefined.
    const t = { ...DEFAULT_TUNING, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Tuning>) };
    // 36 was the old default; a saved 36 means "never changed".
    if (t.fileLabelLimit === 36) t.fileLabelLimit = DEFAULT_TUNING.fileLabelLimit;
    return t;
  } catch {
    return DEFAULT_TUNING;
  }
}

export function saveTuning(t: Tuning) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* private mode: the knobs just don't persist */
  }
}
