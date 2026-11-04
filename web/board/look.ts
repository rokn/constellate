import * as THREE from "three";

/**
 * The workshop's look: light, not matter. Every solid is a faint fill that
 * brightens toward its silhouette (a fresnel rim) with horizontal scan lines
 * running up it, plus its edges drawn bright. Everything adds light, so it
 * glows over the room in passthrough and blooms in the dark.
 *
 * A new item "prints": a scan plane sweeps up through it and what's below
 * the plane appears, with a bright line at the plane itself.
 */

export const LOOK = {
  bg: "#02060d",
  accent: "#ffb547",
  select: "#ffb547",
  hover: "#ffffff",
  danger: "#ff4d5e",
  text: "#dff6ff",
  muted: "#7fa6bd",
  cyan: "#5fd4ff",
};

export const STATUS_COLOR: Record<string, string> = {
  idea: "#a98bff",
  planned: "#5fd4ff",
  building: "#ffb547",
  done: "#7dff9a",
  risk: "#ff4d5e",
};

/** What every holo material of one item shares: one set, so the whole item prints and lights together. */
export type HoloUniforms = {
  uTime: { value: number };
  uReveal: { value: number };
  uBase: { value: number };
  uHeight: { value: number };
  /** 0 normal, up to 1 lit (hovered or selected). */
  uLit: { value: number };
  uLitColor: { value: THREE.Color };
  /** Fades the whole item (being thrown away, or a ghost). */
  uFade: { value: number };
  uFillK?: { value: number };
  uRimK?: { value: number };
  uEdgeK?: { value: number };
  uScanK?: { value: number };
  uFlickK?: { value: number };
};

export function holoUniforms(): HoloUniforms {
  return {
    uTime: shared.uTime,
    uFillK: shared.uFillK,
    uRimK: shared.uRimK,
    uEdgeK: shared.uEdgeK,
    uScanK: shared.uScanK,
    uFlickK: shared.uFlickK,
    uReveal: { value: 1 },
    uBase: { value: 0 },
    uHeight: { value: 0.3 },
    uLit: { value: 0 },
    uLitColor: { value: new THREE.Color(LOOK.select) },
    uFade: { value: 1 },
  };
}

/** The clock every material reads. */
export const shared = {
  uTime: { value: 0 },
  // Tune knobs every hologram reads (see tune.ts).
  uFillK: { value: 1 },
  uRimK: { value: 1 },
  uEdgeK: { value: 1 },
  uScanK: { value: 1 },
  uFlickK: { value: 1 },
  uLinkK: { value: 1 },
  uFlowK: { value: 1 },
  uPacketK: { value: 1 },
  uTableK: { value: 1 },
  uColumnK: { value: 1 },
};

/**
 * Light added, never painted: colour adds, and coverage (alpha) adds only as
 * much as the light is bright. Passthrough (and the room behind) shows
 * through everything dim, so the table's wash never blacks out your desk.
 * The shaders below write premultiplied colour with alpha = its brightness.
 */
const additive = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
  toneMapped: false,
} as const;

/** The end of every holo shader: premultiplied light, its coverage its brightness. */
const LIGHT = /* glsl */ `
  vec4 light(vec3 c) { c = max(c, vec3(0.0)); return vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0)); }
`;


const COMMON = /* glsl */ `${LIGHT}
  uniform float uTime;
  uniform float uReveal;
  uniform float uBase;
  uniform float uHeight;
  uniform float uLit;
  uniform vec3 uLitColor;
  uniform float uFade;
  uniform float uFillK;
  uniform float uRimK;
  uniform float uEdgeK;
  uniform float uScanK;
  uniform float uFlickK;
  varying vec3 vWorld;
  // The print: what's above the scan plane isn't there yet; the plane itself burns bright.
  float reveal(out float edge) {
    // Printed: all of it, wherever it's moved since (the plane's height is only kept up while printing).
    if (uReveal >= 1.0) { edge = 0.0; return 1.0; }
    float h = uBase + uHeight * (uReveal * 1.25 - 0.1);
    float d = h - vWorld.y;
    edge = (uReveal < 1.0) ? smoothstep(0.012, 0.0, abs(d)) : 0.0;
    return step(0.0, d);
  }
`;

const FILL_VS = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - w.xyz);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FILL_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPulse;
  varying vec3 vNormal;
  varying vec3 vView;
  ${COMMON}
  void main() {
    float edge;
    float shown = reveal(edge);
    if (shown < 0.5 && edge < 0.01) discard;
    float f = 1.0 - abs(dot(normalize(vNormal), vView));
    float rim = pow(f, 2.2);
    float scan = 1.0 - uScanK * 0.18 * (1.0 - sin(vWorld.y * 520.0 - uTime * 3.0));
    float sweep = smoothstep(0.985, 1.0, sin(vWorld.y * 7.0 - uTime * 1.6));
    float pulse = 1.0 + uPulse * 0.6 * sin(uTime * 3.2);
    vec3 col = mix(uColor, uLitColor, uLit * 0.65);
    float a = (uOpacity * uFillK + rim * 0.5 * uRimK + sweep * 0.08 * uScanK) * scan * pulse * (1.0 + uLit * 0.25);
    a = a * shown + edge * 1.4;
    gl_FragColor = light(col * a * uFade);
  }
`;

const LINE_VS = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const LINE_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPulse;
  ${COMMON}
  void main() {
    float edge;
    float shown = reveal(edge);
    if (shown < 0.5 && edge < 0.01) discard;
    float flick = 1.0 - uFlickK * 0.08 * (1.0 - sin(uTime * 37.0 + vWorld.y * 40.0));
    float pulse = 1.0 + uPulse * 0.5 * sin(uTime * 3.2);
    vec3 col = mix(uColor, uLitColor, uLit * 0.8);
    float a = uOpacity * uEdgeK * flick * pulse * (1.0 + uLit * 0.3) * shown + edge * 1.5;
    gl_FragColor = light(col * a * uFade);
  }
`;


/** Near-white light saturates to a blank glare: pale colours shine at a little over half strength. */
function paleK(color: string) {
  const c = new THREE.Color(color);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum > 0.6 ? 0.55 : 1;
}

export function fillMaterial(u: HoloUniforms, color: string, opacity = 0.1, pulse = 0) {
  opacity *= paleK(color);
  return new THREE.ShaderMaterial({
    vertexShader: FILL_VS,
    fragmentShader: FILL_FS,
    uniforms: { ...u, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uPulse: { value: pulse } },
    side: THREE.DoubleSide,
    ...additive,
  });
}

export function lineMaterial(u: HoloUniforms, color: string, opacity = 0.9, pulse = 0) {
  opacity *= paleK(color);
  return new THREE.ShaderMaterial({
    vertexShader: LINE_VS,
    fragmentShader: LINE_FS,
    uniforms: { ...u, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uPulse: { value: pulse } },
    ...additive,
  });
}

/** A mesh as a hologram: its fill, and its edges as lines. Both carry `pickable` back to their item. */
export function holoMesh(geo: THREE.BufferGeometry, u: HoloUniforms, color: string, o: { opacity?: number; wire?: boolean; edgeAngle?: number; pulse?: number } = {}) {
  const g = new THREE.Group();
  if (!o.wire) {
    const fill = new THREE.Mesh(geo, fillMaterial(u, color, o.opacity ?? 0.1, o.pulse ?? 0));
    fill.renderOrder = 2;
    g.add(fill);
  }
  const eg = new THREE.EdgesGeometry(geo, o.edgeAngle ?? 24);
  // Many edges close together add up to a white blur: the denser, the fainter each.
  const n = eg.getAttribute("position").count / 2;
  const dense = Math.min(1, Math.sqrt(120 / Math.max(1, n)));
  const edges = new THREE.LineSegments(eg, lineMaterial(u, color, (o.wire ? 1 : 0.85) * Math.max(0.3, dense), o.pulse ?? 0));
  edges.renderOrder = 3;
  g.add(edges);
  // A wireframe-only part still needs something solid to point at.
  if (o.wire) {
    const hit = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    g.add(hit);
  }
  return g;
}

/* -------------------------------- links -------------------------------- */

const LINK_VS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const LINK_FS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uLen;
  uniform float uDash;
  uniform float uSpeed;
  uniform float uLit;
  uniform vec3 uLitColor;
  uniform float uReveal;
  uniform float uLinkK;
  uniform float uFlowK;
  uniform float uPacketK;
  uniform float uProto;
  varying vec2 vUv;
  ${LIGHT}
  float s;
  float pk;
  // A train of packets along the link: how many per metre, how fast, how long each is (0..1 of its slot).
  float ahead(float freq, float speed, float w) {
    float x = fract(s * freq * pk - uTime * speed * uFlowK);
    return smoothstep(0.0, w * 0.3, x) * smoothstep(w, w * 0.55, x);
  }
  float back(float freq, float speed, float w) {
    float x = fract(s * freq * pk + uTime * speed * uFlowK);
    return smoothstep(0.0, w * 0.3, x) * smoothstep(w, w * 0.55, x);
  }
  void main() {
    if (vUv.x > uReveal) discard;
    s = vUv.x * uLen;
    pk = max(0.05, uPacketK);
    float on = uPacketK > 0.0 ? 1.0 : 0.0;
    float sp = uSpeed;
    float packet = 0.0;
    float base = 0.45;
    vec3 col = uColor;
    int p = int(uProto + 0.5);
    if (p == 1 || p == 8) {
      // REST / HTTP: a request out, its smaller response back.
      packet = ahead(4.0, sp, 0.28) + 0.5 * back(5.0, sp * 1.2, 0.16);
    } else if (p == 2) {
      // gRPC: tight, fast pairs both ways (streams).
      packet = ahead(14.0, sp * 2.0, 0.35) + 0.8 * back(14.0, sp * 2.0, 0.35);
      base = 0.35;
    } else if (p == 3) {
      // GraphQL: one shaped query out, colours shifting.
      packet = ahead(5.0, sp, 0.32);
      col = mix(uColor, vec3(1.0, 0.31, 0.85), 0.5 + 0.5 * sin(s * 18.0 - uTime * 3.0));
    } else if (p == 4) {
      // Kafka: a dense, ordered stream of beads.
      packet = 0.8 * ahead(32.0, sp * 1.1, 0.5);
      base = 0.3;
    } else if (p == 5) {
      // A queue: messages bunching up and draining.
      float bunch = 0.5 + 0.5 * sin(s * 4.0 - uTime * 0.9 * uFlowK);
      packet = ahead(16.0, sp * 0.8, 0.45) * smoothstep(0.35, 0.9, bunch);
    } else if (p == 6) {
      // WebSocket: always open, waves both ways.
      packet = 0.3 + 0.35 * (0.5 + 0.5 * sin(s * 30.0 * pk - uTime * 5.0 * uFlowK)) + 0.35 * (0.5 + 0.5 * sin(s * 30.0 * pk + uTime * 5.0 * uFlowK));
      base = 0.5;
    } else if (p == 7) {
      // SQL: heavy chunks, slow.
      packet = 1.2 * ahead(2.4, sp * 0.45, 0.6);
    } else if (p == 9) {
      // Events: sparse bright sparks.
      packet = 1.6 * ahead(2.5, sp * 0.9, 0.12);
    } else if (p == 10) {
      // Files: long slow blocks.
      packet = ahead(1.2, sp * 0.3, 0.85);
    } else {
      float flow = fract(s * 9.0 * pk - uTime * uSpeed * uFlowK);
      packet = smoothstep(0.0, 0.15, flow) * smoothstep(0.55, 0.3, flow);
    }
    packet *= on;
    float dash = uDash > 0.5 ? step(0.45, fract(s * 22.0 - uTime * uSpeed * uFlowK * 0.6)) : 1.0;
    col = mix(col, uLitColor, uLit * 0.7);
    float a = uOpacity * uLinkK * (base + 0.9 * packet) * dash * (1.0 + uLit * 0.7);
    gl_FragColor = light(col * a);
  }
`;

export function linkMaterial(color: string, o: { dashed?: boolean; opacity?: number; speed?: number; len: number; proto?: number }) {
  return new THREE.ShaderMaterial({
    vertexShader: LINK_VS,
    fragmentShader: LINK_FS,
    uniforms: {
      uTime: shared.uTime,
      uLinkK: shared.uLinkK,
      uFlowK: shared.uFlowK,
      uPacketK: shared.uPacketK,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: o.opacity ?? 0.9 },
      uLen: { value: o.len },
      uDash: { value: o.dashed ? 1 : 0 },
      uSpeed: { value: o.speed ?? 1.2 },
      uLit: { value: 0 },
      uLitColor: { value: new THREE.Color(LOOK.select) },
      uReveal: { value: 1 },
      uProto: { value: o.proto ?? 0 },
    },
    ...additive,
  });
}

/* ------------------------------- labels -------------------------------- */

export const FONT = '"Barlow Condensed", "Barlow", ui-sans-serif, sans-serif';
export const FONT_BODY = '"Barlow", ui-sans-serif, system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

/**
 * A floating label: upper-case condensed type with a bracket under it, as a
 * sprite that always faces you. `height` is its height in metres.
 */
export function labelSprite(text: string, color: string, o: { height?: number; sub?: string; bracket?: boolean } = {}) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const px = 64;
  ctx.font = `600 ${px}px ${FONT}`;
  const main = text.toUpperCase();
  const sub = o.sub?.toUpperCase();
  const w1 = ctx.measureText(main).width + main.length * 4;
  ctx.font = `500 ${px * 0.55}px ${FONT}`;
  const w2 = sub ? ctx.measureText(sub).width + sub.length * 3 : 0;
  const W = Math.ceil(Math.max(w1, w2) + 40);
  const H = sub ? 150 : 110;
  c.width = W;
  c.height = H;
  ctx.font = `600 ${px}px ${FONT}`;
  ctx.letterSpacing = "4px";
  ctx.textAlign = "center";
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.95;
  ctx.fillText(main, W / 2, 66);
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillText(main, W / 2, 66);
  if (o.bracket !== false) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, 84);
    ctx.lineTo(10, 92);
    ctx.lineTo(W - 10, 92);
    ctx.lineTo(W - 10, 84);
    ctx.stroke();
  }
  if (sub) {
    ctx.font = `500 ${px * 0.55}px ${FONT}`;
    ctx.letterSpacing = "3px";
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = color;
    ctx.fillText(sub, W / 2, 132);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = flatCapable(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  const s = new THREE.Sprite(mat);
  const h = o.height ?? 0.032;
  s.scale.set((h * W) / 110, (h * H) / 110, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 6;
  return s;
}

/**
 * A sprite's material that can also lie flat: with its `uFlat` on, the sprite
 * is drawn as a plain quad turned by its own rotation (and its parents'), not
 * turned to face the camera. What lets a label stay put on a board hung on a
 * wall instead of following your head (see `faceWall`).
 */
export function flatCapable(mat: THREE.SpriteMaterial) {
  const uFlat = { value: 0 };
  mat.userData.uFlat = uFlat;
  mat.side = THREE.DoubleSide;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFlat = uFlat;
    sh.vertexShader = sh.vertexShader
      .replace("uniform float rotation;", "uniform float rotation;\nuniform float uFlat;")
      .replace("mvPosition.xy += rotatedPosition;", "if (uFlat > 0.5) mvPosition = modelViewMatrix * vec4(position.xy - (center - vec2(0.5)), 0.0, 1.0);\n\telse mvPosition.xy += rotatedPosition;");
  };
  mat.customProgramCacheKey = () => "flat-sprite";
  return mat;
}

const TO_WALL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _up = new THREE.Vector3();

/** Whether a board (its rig or stage group) stands up, as on a wall: its up isn't the room's. */
export function standsUp(board: THREE.Object3D) {
  board.getWorldQuaternion(_wq);
  return Math.abs(_up.set(0, 1, 0).applyQuaternion(_wq).y) < 0.5;
}

/**
 * The labels on a board, lying flat on it when it stands on a wall (upright,
 * reading level, facing out of the wall), or facing you as sprites do when
 * it lies as a table. Run each frame, after the items have moved.
 */
export function faceWall(board: THREE.Object3D, flat: boolean) {
  board.traverse((o) => {
    if (!(o as THREE.Sprite).isSprite) return;
    const u = ((o as THREE.Sprite).material.userData as { uFlat?: { value: number } }).uFlat;
    if (!u) return;
    u.value = flat ? 1 : 0;
    if (!flat) return;
    // Its parents' turn, from the board down: the label undoes it, then lies on the board, facing out.
    _q.identity();
    for (let n = o.parent; n && n !== board; n = n.parent) _q.premultiply(n.quaternion);
    o.quaternion.copy(_q.invert()).multiply(TO_WALL);
  });
}

/** A canvas texture of wrapped text on glass: notes. */
export function noteTexture(body: string, color: string, wPx: number, hPx: number, title?: string) {
  const c = document.createElement("canvas");
  c.width = wPx;
  c.height = hPx;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, hPx);
  g.addColorStop(0, hexA(color, 0.22));
  g.addColorStop(1, hexA(color, 0.08));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, wPx, hPx);
  // Corner brackets.
  ctx.strokeStyle = hexA(color, 0.95);
  ctx.lineWidth = 6;
  const k = Math.min(wPx, hPx) * 0.12;
  for (const [x, y, dx, dy] of [
    [4, 4, 1, 1],
    [wPx - 4, 4, -1, 1],
    [4, hPx - 4, 1, -1],
    [wPx - 4, hPx - 4, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * k);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * k, y);
    ctx.stroke();
  }
  ctx.strokeStyle = hexA(color, 0.35);
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, wPx - 8, hPx - 8);
  const pad = wPx * 0.07;
  let y = pad;
  if (title) {
    ctx.font = `600 ${Math.round(wPx * 0.075)}px ${FONT}`;
    ctx.letterSpacing = "3px";
    ctx.fillStyle = color;
    y += wPx * 0.07;
    ctx.fillText(title.toUpperCase(), pad, y);
    y += wPx * 0.03;
  }
  const size = Math.round(wPx * 0.062);
  ctx.font = `500 ${size}px ${FONT_BODY}`;
  ctx.letterSpacing = "0px";
  ctx.fillStyle = "#f2fbff";
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  const lh = size * 1.3;
  for (const para of body.split("\n")) {
    const words = para.split(/\s+/);
    let line = "";
    const flush = () => {
      y += lh;
      if (y < hPx - pad * 0.6) ctx.fillText(line, pad, y);
      line = "";
    };
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > wPx - pad * 2 && line) {
        flush();
        line = w;
      } else line = t;
    }
    flush();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function hexA(hex: string, a: number) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;
}

/* ------------------------------ holotable ------------------------------ */

/**
 * The round table the board stands on: rings, spokes, ticks and two slow
 * arcs turning at its rim, with a faint column of light rising off it.
 */
export function makeTable(radius = 1.4) {
  const g = new THREE.Group();
  g.name = "holotable";
  const u = holoUniforms();
  const col = new THREE.Color(LOOK.cyan);
  const line = (pts: THREE.Vector3[], opacity: number, loop = false) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const m = lineMaterial(u, `#${col.getHexString()}`, opacity);
    return loop ? new THREE.LineLoop(geo, m) : new THREE.LineSegments(geo, m);
  };
  const circle = (r: number, n = 128) => Array.from({ length: n }, (_, i) => new THREE.Vector3(Math.cos((i / n) * Math.PI * 2) * r, 0.001, Math.sin((i / n) * Math.PI * 2) * r));

  // Rings: the outer one strong, the inner ones faint.
  g.add(line(circle(radius), 0.5, true));
  g.add(line(circle(radius * 1.02), 0.15, true));
  for (let k = 1; k < 5; k++) g.add(line(circle((radius * k) / 5), 0.13, true));
  // Spokes.
  const spokes: THREE.Vector3[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    spokes.push(new THREE.Vector3(Math.cos(a) * radius * 0.2, 0.001, Math.sin(a) * radius * 0.2), new THREE.Vector3(Math.cos(a) * radius, 0.001, Math.sin(a) * radius));
  }
  g.add(line(spokes, 0.07));
  // Ticks round the rim.
  const ticks: THREE.Vector3[] = [];
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    const l = i % 15 === 0 ? 0.06 : i % 5 === 0 ? 0.035 : 0.018;
    ticks.push(new THREE.Vector3(Math.cos(a) * radius, 0.001, Math.sin(a) * radius), new THREE.Vector3(Math.cos(a) * (radius - l), 0.001, Math.sin(a) * (radius - l)));
  }
  g.add(line(ticks, 0.32));

  // Two arcs that turn slowly, opposite ways.
  const arcs = new THREE.Group();
  const arc = (r: number, from: number, to: number) => Array.from({ length: 40 }, (_, i) => {
    const a = from + ((to - from) * i) / 39;
    return new THREE.Vector3(Math.cos(a) * r, 0.002, Math.sin(a) * r);
  });
  const a1 = new THREE.Group();
  for (let k = 0; k < 3; k++) a1.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc(radius * 1.05, k * 2.1, k * 2.1 + 0.9)), lineMaterial(u, LOOK.cyan, 0.55)));
  const a2 = new THREE.Group();
  for (let k = 0; k < 4; k++) a2.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc(radius * 0.62, k * 1.57, k * 1.57 + 0.5)), lineMaterial(u, LOOK.accent, 0.3)));
  arcs.add(a1, a2);
  g.add(arcs);

  // A faint disc of light, brightest at the rim.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uR; uniform float uTime; uniform float uTableK; varying vec2 vP;
        ${LIGHT}
        void main(){
          float r = length(vP) / uR;
          float glow = 0.012 + 0.05 * pow(r, 8.0);
          float grid = (step(0.985, fract(vP.x * 10.0)) + step(0.985, fract(vP.y * 10.0))) * 0.012;
          float sweep = smoothstep(0.03, 0.0, abs(fract(r * 1.0 - uTime * 0.12) - 0.5)) * 0.03;
          gl_FragColor = light(vec3(0.37, 0.83, 1.0) * (glow + grid + sweep) * uTableK);
        }`,
      uniforms: { uR: { value: radius }, uTime: shared.uTime, uTableK: shared.uTableK },
      ...additive,
    }),
  );
  disc.renderOrder = 0;
  g.add(disc);

  // A column of light rising off the rim, fading up.
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.5, 96, 1, true).translate(0, 0.25, 0),
    new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `uniform float uColumnK; varying float vY; ${LIGHT} void main(){ float a = pow(1.0 - clamp(vY / 0.5, 0.0, 1.0), 4.0) * 0.025 * uColumnK; gl_FragColor = light(vec3(0.37, 0.83, 1.0) * a); }`,
      uniforms: { uColumnK: shared.uColumnK },
      side: THREE.DoubleSide,
      ...additive,
    }),
  );
  g.add(column);

  let turn = 0;
  let last = 0;
  const tick = (t: number, speed = 1) => {
    turn += (t - last) * speed;
    last = t;
    a1.rotation.y = turn * 0.05;
    a2.rotation.y = -turn * 0.08;
  };
  return { group: g, tick, u };
}

/** Dust drifting in the air over the table. */
export function makeDust(radius = 1.6, n = 500) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(Math.random()) * radius;
    const a = Math.random() * Math.PI * 2;
    pos.set([Math.cos(a) * r, Math.random() * 1.1, Math.sin(a) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: LOOK.cyan, size: 0.004, sizeAttenuation: true, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  const tick = (t: number, amount = 1) => {
    pts.visible = amount > 0;
    (pts.material as THREE.PointsMaterial).opacity = 0.5 * Math.min(1, amount);
    pts.material.size = 0.004 * Math.max(1, amount);
    pts.rotation.y = t * 0.01;
    pts.position.y = Math.sin(t * 0.2) * 0.01;
  };
  return { points: pts, tick };
}
