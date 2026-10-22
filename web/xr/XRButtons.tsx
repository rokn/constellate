import type { XR } from "./useXR";

/** Into the headset: shown only when one is there. (Out again from the headset's own menu, or by taking it off.) */
export function XRButtons({ xr }: { xr: XR }) {
  const { support, entering, error } = xr;
  if (!support.vr && !support.ar) return null;
  const pill = "glass pointer-events-auto rounded-full px-3.5 py-1.5 font-cond text-[14px] font-semibold tracking-wide text-text hover:text-course disabled:opacity-40";
  return (
    <div className="flex flex-col items-end gap-1.5">
      {error && <p className="max-w-[260px] text-right text-[12.5px] text-bad">{error}</p>}
      <div className="flex gap-1.5">
        {support.vr && (
          <button className={pill} disabled={entering} onClick={() => void xr.enter("vr")} title="Fly the map in VR">
            VR
          </button>
        )}
        {support.ar && (
          <button className={pill} disabled={entering} onClick={() => void xr.enter("ar")} title="The map in your room, in passthrough">
            Passthrough
          </button>
        )}
      </div>
    </div>
  );
}
