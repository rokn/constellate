import { DEFAULT_XR, type XRSettings } from "../../shared/xrSettings";

export * from "../../shared/xrSettings";

/** The voice volume as last set, for audio that isn't played from React state (story narration). */
export const sound = { volume: DEFAULT_XR.voiceVolume };

const KEY = "constellate.xr";

export function loadXR(): XRSettings {
  try {
    return { ...DEFAULT_XR, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<XRSettings>) };
  } catch {
    return DEFAULT_XR;
  }
}

export function saveXR(s: XRSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: the knobs just don't persist */
  }
}
