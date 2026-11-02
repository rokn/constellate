import type { Board } from "../../shared/board";

/**
 * Pictures for the builder: a photo of a whiteboard (a file, a paste, the
 * headset's camera), and the board's own ink drawn flat from above so a
 * sketch can become real blocks and links.
 */

export type Picture = { data: string; mediaType: "image/jpeg" | "image/png" };

/** Any image, at most `max` px on its longer side, as a JPEG for the builder. */
export async function pictureOf(src: Blob | HTMLVideoElement | HTMLCanvasElement, max = 1600): Promise<Picture> {
  let w: number;
  let h: number;
  let draw: CanvasImageSource;
  if (src instanceof Blob) {
    const bmp = await createImageBitmap(src);
    w = bmp.width;
    h = bmp.height;
    draw = bmp;
  } else if (src instanceof HTMLVideoElement) {
    w = src.videoWidth;
    h = src.videoHeight;
    draw = src;
  } else {
    w = src.width;
    h = src.height;
    draw = src;
  }
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext("2d")!.drawImage(draw, 0, 0, c.width, c.height);
  return { data: c.toDataURL("image/jpeg", 0.85).split(",")[1], mediaType: "image/jpeg" };
}

/**
 * A frame from the camera facing out: on a Quest, the passthrough camera
 * (Horizon OS lets the browser have it, once you allow it). `tick` hears the
 * countdown, to say it.
 */
export async function cameraPhoto(tick: (left: number) => void, seconds = 3): Promise<Picture> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  try {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = seconds; i > 0; i--) {
      tick(i);
      await new Promise((r) => setTimeout(r, 1000));
    }
    tick(0);
    return await pictureOf(v);
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/**
 * The ink (all of it, or the strokes given), drawn from above: white on
 * black, the table's back at the top. With where it is on the board, so what
 * the builder makes can stand where the strokes were.
 */
export function sketchPicture(b: Board, ids?: string[]): { picture: Picture; note: string; inkIds: string[] } | null {
  const inks = b.items.filter((i) => i.kind === "ink" && (!ids?.length || ids.includes(i.id)) && i.points?.length);
  if (!inks.length) return null;
  const pts = inks.flatMap((i) => i.points!.map((p) => [i.pos[0] + p[0], i.pos[2] + p[2]] as [number, number]));
  const x0 = Math.min(...pts.map((p) => p[0]));
  const x1 = Math.max(...pts.map((p) => p[0]));
  const z0 = Math.min(...pts.map((p) => p[1]));
  const z1 = Math.max(...pts.map((p) => p[1]));
  const span = Math.max(0.05, x1 - x0, z1 - z0);
  const S = 1024;
  const pad = 48;
  const k = (S - pad * 2) / span;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const u = (x: number) => pad + (x - x0) * k;
  const v = (z: number) => pad + (z - z0) * k;
  for (const i of inks) {
    ctx.beginPath();
    i.points!.forEach((p, n) => (n ? ctx.lineTo(u(i.pos[0] + p[0]), v(i.pos[2] + p[2])) : ctx.moveTo(u(i.pos[0] + p[0]), v(i.pos[2] + p[2]))));
    ctx.stroke();
  }
  const m = 1 / k;
  const note = `The picture is the ink on the board seen from above (the table's back at the top, its front — toward them — at the bottom). A pixel (u, v) is the board point x = ${(x0 - pad * m).toFixed(3)} + u × ${m.toFixed(5)}, z = ${(z0 - pad * m).toFixed(3)} + v × ${m.toFixed(5)} (y = 0). The ink strokes are items ${inks.map((i) => i.id).join(", ")}.`;
  return { picture: { data: c.toDataURL("image/png").split(",")[1], mediaType: "image/png" }, note, inkIds: inks.map((i) => i.id) };
}
