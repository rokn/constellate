import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Layer, LogicalEdge, LogicalModule, Overview, RepoGraph } from "../../shared/types";
import { COURSE, RUNTIME, STATIC, territoryColors } from "../lib/colors";
import { FORCE_KNOBS, SHAPE_KNOBS, type Tuning } from "../lib/tuning";

/**
 * The space you fly through.
 *
 * Files are bodies sized by their length and coloured by territory (top-level
 * directory); directories are the faint scaffolding that holds territories
 * together; logical modules, once the navigator has charted them, are amber
 * wireframe beacons tethered to the files they own, with runtime links arcing
 * between them. Imports are cyan routes, visible on demand and lit when
 * you're looking at both ends.
 *
 * The course — where you have flown — is drawn as a dashed magenta line
 * through the actual positions you visited, so the history of the session is
 * a thing in the space, not a list in a sidebar.
 */

type NodeType = "file" | "dir" | "module";
type N = {
  id: string;
  type: NodeType;
  label: string;
  top?: string;
  loc?: number;
  depth?: number;
  x?: number;
  y?: number;
  z?: number;
};
type LinkType = "import" | "contains" | "member" | "logical";
type L = {
  source: string | N;
  target: string | N;
  type: LinkType;
  label?: string;
  /** Import links: what travels them, and where the import is written. */
  names?: string[];
  line?: number;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The hover tag on an import line: who imports whom, where, and what. */
function importTag(l: L): string {
  const from = typeof l.source === "string" ? l.source : l.source.id;
  const to = typeof l.target === "string" ? l.target : l.target.id;
  const names = l.names ?? [];
  const shown = names.slice(0, 10).map(esc).join(", ");
  return [
    `<b>${esc(from.split("/").pop()!)}</b>${l.line ? `<span style="opacity:.55">:${l.line}</span>` : ""} → <b>${esc(to.split("/").pop()!)}</b>`,
    `<span style="opacity:.55">${esc(from)} → ${esc(to)}</span>`,
    names.length ? `<span style="color:#5bd6ff">${shown}${names.length > 10 ? ` +${names.length - 10} more` : ""}</span>` : `<span style="opacity:.55">side-effect import</span>`,
    `<span style="opacity:.45">click to open the import</span>`,
  ].join("<br/>");
}

type Obj = { group: THREE.Group; mesh: THREE.Mesh; base: number; label?: SpriteText; fileLabel?: SpriteText };

/** A way of organizing the map: files gathered around group beacons. */
export type Grouping = { key: string; groups: LogicalModule[]; edges: LogicalEdge[] };

const OTHER = "__other";

/** One white ring, tinted per group by the sprite's colour. Made once. */
let ringTexture: THREE.CanvasTexture | null = null;
function ringMap() {
  if (ringTexture) return ringTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.stroke();
  ringTexture = new THREE.CanvasTexture(c);
  return ringTexture;
}
/** A file can wear rings for this many groups before it gets too busy to read. */
const MAX_RINGS = 4;

/**
 * A group drawn on top of the map without reorganizing it: a beacon that
 * floats at the centre of its files with faint spokes out to each one. It takes
 * no part in the layout, so whatever separation the map has stays as it is.
 */
export type Overlay = {
  id: string;
  label: string;
  paths: string[];
  color: string;
  /** Why each file is in the group: shown on its spoke. */
  reasons?: Record<string, string>;
  summary?: string;
  by?: "you" | "navigator";
};

/** Blend toward `to` by t; used to turn a 0..1 brightness knob into a colour. */
const mix = (from: string, to: string, t: number) => `#${new THREE.Color(from).lerp(new THREE.Color(to), Math.max(0, Math.min(1, t))).getHexString()}`;

export type SpaceHandle = {
  /** `shift` slides the framing sideways to clear docked panels; see flyToPoint. */
  flyTo: (path: string, shift?: number) => void;
  focus: (paths: string[], shift?: number) => void;
  focusModule: (id: string, shift?: number) => void;
  overview: () => void;
  pulse: (path: string) => void;
  warp: () => void;
  /** Reheat the simulation so the layout settles again. */
  relayout: () => void;
};

// Labels are drawn to canvas, which won't wait for a web font: without a
// fallback stack the first ones come out in the browser's default serif.
const FONT_COND = '"Barlow Condensed", "Barlow", ui-sans-serif, sans-serif';
const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';

const endId = (e: string | N) => (typeof e === "string" ? e : e.id);
const MAX_ROUTE = 48;

export function Space({
  ref,
  graph,
  overview,
  grouping,
  overlays,
  visible,
  tuning,
  layers,
  emphasis,
  active,
  onPick,
  onPickModule,
  onPickDir,
  onPickOverlay,
  onHideOverlay,
  onHide,
  onOpenImport,
  onBackground,
}: {
  ref: Ref<SpaceHandle>;
  graph: RepoGraph;
  overview?: Overview;
  /** Organize by these groups instead of by folder. Null means folders. */
  grouping: Grouping | null;
  /** Groups drawn on top of the current organization, without moving anything. */
  overlays: Overlay[];
  /** Files the filter keeps; null means all of them. */
  visible: Set<string> | null;
  tuning: Tuning;
  layers: Record<Layer, boolean>;
  /** Files to keep lit; everything else dims. Empty means nothing dims. */
  emphasis: string[];
  /** The file open in the code panel — gets the course halo. */
  active: string | null;
  onPick: (path: string) => void;
  onPickModule: (id: string) => void;
  onPickDir: (dir: string) => void;
  onPickOverlay: (id: string) => void;
  /** Right-click on a group's beacon: hide that group from view. */
  onHideOverlay: (id: string) => void;
  /** Right-click: hide this file, or everything under this folder. */
  onHide: (target: { file: string } | { dir: string }) => void;
  /** Click on an import line: open the importing file at its import. */
  onOpenImport: (from: string, line?: number) => void;
  onBackground: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraph3DInstance<N, L> | null>(null);
  const nodes = useRef(new Map<string, N>());
  const objs = useRef(new Map<string, Obj>());
  const pulses = useRef(new Map<string, number>());
  const route = useRef<string[][]>([]);
  const routeLine = useRef<THREE.Line | null>(null);
  const halo = useRef<THREE.Mesh | null>(null);
  const built = useRef(false);
  /** What the graph was last built from, so an identical rebuild is skipped. */
  const builtKey = useRef("");
  const refit = useRef<ReturnType<typeof setTimeout>>(undefined);
  const state = useRef({
    emphasis: new Set<string>(),
    active: null as string | null,
    layers,
    overview,
    /** True when organized by a grouping rather than by folder. */
    grouped: false,
    /** Body colour per file: territory in folder mode, group in group mode. */
    fileColor: new Map<string, string>(),
    groupColor: new Map<string, string>(),
    tuning,
    /** How many files import each file, for the size-by-importers knob. */
    inDegree: new Map<string, number>(),
    /** The map's clusters — modules, or the groups when organized by them — for auto-aim. */
    clusters: [] as { id: string; label: string; members: string[] }[],
  });
  /** The current knob values, read at the moment of use. */
  const tu = () => state.current.tuning;
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const starMat = useRef<THREE.PointsMaterial | null>(null);
  const overlayObjs = useRef(
    new Map<
      string,
      {
        beacon: THREE.Group;
        mesh: THREE.Mesh;
        hit: THREE.Mesh;
        spokes: THREE.LineSegments;
        members: string[];
        /** The members drawn this frame, in spoke order — for finding a hovered spoke's file. */
        shown: string[];
        info: Overlay;
      }
    >(),
  );
  const handlers = useRef({ onPick, onPickModule, onPickDir, onPickOverlay, onHideOverlay, onHide, onOpenImport, onBackground });
  handlers.current = { onPick, onPickModule, onPickDir, onPickOverlay, onHideOverlay, onHide, onOpenImport, onBackground };
  /** Group membership rings: one sprite per (group, file), drawn around the file. */
  const rings = useRef<{ sprite: THREE.Sprite; path: string; k: number }[]>([]);
  /** The import line under the pointer, lit while hovered. */
  const hoverLink = useRef<L | null>(null);
  /**
   * When a group beacon was just clicked. The release event must still reach
   * the orbit controls (swallowing it left them thinking the button was held,
   * so the camera orbited with every mouse move), so instead the library's own
   * click handling ignores the same click for a moment.
   */
  const beaconClickAt = useRef(0);
  /** Where the dolly-through wheel is easing the camera to, if anywhere. */
  const dollyGoal = useRef<{ cam: THREE.Vector3; target: THREE.Vector3; at: number } | null>(null);
  /**
   * A camera flight in progress. Ours rather than the library's, because the
   * library's can't be stopped: a drag that starts mid-flight would have the
   * camera dragged back to the flight's path every frame.
   */
  const camAnim = useRef<{ fromCam: THREE.Vector3; fromTarget: THREE.Vector3; toCam: THREE.Vector3; toTarget: THREE.Vector3; t0: number; ms: number } | null>(null);
  /** When you last moved the camera yourself. Automatic moves scheduled before that are dropped. */
  const userCamAt = useRef(0);
  const beaconJustClicked = () => performance.now() - beaconClickAt.current < 250;
  /** When the focus is larger than the label limit, the files that still get names. */
  const labelled = useRef(new Set<string>());

  /* ------------------------------- boot -------------------------------- */

  useEffect(() => {
    const host = el.current!;
    const g = new ForceGraph3D(host, { controlType: "orbit" }) as unknown as ForceGraph3DInstance<N, L>;
    fg.current = g;

    // The library hands the clear colour to the renderer as raw numbers, and
    // the composer treats those as linear and sRGB-encodes them — the night
    // came out slate. So it gets the night already in linear space.
    g.backgroundColor(`#${new THREE.Color("#060b16").getHexString(THREE.LinearSRGBColorSpace)}`)
      .showNavInfo(false)
      .nodeId("id")
      .nodeLabel((n) =>
        n.type === "file"
          ? `${n.id}<br/><span style="opacity:.6">${n.loc ?? 0} lines</span>`
          : n.type === "module"
            ? `<b>${n.label}</b>`
            : `${n.id.slice(4)}/`,
      )
      .nodeThreeObject((n) => objectFor(n))
      .linkCurvature((l) => (l.type === "logical" ? tu().curvature : 0))
      .linkDirectionalArrowLength((l) => (l.type === "logical" ? 5 : 0))
      .linkDirectionalArrowRelPos(0.92)
      .linkDirectionalArrowColor(() => (state.current.emphasis.size ? "#4a3510" : RUNTIME))
      .linkDirectionalParticleColor((l) => (l.type === "logical" ? RUNTIME : STATIC))
      .linkDirectionalParticleWidth((l) => (l.type === "logical" ? 2.2 : 1.4) * tu().particleSize)
      .linkDirectionalParticleSpeed((l) => (l.type === "logical" ? 0.006 : 0.012) * tu().particleSpeed)
      .linkOpacity(tu().linkOpacity)
      .warmupTicks(40)
      .cooldownTime(tu().settleSeconds * 1000)
      .d3VelocityDecay(tu().friction)
      .onNodeClick((n) => {
        if (beaconJustClicked()) return;
        if (n.type === "file") handlers.current.onPick(n.id);
        else if (n.type === "module") handlers.current.onPickModule(n.id.slice(4));
        else handlers.current.onPickDir(n.id.slice(4));
      })
      // A right-click that isn't a pan hides what's under it.
      .onNodeRightClick((n) => {
        if (beaconJustClicked()) return;
        if (n.type === "file") handlers.current.onHide({ file: n.id });
        else if (n.type === "dir" && n.id !== "dir:.") handlers.current.onHide({ dir: n.id.slice(4) });
      })
      // No dragging bodies around: a press on a body should orbit like
      // anywhere else, and the library's drag-end path fakes a touch pointerup
      // that crashes the orbit controls.
      .enableNodeDrag(false)
      // Import lines are a pixel wide; give the pointer some slack.
      .linkHoverPrecision(4)
      // Only lit import lines (both ends in the focus) answer the pointer; the
      // grey resting web would otherwise pop tags everywhere you move.
      .onLinkHover((l) => {
        const next = l && litImport(l) ? l : null;
        if (next === hoverLink.current) return;
        hoverLink.current = next;
        applyAll();
      })
      .onLinkClick((l) => {
        if (!beaconJustClicked() && litImport(l)) handlers.current.onOpenImport(endId(l.source), l.line);
      })
      .onBackgroundClick(() => {
        if (!beaconJustClicked()) handlers.current.onBackground();
      });

    setForces();

    // Bloom is what turns flat dots into bodies in a night sky.
    // Tight radius and a real threshold: a wide bloom smears the bright core
    // across the whole sky and the night turns grey.
    const bloom = new UnrealBloomPass(new THREE.Vector2(host.clientWidth, host.clientHeight), tu().bloomStrength, tu().bloomRadius, tu().bloomThreshold);
    bloomRef.current = bloom;
    g.postProcessingComposer().addPass(bloom);
    // The composer renders in linear space; without this the final frame is
    // never converted to sRGB.
    g.postProcessingComposer().addPass(new OutputPass());

    if (import.meta.env.DEV) (window as unknown as { __space: unknown }).__space = { g, bloom, THREE, overlays: overlayObjs.current };

    // A far starfield, so there is something to fly *past*.
    const starGeo = new THREE.BufferGeometry();
    const pts = new Float32Array(2400 * 3);
    for (let i = 0; i < 2400; i++) {
      const r = 2600 + Math.random() * 3200;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pts.set([r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t), r * Math.cos(p)], i * 3);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    starMat.current = new THREE.PointsMaterial({ color: 0x8fa3c8, size: tu().starSize, sizeAttenuation: false, transparent: true, opacity: tu().starOpacity });
    g.scene().add(new THREE.Points(starGeo, starMat.current));

    // The course line and the halo around the open file.
    const line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_ROUTE * 3), 3)),
      new THREE.LineDashedMaterial({ color: COURSE, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.9 }),
    );
    line.frustumCulled = false;
    g.scene().add(line);
    routeLine.current = line;

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 8, 48),
      new THREE.MeshBasicMaterial({ color: COURSE, transparent: true, opacity: 0.95 }),
    );
    ring.visible = false;
    g.scene().add(ring);
    halo.current = ring;

    const controls = g.controls() as unknown as OrbitControls;
    controls.autoRotateSpeed = tu().autoRotateSpeed;
    // Left orbits; middle (and right) pan; the wheel zooms toward whatever is
    // under the pointer, the way map and CAD tools do. Damping makes each
    // gesture glide to a stop instead of halting dead.
    // Holding the right button flies instead (see below).
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: -1 as THREE.MOUSE };
    controls.screenSpacePanning = true;
    controls.enableDamping = true;
    applyControls();
    // Middle-click would otherwise start the browser's autoscroll.
    const noAutoscroll = (e: MouseEvent) => e.button === 1 && e.preventDefault();
    host.addEventListener("mousedown", noAutoscroll);

    // Group beacons aren't part of the graph library's scene graph, so clicks
    // on them are picked here first. Capture phase: a hit stops the event
    // before the library sees it, so a file behind the beacon doesn't open too.
    const raycaster = new THREE.Raycaster();
    const overlayAt = (e: PointerEvent): string | null => {
      const rect = host.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, g.camera());
      const live = [...overlayObjs.current.entries()].filter(([, o]) => o.beacon.visible);
      const hits = raycaster.intersectObjects(live.map(([, o]) => o.hit), false);
      if (!hits.length) return null;
      return live.find(([, o]) => o.hit === hits[0].object)?.[0] ?? null;
    };

    /** The group spoke under the pointer, if any: which group, which file. */
    const spokeAt = (e: PointerEvent): { id: string; path: string } | null => {
      const rect = host.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const camera = g.camera();
      raycaster.setFromCamera(ndc, camera);
      // A hit zone of a few pixels at any zoom: scale the threshold with distance.
      const target = (g.controls() as unknown as OrbitControls).target;
      raycaster.params.Line = { threshold: camera.position.distanceTo(target) * 0.006 };
      const live = [...overlayObjs.current.entries()].filter(([, o]) => o.spokes.visible);
      const hits = raycaster.intersectObjects(live.map(([, o]) => o.spokes), false);
      // Where spokes cross, the ray meets several; the one meant is the one
      // nearest the pointer on screen, not the nearest along the ray.
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let h: (typeof hits)[number] | undefined;
      let best = Infinity;
      for (const hit of hits) {
        const p = ((hit as { pointOnLine?: THREE.Vector3 }).pointOnLine ?? hit.point).clone().project(camera);
        const d = Math.hypot(((p.x + 1) / 2) * rect.width - px, ((1 - p.y) / 2) * rect.height - py);
        if (d < best) {
          best = d;
          h = hit;
        }
      }
      if (!h || h.index === undefined) return null;
      const entry = live.find(([, o]) => o.spokes === h.object);
      const path = entry?.[1].shown[Math.floor(h.index / 2)];
      return entry && path ? { id: entry[0], path } : null;
    };

    // The tag shown on a hovered beacon or spoke; styled like the map's own tooltip.
    const tip = document.createElement("div");
    tip.className = "scene-tooltip";
    Object.assign(tip.style, { position: "absolute", pointerEvents: "none", display: "none", zIndex: "5", maxWidth: "360px", lineHeight: "1.45" });
    host.appendChild(tip);
    const showTip = (e: PointerEvent, html: string | null) => {
      if (!html) {
        tip.style.display = "none";
        return;
      }
      const r = host.getBoundingClientRect();
      tip.innerHTML = html;
      tip.style.display = "block";
      tip.style.left = `${e.clientX - r.left + 14}px`;
      tip.style.top = `${e.clientY - r.top + 14}px`;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      takeCamera();
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      // A drag that ends on a beacon is still an orbit, not a click.
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      const id = overlayAt(e);
      if (id) {
        beaconClickAt.current = performance.now();
        handlers.current.onPickOverlay(id);
        return;
      }
      // A click on a spoke opens the file at its end.
      const spoke = spokeAt(e);
      if (spoke) {
        beaconClickAt.current = performance.now();
        handlers.current.onPick(spoke.path);
      }
    };
    const onHover = (e: PointerEvent) => {
      if (e.buttons || !overlayObjs.current.size) return showTip(e, null);
      const beacon = overlayAt(e);
      const spoke = beacon ? null : spokeAt(e);
      const over = !!(beacon || spoke);
      host.style.cursor = over ? "pointer" : "";
      g.renderer().domElement.style.cursor = over ? "pointer" : "";
      if (beacon) {
        const o = overlayObjs.current.get(beacon)!.info;
        showTip(
          e,
          [
            `<b style="color:${o.color}">${esc(o.label)}</b> <span style="opacity:.55">· ${o.paths.length} files · by ${o.by === "navigator" ? "the navigator" : "you"}</span>`,
            o.summary ? esc(o.summary) : "",
            `<span style="opacity:.45">click to fly to the group</span>`,
          ].filter(Boolean).join("<br/>"),
        );
      } else if (spoke) {
        const o = overlayObjs.current.get(spoke.id)!.info;
        const why = o.reasons?.[spoke.path];
        showTip(
          e,
          [
            `<b style="color:${o.color}">${esc(o.label)}</b> → <b>${esc(spoke.path.split("/").pop()!)}</b>`,
            `<span style="opacity:.55">${esc(spoke.path)}</span>`,
            why ? esc(why) : `<span style="opacity:.55">no reason recorded</span>`,
            `<span style="opacity:.45">click to open the file</span>`,
          ].join("<br/>"),
        );
      } else showTip(e, null);
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointerup", onUp, true);
    host.addEventListener("pointermove", onHover, true);
    // Right-click on a beacon hides its group (it stays in the Groups panel).
    // macOS sends contextmenu on press, before we know whether the press is a
    // flight, so the hide happens on release (in endFlight) instead.
    const onContext = (e: MouseEvent) => e.preventDefault();
    host.addEventListener("contextmenu", onContext);

    /* ---- dolly through: the wheel flies toward what's under the pointer ---- */

    const sceneSpan = () => {
      let r = 0;
      for (const n of nodes.current.values()) if (n.x !== undefined) r = Math.max(r, Math.hypot(n.x, n.y!, n.z!));
      return Math.max(r, 200);
    };
    /** The nearest body along a ray, skipping ones we're already inside. */
    const bodyAlong = (origin: THREE.Vector3, dir: THREE.Vector3) => {
      let best: { t: number; r: number } | null = null;
      const w = new THREE.Vector3();
      for (const n of nodes.current.values()) {
        if (n.x === undefined) continue;
        w.set(n.x - origin.x, n.y! - origin.y, n.z! - origin.z);
        const t = w.dot(dir);
        const r = objs.current.get(n.id)?.base ?? 2;
        if (t < r * 2.5) continue;
        const off = w.addScaledVector(dir, -t).length();
        if (off > Math.max(r * 2, t * 0.035)) continue;
        if (!best || t < best.t) best = { t, r };
      }
      return best;
    };
    const onWheel = (e: WheelEvent) => {
      if (flight) return;
      // Scrolling is taking the camera, whichever zoom does the work.
      const chaining = !!dollyGoal.current;
      const goalBefore = dollyGoal.current;
      takeCamera();
      dollyGoal.current = chaining ? goalBefore : null;
      if (!tu().dollyThrough) return;
      e.preventDefault();
      e.stopPropagation();
      controls.autoRotate = false;
      const camera = g.camera();
      // Chain from where the last step was heading, so fast scrolling adds up.
      const cam = dollyGoal.current?.cam.clone() ?? camera.position.clone();
      const target = dollyGoal.current?.target.clone() ?? controls.target.clone();
      const forward = target.clone().sub(cam);
      const pivot = forward.length();
      forward.normalize();
      let dir = forward.clone();
      if (tu().zoomToCursor) {
        const rect = host.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        // The ray from the goal position, with the camera's (unchanged) orientation.
        const probe = camera.clone();
        probe.position.copy(cam);
        probe.updateMatrixWorld();
        raycaster.setFromCamera(ndc, probe);
        dir = raycaster.ray.direction.clone();
      }
      const span = sceneSpan();
      const floor = span * 0.06;
      // Pixels, lines or pages: one notch is about 100px. Trackpads send many small ones.
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      const amount = Math.min(Math.abs(px) / 100, 3) * 0.17 * (tu().zoomSpeed / 1.6);
      const aim = px < 0 && tu().autoAim ? aimFor(e, cam, dir) : null;
      // Arrived and still scrolling: on through it, down the middle of the view
      // (the pointer is wherever the target was before the view turned to it).
      if (aim === "through") dir = forward.clone();
      else if (aim) {
        // Turn onto it while closing in, easing to a stop where it's framed.
        const to = aim.point.clone().sub(cam);
        const dist = to.length();
        to.normalize();
        const remaining = dist - aim.stop;
        const go = Math.min(remaining, Math.max(remaining * amount * 1.6, span * 0.003));
        // The last step faces it square; the ones before turn part of the way.
        const turn = Math.min(1, Math.max(0.35, go / remaining));
        const face = forward.clone().lerp(to, turn).normalize();
        cam.addScaledVector(to, go);
        dollyGoal.current = { cam, target: cam.clone().addScaledVector(face, Math.max(dist - go, floor * 0.25)), at: performance.now() };
        return;
      }
      let step: number;
      let ahead: number;
      if (px < 0) {
        // In: pace by whatever is ahead, never quite stalling on it — once
        // you're at it, the next thing along the ray takes over.
        const body = bodyAlong(cam, dir);
        const d = body ? body.t : Math.max(pivot, floor);
        step = Math.max(d * amount, span * 0.004);
        // The pivot settles on that body while it's still ahead; past it, it's pushed on.
        ahead = body && body.t - step > body.r * 2.5 ? (body.t - step) * dir.dot(forward) : Math.max(pivot - step * dir.dot(forward), floor);
      } else {
        step = -Math.max(pivot, floor) * amount;
        ahead = pivot - step * dir.dot(forward);
        // Don't back out into the void.
        if (cam.clone().addScaledVector(dir, step).length() > span * 8) return;
      }
      cam.addScaledVector(dir, step);
      dollyGoal.current = { cam, target: cam.clone().addScaledVector(forward, Math.max(ahead, floor * 0.25)), at: performance.now() };
    };
    host.addEventListener("wheel", onWheel, { capture: true, passive: false });

    /* ---- auto-aim: scrolling toward a cluster or a file homes in on it ---- */

    // What the wheel is homing in on. Held while you keep scrolling with the
    // mouse still — the view turns, so the pointer soon stops being over it.
    let aimLock: { kind: "cluster" | "body"; id: string; x: number; y: number; at: number; reached?: boolean } | null = null;
    const clusterShape = (members: string[]) => {
      const c = centroid(members);
      if (!c) return null;
      const ds = members
        .map((p) => nodes.current.get(p))
        .filter((n): n is N => n?.x !== undefined)
        .map((n) => Math.hypot(n.x! - c.x, n.y! - c.y, n.z! - c.z))
        .sort((a, b) => a - b);
      // Most of it, not the stragglers.
      const r = Math.max(30, ds[Math.floor(ds.length * 0.8)] ?? 30);
      return { point: new THREE.Vector3(c.x, c.y, c.z), r };
    };
    const bodyShape = (id: string) => {
      const n = nodes.current.get(id);
      if (n?.x === undefined) return null;
      const r = objs.current.get(id)?.base ?? 2;
      return { point: new THREE.Vector3(n.x, n.y!, n.z!), r };
    };
    /** Framed distances: a cluster fills the view, a file sits close with room around it. */
    const clusterStop = (r: number) => r * 2.4 + 40;
    const bodyStop = (r: number) => Math.max(r * 12, 45);
    const aimFor = (e: WheelEvent, cam: THREE.Vector3, dir: THREE.Vector3) => {
      const now = performance.now();
      const held = aimLock && now - aimLock.at < 700 && Math.hypot(e.clientX - aimLock.x, e.clientY - aimLock.y) < 40 ? aimLock : null;
      let pick: { kind: "cluster" | "body"; id: string; label: string; point: THREE.Vector3; stop: number } | null = null;
      // Reached it already: keep going the way you're facing, past it.
      if (held?.reached) {
        held.at = now;
        return "through" as const;
      }
      if (held) {
        const c = held.kind === "cluster" ? state.current.clusters.find((x) => x.id === held.id) : null;
        const shape = c ? clusterShape(c.members) : held.kind === "body" ? bodyShape(held.id) : null;
        if (shape) {
          pick = {
            kind: held.kind,
            id: held.id,
            label: c?.label ?? held.id.split("/").pop()!,
            point: shape.point,
            stop: held.kind === "cluster" ? clusterStop(shape.r) : bodyStop(shape.r),
          };
        }
      }
      if (!pick) {
        // A cluster the pointer is over and you're still outside of — nearest first.
        let best: { t: number; c: (typeof state.current.clusters)[number]; point: THREE.Vector3; r: number } | null = null;
        for (const c of state.current.clusters) {
          const shape = clusterShape(c.members);
          if (!shape) continue;
          const w = shape.point.clone().sub(cam);
          const t = w.dot(dir);
          if (t <= 0 || w.length() < clusterStop(shape.r) * 1.08) continue;
          if (w.addScaledVector(dir, -t).length() > shape.r * 0.9) continue;
          if (!best || t < best.t) best = { t, c, point: shape.point, r: shape.r };
        }
        // The file under the pointer.
        let body: { id: string; t: number; r: number } | null = null;
        const w = new THREE.Vector3();
        for (const n of nodes.current.values()) {
          if (n.type !== "file" || n.x === undefined) continue;
          w.set(n.x - cam.x, n.y! - cam.y, n.z! - cam.z);
          const t = w.dot(dir);
          const r = objs.current.get(n.id)?.base ?? 2;
          if (t <= 0) continue;
          if (w.addScaledVector(dir, -t).length() > Math.max(r * 2.5, t * 0.04)) continue;
          if (!body || t < body.t) body = { id: n.id, t, r };
        }
        // A cluster you're outside of wins, unless the file is in front of it rather than part of it.
        if (best && !(body && body.t < best.t - best.r)) {
          pick = { kind: "cluster", id: best.c.id, label: best.c.label, point: best.point, stop: clusterStop(best.r) };
        } else if (body) {
          pick = { kind: "body", id: body.id, label: body.id.split("/").pop()!, point: bodyShape(body.id)!.point, stop: bodyStop(body.r) };
        }
      }
      if (pick && cam.distanceTo(pick.point) < pick.stop * 1.05) {
        // Arrived. Held: carry on through it; otherwise plain dolly-through.
        if (held) {
          held.at = now;
          held.reached = true;
          return "through" as const;
        }
        aimLock = null;
        return null;
      }
      if (!pick) {
        aimLock = null;
        return null;
      }
      aimLock = { kind: pick.kind, id: pick.id, x: e.clientX, y: e.clientY, at: now };
      showTip(e as unknown as PointerEvent, `<span style="opacity:.6">aiming at</span> <b>${esc(pick.label)}</b>`);
      return pick;
    };

    /* ---- fly mode: hold the right button; mouse looks, WASD moves ---- */

    let flight: {
      id: number;
      x: number;
      y: number;
      moved: number;
      keyed: boolean;
      pivot: number;
      yaw: number;
      pitch: number;
      last: number;
    } | null = null;
    const keys = new Set<string>();
    let flySpeed = 1;
    const hint = document.createElement("div");
    hint.className = "scene-tooltip";
    Object.assign(hint.style, {
      position: "absolute",
      left: "50%",
      top: "18%",
      transform: "translateX(-50%)",
      pointerEvents: "none",
      display: "none",
      zIndex: "5",
      whiteSpace: "nowrap",
    });
    host.appendChild(hint);
    const showHint = () => {
      hint.innerHTML = `Flying · <b>WASD</b> move · <b>Q / E</b> down / up · <b>Shift</b> faster · wheel speed <b>×${flySpeed.toFixed(flySpeed < 1 ? 2 : 1)}</b>`;
    };
    const FLY_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
    const onFlyKey = (e: KeyboardEvent) => {
      if (!flight || !FLY_KEYS.has(e.code)) return;
      // Ours while flying: the app's shortcuts mustn't see these.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "keydown") {
        keys.add(e.code);
        if (!e.code.startsWith("Shift")) flight.keyed = true;
      } else keys.delete(e.code);
    };
    const startFlight = (e: PointerEvent) => {
      const camera = g.camera();
      takeCamera();
      controls.autoRotate = false;
      controls.enabled = false;
      const f = camera.getWorldDirection(new THREE.Vector3());
      flight = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: 0,
        keyed: false,
        pivot: camera.position.distanceTo(controls.target),
        yaw: Math.atan2(-f.x, -f.z),
        pitch: Math.asin(Math.max(-1, Math.min(1, f.y))),
        last: performance.now(),
      };
      // Look straight with world-up, whatever roll orbiting left behind.
      camera.up.set(0, 1, 0);
      showTip(e, null);
    };
    const endFlight = (e: PointerEvent | null) => {
      if (!flight) return;
      const f = flight;
      flight = null;
      keys.clear();
      hint.style.display = "none";
      host.style.cursor = "";
      g.renderer().domElement.style.cursor = "";
      if (e && host.hasPointerCapture?.(f.id)) host.releasePointerCapture(f.id);
      const camera = g.camera();
      const forward = camera.getWorldDirection(new THREE.Vector3());
      // Orbit, from here on, around what's ahead: the nearest body, else where the pivot was.
      const flew = f.keyed || f.moved > 5;
      const body = flew ? bodyAlong(camera.position, forward) : null;
      controls.target.copy(camera.position).addScaledVector(forward, body?.t ?? f.pivot);
      controls.enabled = true;
      controls.update();
      if (flew) {
        // A flight, not a click: the graph's own right-click must not hide anything.
        beaconClickAt.current = performance.now();
        return;
      }
      // A plain right-click on a beacon hides its group (it stays in the Groups panel).
      const id = e && overlayAt(e);
      if (id) {
        beaconClickAt.current = performance.now();
        handlers.current.onHideOverlay(id);
      }
    };
    const onFlyDown = (e: PointerEvent) => {
      if (e.button !== 2 || e.pointerType !== "mouse") return;
      startFlight(e);
    };
    const onFlyMove = (e: PointerEvent) => {
      if (!flight || e.pointerId !== flight.id) return;
      if (!(e.buttons & 2)) return endFlight(e);
      flight.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (flight.moved > 5 || flight.keyed) {
        // Keep the mouse ours past the window edge — only once it's a flight:
        // capturing retargets the release, and a plain right-click's release
        // must still reach the graph (that's how it hides a body).
        if (!host.hasPointerCapture?.(flight.id)) host.setPointerCapture?.(flight.id);
        hint.style.display = "block";
        showHint();
        host.style.cursor = g.renderer().domElement.style.cursor = "crosshair";
      }
      const k = 0.0028 * tu().rotateSpeed;
      flight.yaw -= e.movementX * k;
      flight.pitch = Math.max(-1.5, Math.min(1.5, flight.pitch - e.movementY * k));
      g.camera().rotation.set(flight.pitch, flight.yaw, 0, "YXZ");
    };
    const onFlyUp = (e: PointerEvent) => {
      if (flight && e.button === 2) endFlight(e);
    };
    const onFlyWheel = (e: WheelEvent) => {
      if (!flight) return;
      e.preventDefault();
      e.stopPropagation();
      flySpeed = Math.max(0.05, Math.min(20, flySpeed * (e.deltaY < 0 ? 1.25 : 0.8)));
      hint.style.display = "block";
      showHint();
    };
    const onBlur = () => endFlight(null);
    host.addEventListener("pointerdown", onFlyDown, true);
    host.addEventListener("pointermove", onFlyMove, true);
    host.addEventListener("pointerup", onFlyUp, true);
    host.addEventListener("wheel", onFlyWheel, { capture: true, passive: false });
    window.addEventListener("keydown", onFlyKey, true);
    window.addEventListener("keyup", onFlyKey, true);
    window.addEventListener("blur", onBlur);
    const flyStep = (now: number) => {
      if (!flight) return;
      const dt = Math.min(0.05, (now - flight.last) / 1000);
      flight.last = now;
      const camera = g.camera();
      const v = new THREE.Vector3(
        (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
        (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0),
        (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0),
      );
      if (!v.lengthSq()) return;
      // A tenth of the map a second at speed ×1; Shift for four times that.
      const speed = sceneSpan() * 0.1 * flySpeed * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4 : 1);
      v.normalize().applyQuaternion(camera.quaternion).multiplyScalar(speed * dt);
      camera.position.add(v);
    };
    // Grabbing the map is a request to stop drifting.
    controls.addEventListener("start", () => (controls.autoRotate = false));

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (flight) flyStep(now);
      else {
        const anim = camAnim.current;
        const goal = dollyGoal.current;
        if (anim) {
          const camera = g.camera();
          const k = Math.min(1, (now - anim.t0) / anim.ms);
          // Quadratic out, the target turning faster than the camera travels.
          const ease = (x: number) => 1 - (1 - x) * (1 - x);
          camera.position.lerpVectors(anim.fromCam, anim.toCam, ease(k));
          controls.target.lerpVectors(anim.fromTarget, anim.toTarget, ease(Math.min(1, k * 3)));
          if (k >= 1) camAnim.current = null;
        } else if (goal) {
          const camera = g.camera();
          camera.position.lerp(goal.cam, 0.22);
          controls.target.lerp(goal.target, 0.22);
          // Settled, or (if something keeps nudging it) given up on after a
          // second, so a stale goal can never hold the camera.
          if (camera.position.distanceToSquared(goal.cam) < 0.01 || now - goal.at > 1000) {
            if (now - goal.at <= 1000) {
              camera.position.copy(goal.cam);
              controls.target.copy(goal.target);
            }
            dollyGoal.current = null;
          }
        }
        controls.update();
      }

      for (const [id, t0] of pulses.current) {
        const o = objs.current.get(id);
        const k = (now - t0) / 1600;
        if (!o || k >= 1) {
          if (o) o.mesh.scale.setScalar(1);
          pulses.current.delete(id);
          if (o) applyOne(id);
          continue;
        }
        o.mesh.scale.setScalar(1 + 2.2 * Math.sin(Math.PI * k) * (1 - k));
        (o.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
      }

      // The course follows the bodies as the layout settles.
      const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      let n = 0;
      for (const stop of route.current) {
        const c = centroid(stop);
        if (!c) continue;
        pos.setXYZ(n++, c.x, c.y, c.z);
      }
      line.geometry.setDrawRange(0, n);
      pos.needsUpdate = true;
      line.computeLineDistances();
      line.visible = n > 1 && tu().showCourse;

      // Overlay beacons ride the centre of their files; spokes reach out to
      // each one. Nothing here feeds back into the layout.
      for (const ov of overlayObjs.current.values()) {
        const members = ov.members.filter((p) => nodes.current.get(p)?.x !== undefined);
        const c = centroid(members);
        const beaconsOn = state.current.layers.beacons !== false;
        ov.beacon.visible = !!c && beaconsOn;
        ov.spokes.visible = !!c && beaconsOn && tu().groupSpokes > 0;
        if (!c) continue;
        ov.beacon.position.set(c.x, c.y, c.z);
        ov.beacon.scale.setScalar(tu().groupBeaconSize);
        const sp = ov.spokes.geometry.getAttribute("position") as THREE.BufferAttribute;
        const shown = Math.min(members.length, sp.count / 2);
        ov.shown = members.slice(0, shown);
        for (let i = 0; i < shown; i++) {
          const m = nodes.current.get(members[i])!;
          sp.setXYZ(i * 2, c.x, c.y, c.z);
          sp.setXYZ(i * 2 + 1, m.x!, m.y!, m.z!);
        }
        ov.spokes.geometry.setDrawRange(0, shown * 2);
        sp.needsUpdate = true;
      }

      // Membership rings ride their files; concentric when a file is in
      // several groups. They fade with the rest of the map outside a focus.
      const ringsOn = state.current.layers.beacons !== false && tu().groupRings > 0;
      const emphasis = state.current.emphasis;
      for (const r of rings.current) {
        const n = nodes.current.get(r.path);
        if (!ringsOn || n?.x === undefined) {
          r.sprite.visible = false;
          continue;
        }
        r.sprite.visible = true;
        r.sprite.position.set(n.x, n.y!, n.z!);
        const base = objs.current.get(r.path)?.base ?? 2;
        // Clear of the body's own glow, with a visible step between concentric rings.
        r.sprite.scale.setScalar(base * 2 * (2.1 + 0.6 * r.k));
        (r.sprite.material as THREE.SpriteMaterial).opacity =
          tu().groupRings * (emphasis.size && !emphasis.has(r.path) ? 0.2 : 1);
      }

      const a = state.current.active && nodes.current.get(state.current.active);
      if (a && a.x !== undefined) {
        const o = objs.current.get(a.id);
        ring.visible = true;
        ring.position.set(a.x, a.y!, a.z!);
        ring.scale.setScalar(((o?.base ?? 2) * 2.4 + 1.5) * tu().haloSize);
        ring.visible = tu().haloSize > 0;
        ring.lookAt(g.camera().position);
      } else ring.visible = false;
    };
    tick();

    const ro = new ResizeObserver(() => {
      g.width(host.clientWidth).height(host.clientHeight);
      bloom.setSize(host.clientWidth, host.clientHeight);
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("mousedown", noAutoscroll);
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("pointerup", onUp, true);
      host.removeEventListener("pointermove", onHover, true);
      host.removeEventListener("contextmenu", onContext);
      host.removeEventListener("wheel", onWheel, true);
      host.removeEventListener("pointerdown", onFlyDown, true);
      host.removeEventListener("pointermove", onFlyMove, true);
      host.removeEventListener("pointerup", onFlyUp, true);
      host.removeEventListener("wheel", onFlyWheel, true);
      window.removeEventListener("keydown", onFlyKey, true);
      window.removeEventListener("keyup", onFlyKey, true);
      window.removeEventListener("blur", onBlur);
      tip.remove();
      hint.remove();
      g._destructor();
      host.innerHTML = "";
      fg.current = null;
      objs.current.clear();
      nodes.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ objects ------------------------------ */

  function objectFor(n: N): THREE.Object3D {
    const cached = objs.current.get(n.id);
    if (cached) return cached.group;
    const group = new THREE.Group();
    let mesh: THREE.Mesh;
    let base: number;
    let label: SpriteText | undefined;

    if (n.type === "file") {
      // Importers boost on a log scale: a file 7 others import doubles at 1×,
      // and a 300-importer hub grows a few times over rather than swallowing the map.
      const boost = 1 + (tu().sizeByImporters * Math.log2(1 + (state.current.inDegree.get(n.id) ?? 0))) / 3;
      base = Math.min(7, 1.1 + (Math.sqrt(n.loc ?? 1) / 5.5) * tu().sizeByLines) * tu().nodeSize * boost;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(base, 14, 10),
        new THREE.MeshBasicMaterial({ color: state.current.fileColor.get(n.id) ?? "#9aa", transparent: true, opacity: 0.92 }),
      );
    } else if (n.type === "module") {
      // Overview modules are amber beacons; a grouping's beacons wear their
      // group's colour, matching the bodies gathered around them.
      const tint = n.id.startsWith("grp:") ? state.current.groupColor.get(n.id.slice(4)) ?? RUNTIME : RUNTIME;
      base = (n.id.startsWith("grp:") ? 8 : 6.5) * tu().beaconSize;
      mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(base, 1),
        new THREE.MeshBasicMaterial({ color: tint, wireframe: true, transparent: true, opacity: 0.32 }),
      );
      label = new SpriteText(n.label, (n.id.startsWith("grp:") ? 7.5 : 6) * tu().labelSize, tint);
      label.fontFace = FONT_COND;
      label.fontWeight = "600";
      label.position.y = base + 7;
    } else {
      base = 0.8;
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(base, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x3a4a6c, transparent: true, opacity: 0.7 }),
      );
      if ((n.depth ?? 9) <= tu().folderLabelDepth) {
        label = new SpriteText(n.label, ((n.depth ?? 0) <= 0 ? 6.5 : 4.2) * tu().labelSize, "#b9c4da");
        label.fontFace = FONT_COND;
        label.fontWeight = "500";
        label.position.y = 5;
      }
    }
    group.add(mesh);
    if (label) group.add(label);
    objs.current.set(n.id, { group, mesh, base, label });
    applyOne(n.id);
    return group;
  }

  function centroid(ids: string[]) {
    let x = 0, y = 0, z = 0, k = 0;
    for (const id of ids) {
      const n = nodes.current.get(id);
      if (n?.x === undefined) continue;
      x += n.x; y += n.y!; z += n.z!; k++;
    }
    return k ? { x: x / k, y: y / k, z: z / k, k } : null;
  }

  /** Brings one node's look in line with the current emphasis and layers. */
  function applyOne(id: string) {
    const o = objs.current.get(id);
    const n = nodes.current.get(id);
    if (!o || !n) return;
    const { emphasis: emph, layers: lay, active: act } = state.current;
    const mat = o.mesh.material as THREE.MeshBasicMaterial;
    const lit = emph.size === 0 || emph.has(id) || id === act;

    if (n.type === "file") {
      mat.opacity = lit ? tu().bodyOpacity : tu().dimOpacity;
      // Names appear on the bodies you're looking at, never on all of them:
      // a focus within the limit is named in full; a bigger one gets names on
      // its most-imported files, up to the limit, rather than none at all.
      const wantLabel =
        id === act || (emph.size > 0 && emph.has(id) && (emph.size <= tu().fileLabelLimit || labelled.current.has(id)));
      if (wantLabel && !o.fileLabel) {
        const t = new SpriteText(id.split("/").pop()!, 2.6 * tu().labelSize, "#e4eaf4");
        t.fontFace = FONT_MONO;
        t.position.y = o.base + 3;
        o.group.add(t);
        o.fileLabel = t;
      }
      if (o.fileLabel) o.fileLabel.visible = wantLabel;
    } else if (n.type === "module") {
      // Group beacons are the organization itself, so they stay; the
      // overview's module beacons belong to the runtime layer.
      o.group.visible = lay.beacons !== false && (n.id.startsWith("grp:") || lay.logical);
      mat.opacity = emph.size === 0 ? tu().beaconOpacity : tu().beaconOpacity * 0.3;
      if (o.label) {
        o.label.visible = tu().showBeaconLabels;
        o.label.material.opacity = emph.size === 0 ? 1 : 0.22;
      }
    } else {
      o.group.visible = lay.folders !== false;
      mat.opacity = emph.size === 0 ? tu().folderPointOpacity : tu().folderPointOpacity * 0.2;
      if (o.label) {
        // Territory names are for the overview; up close they balloon into
        // the view, so they step out while you're focused on something.
        o.label.visible = lay.labels && emph.size === 0;
      }
    }
  }

  /** An import line both of whose ends are in the focus — the lit ones. */
  function litImport(l: L) {
    const emph = state.current.emphasis;
    return l.type === "import" && emph.has(endId(l.source)) && emph.has(endId(l.target));
  }

  /** The files that keep a name when the focus outgrows the label limit. */
  function pickLabelled() {
    const { emphasis: emph } = state.current;
    const limit = tu().fileLabelLimit;
    if (emph.size <= limit) return (labelled.current = new Set());
    const ranked = [...emph].sort((a, b) => (state.current.inDegree.get(b) ?? 0) - (state.current.inDegree.get(a) ?? 0));
    labelled.current = new Set(ranked.slice(0, limit));
  }

  function applyAll() {
    pickLabelled();
    for (const id of objs.current.keys()) applyOne(id);
    const g = fg.current;
    if (!g) return;
    const { emphasis: emph, layers: lay } = state.current;
    const both = (l: L) => emph.has(endId(l.source)) && emph.has(endId(l.target));
    // Fresh accessor functions, so the library re-evaluates every link.
    g.linkVisibility((l) =>
      l.type === "member" ? false
        : l.type === "logical" ? lay.logical
          : l.type === "import" ? lay.imports || both(l)
            : lay.folders !== false,
    )
      .linkColor((l) =>
        // While focused, the runtime arcs step back to a dim ember so the
        // constellation you flew to is the brightest thing in view.
        l === hoverLink.current ? "#eafcff"
        : l.type === "logical" ? (emph.size ? "#4a3510" : RUNTIME)
          : l.type === "import" ? (both(l) ? STATIC : mix("#060b16", STATIC, tu().importBrightness * (emph.size ? 0.35 : 0.9)))
            : mix("#060b16", "#3a4f7a", tu().folderLinkBrightness * (emph.size ? 0.4 : 1)),
      )
      .linkWidth((l) =>
        l === hoverLink.current ? 1.4
          : l.type === "logical" ? tu().runtimeWidth
            : l.type === "import" && both(l) ? tu().importWidth : 0,
      )
      .linkDirectionalParticles((l) =>
        l === hoverLink.current ? 4
          : l.type === "logical" ? (emph.size ? 0 : tu().particles)
            : l.type === "import" && both(l) ? Math.min(2, tu().particles) : 0,
      );
  }

  /* -------------------------------- data -------------------------------- */

  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    const grouped = !!grouping;
    const shown = (p: string) => !visible || visible.has(p);
    const inDegree = new Map<string, number>();
    for (const e of graph.imports) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    state.current.inDegree = inDegree;
    const files = graph.files.filter((f) => shown(f.path));

    // Which group each file belongs to (first group wins), and the colours.
    const groupOf = new Map<string, string>();
    const groups = grouping ? [...grouping.groups] : [];
    if (grouping) {
      for (const gr of grouping.groups) for (const p of gr.paths) if (!groupOf.has(p)) groupOf.set(p, gr.id);
      if (files.some((f) => !groupOf.has(f.path))) {
        groups.push({ id: OTHER, label: "Other", summary: "Not part of any group", paths: [] });
      }
    }
    const groupColor = territoryColors(groups.filter((x) => x.id !== OTHER).map((x) => x.id));
    groupColor.set(OTHER, "#5d6a85");
    const territory = territoryColors(graph.files.map((f) => f.top));
    const fileColor = new Map(
      files.map((f) => [f.path, grouped ? groupColor.get(groupOf.get(f.path) ?? OTHER)! : territory.get(f.top)!]),
    );
    const modeChanged = state.current.grouped !== grouped;
    Object.assign(state.current, { grouped, fileColor, groupColor, overview });
    {
      const onMap = new Set(files.map((f) => f.path));
      const from = grouped ? groups.filter((x) => x.id !== OTHER) : (overview?.modules ?? []);
      let clusters = from.map((m) => ({ id: m.id, label: m.label, members: m.paths.filter((p) => onMap.has(p)) }));
      // No modules charted yet: the top-level folders are the clusters.
      if (!clusters.length) {
        const byTop = new Map<string, string[]>();
        for (const f of files) byTop.set(f.top, [...(byTop.get(f.top) ?? []), f.path]);
        clusters = [...byTop].map(([t, members]) => ({ id: `top:${t}`, label: t === "." ? graph.name : t, members }));
      }
      state.current.clusters = clusters.filter((c) => c.members.length >= 3);
    }

    // Reuse node objects across rebuilds: they carry their positions, so the
    // map *moves* into a new organization instead of exploding and resettling.
    const next = new Map<string, N>();
    const keep = (n: N) => {
      const prev = nodes.current.get(n.id);
      next.set(n.id, prev ? Object.assign(prev, { label: n.label, loc: n.loc, top: n.top, depth: n.depth }) : n);
    };
    const parent = (p: string) => {
      const i = p.lastIndexOf("/");
      return i < 0 ? "dir:." : `dir:${p.slice(0, i)}`;
    };
    const links: L[] = [];

    for (const f of files) keep({ id: f.path, type: "file", label: f.path, top: f.top, loc: f.loc });

    if (!grouped) {
      // Folder scaffolding: only the directories that still hold something.
      const dirs = new Set<string>();
      for (const f of files) {
        for (let d = parent(f.path); d !== "dir:." && !dirs.has(d); d = parent(d.slice(4))) dirs.add(d);
      }
      keep({ id: "dir:.", type: "dir", label: graph.name, depth: -1 });
      for (const d of dirs) {
        const p = d.slice(4);
        keep({ id: d, type: "dir", label: p.split("/").pop()!, depth: p.split("/").length - 1 });
        links.push({ source: parent(p), target: d, type: "contains" });
      }
      for (const f of files) links.push({ source: parent(f.path), target: f.path, type: "contains" });

      for (const m of overview?.modules ?? []) {
        const members = m.paths.filter((p) => next.has(p));
        if (!members.length) continue;
        keep({ id: `mod:${m.id}`, type: "module", label: m.label });
        // Tethering to every file would make big modules rigid; a sample holds
        // the beacon at the territory's centre just as well.
        const step = Math.max(1, Math.floor(members.length / 24));
        for (let i = 0; i < members.length; i += step) links.push({ source: `mod:${m.id}`, target: members[i], type: "member" });
      }
      for (const e of overview?.edges ?? []) {
        if (next.has(`mod:${e.from}`) && next.has(`mod:${e.to}`)) {
          links.push({ source: `mod:${e.from}`, target: `mod:${e.to}`, type: "logical", label: e.label });
        }
      }
    } else {
      for (const gr of groups) {
        const members = files.filter((f) => (groupOf.get(f.path) ?? OTHER) === gr.id).map((f) => f.path);
        if (!members.length) continue;
        const id = `grp:${gr.id}`;
        // A new beacon is born where its files already are, so the regroup
        // reads as the files gathering, not as everything flying to the origin.
        const born = !nodes.current.has(id) || modeChanged ? centroid(members) : null;
        keep({ id, type: "module", label: gr.label, ...(born ?? {}) });
        for (const p of members) links.push({ source: id, target: p, type: "member" });
      }
      for (const e of grouping!.edges) {
        if (next.has(`grp:${e.from}`) && next.has(`grp:${e.to}`)) {
          links.push({ source: `grp:${e.from}`, target: `grp:${e.to}`, type: "logical", label: e.label });
        }
      }
    }

    for (const e of graph.imports) {
      if (next.has(e.from) && next.has(e.to)) links.push({ source: e.from, target: e.to, type: "import", names: e.names, line: e.line });
    }

    // Same nodes and links as last time: nothing to rebuild. Feeding the
    // library new graph data reheats the simulation and throws every body
    // around, so only a real change in structure is allowed to do that.
    const key = `${[...next.keys()].join("|")}#${links.map((l) => `${l.source as string}>${l.target as string}:${l.type}`).join("|")}`;
    if (key === builtKey.current) {
      for (const [id, o] of objs.current) {
        const c = fileColor.get(id);
        if (c) (o.mesh.material as THREE.MeshBasicMaterial).color.set(c);
      }
      nodes.current = next;
      applyAll();
      return;
    }
    builtKey.current = key;

    // Objects for nodes that left the map are dropped; group beacons are
    // rebuilt per grouping, since their colour belongs to the grouping.
    for (const id of objs.current.keys()) {
      if (!next.has(id) || id.startsWith("grp:")) objs.current.delete(id);
    }
    for (const [id, o] of objs.current) {
      const c = fileColor.get(id);
      if (c) (o.mesh.material as THREE.MeshBasicMaterial).color.set(c);
    }
    nodes.current = next;
    g.graphData({ nodes: [...next.values()], links });
    g.linkLabel((l) => (l.type === "import" ? (litImport(l) ? importTag(l) : "") : l.type === "logical" && l.label ? l.label : ""));
    applyAll();

    // A filter or regrouping changes the map's shape; once it has mostly
    // settled, reframe it — unless the reader is looking at something.
    // (The first build is framed by the warp instead.)
    clearTimeout(refit.current);
    if (built.current && state.current.emphasis.size === 0 && tu().autoRefit) {
      refit.current = setTimeout(
        unlessTouched(() => state.current.emphasis.size === 0 && fitView(1200, 90)),
        2200,
      );
    }
    built.current = true;
    // centroid reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, overview, grouping, visible]);

  useEffect(() => {
    state.current.emphasis = new Set(emphasis);
    state.current.active = active;
    state.current.layers = layers;
    applyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emphasis, active, layers]);

  /* ------------------------------- tuning ------------------------------- */

  /** Forces read the knobs; d3 caches per-link values, so they're re-set on change. */
  function setForces() {
    const g = fg.current;
    if (!g) return;
    // Grouped, the beacons repel hard and hold their files tight, so the
    // clusters separate; by folder, the directory scaffolding holds.
    const charge = g.d3Force("charge") as unknown as { strength: (f: (n: N) => number) => void } | undefined;
    charge?.strength((n) => (n.type === "module" && state.current.grouped ? -tu().clusterSeparation : -tu().repulsion));
    const link = g.d3Force("link") as unknown as
      | { distance: (f: (l: L) => number) => { strength: (f: (l: L) => number) => void } }
      | undefined;
    const k = tu();
    link
      ?.distance((l) =>
        l.type === "member" && state.current.grouped ? k.clusterDistance
          : { contains: k.folderDistance, import: k.importDistance, member: 26, logical: k.runtimeDistance }[l.type],
      )
      .strength((l) =>
        l.type === "member" && state.current.grouped ? k.clusterTightness
          : { contains: k.folderPull, import: k.importPull, member: 0.12, logical: k.runtimePull }[l.type],
      );
  }

  function applyControls() {
    const ctl = fg.current?.controls() as unknown as OrbitControls | undefined;
    if (!ctl) return;
    const k = tu();
    ctl.rotateSpeed = k.rotateSpeed;
    ctl.zoomSpeed = k.zoomSpeed;
    ctl.panSpeed = k.panSpeed;
    ctl.dampingFactor = k.damping;
    ctl.zoomToCursor = k.zoomToCursor;
    // With dolly through on, the wheel is ours (see onWheel).
    ctl.enableZoom = !k.dollyThrough;
    ctl.autoRotateSpeed = k.autoRotateSpeed;
    if (!k.autoRotate) ctl.autoRotate = false;
  }

  const prevTuning = useRef(tuning);
  useEffect(() => {
    const g = fg.current;
    const prev = prevTuning.current;
    prevTuning.current = tuning;
    state.current.tuning = tuning;
    if (!g || prev === tuning) return;
    const changed = (Object.keys(tuning) as (keyof Tuning)[]).filter((k) => tuning[k] !== prev[k]);

    if (bloomRef.current) {
      bloomRef.current.strength = tuning.bloomStrength;
      bloomRef.current.radius = tuning.bloomRadius;
      bloomRef.current.threshold = tuning.bloomThreshold;
    }
    if (starMat.current) {
      starMat.current.opacity = tuning.starOpacity;
      starMat.current.size = tuning.starSize;
    }
    if (routeLine.current) (routeLine.current.material as THREE.LineDashedMaterial).opacity = tuning.courseOpacity;
    for (const ov of overlayObjs.current.values()) {
      (ov.spokes.material as THREE.LineBasicMaterial).opacity = tuning.groupSpokes;
    }
    applyControls();
    g.linkOpacity(tuning.linkOpacity)
      .linkCurvature((l) => (l.type === "logical" ? tu().curvature : 0))
      .linkDirectionalParticleWidth((l) => (l.type === "logical" ? 2.2 : 1.4) * tu().particleSize)
      .linkDirectionalParticleSpeed((l) => (l.type === "logical" ? 0.006 : 0.012) * tu().particleSpeed)
      .d3VelocityDecay(tuning.friction)
      .cooldownTime(tuning.settleSeconds * 1000)
      // Frozen: the engine stops at its next tick; thawed, it runs again.
      .cooldownTicks(tuning.freeze ? 0 : Infinity);

    // Sizes and labels are baked into the objects, so those get rebuilt.
    if (changed.some((k) => SHAPE_KNOBS.includes(k))) {
      objs.current.clear();
      g.nodeThreeObject((n) => objectFor(n));
    }
    if (changed.some((k) => FORCE_KNOBS.includes(k)) || (changed.includes("freeze") && !tuning.freeze)) {
      setForces();
      if (!tuning.freeze) g.d3ReheatSimulation();
      // The map changes size as it re-settles; reframe it unless you're
      // looking at something in particular.
      clearTimeout(refit.current);
      if (tuning.autoRefit && state.current.emphasis.size === 0) {
        refit.current = setTimeout(
          unlessTouched(() => state.current.emphasis.size === 0 && fitView(1200, 90)),
          2500,
        );
      }
    }
    applyAll();
    // The helpers read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tuning]);

  /* ------------------------------ overlays ------------------------------ */

  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    const scene = g.scene();
    const live = overlayObjs.current;
    for (const [id, o] of live) {
      scene.remove(o.beacon, o.spokes);
      o.spokes.geometry.dispose();
      live.delete(id);
    }
    for (const r of rings.current) {
      scene.remove(r.sprite);
      r.sprite.material.dispose();
    }
    rings.current = [];
    const ringCount = new Map<string, number>();
    for (const ov of overlays) {
      const beacon = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(7, 0),
        new THREE.MeshBasicMaterial({ color: ov.color, wireframe: true, transparent: true, opacity: 0.85 }),
      );
      const label = new SpriteText(ov.label, 6.5 * tu().labelSize, ov.color);
      label.fontFace = FONT_COND;
      label.fontWeight = "600";
      label.position.y = 14;
      // A generous invisible target: the wireframe alone is a few pixels wide.
      const hit = new THREE.Mesh(new THREE.SphereGeometry(16, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
      beacon.add(mesh, label, hit);
      const max = Math.min(ov.paths.length, 400);
      const spokes = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3)),
        new THREE.LineBasicMaterial({ color: ov.color, transparent: true, opacity: tu().groupSpokes }),
      );
      spokes.frustumCulled = false;
      scene.add(beacon, spokes);
      live.set(ov.id, { beacon, mesh, hit, spokes, members: ov.paths, shown: [], info: ov });
      for (const p of ov.paths.slice(0, 400)) {
        const k = ringCount.get(p) ?? 0;
        if (k >= MAX_RINGS) continue;
        ringCount.set(p, k + 1);
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: ringMap(), color: ov.color, transparent: true, depthWrite: false, opacity: tu().groupRings }),
        );
        sprite.visible = false;
        scene.add(sprite);
        rings.current.push({ sprite, path: p, k });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlays]);

  /* ------------------------------- flight ------------------------------- */

  const controls = () =>
    fg.current?.controls() as unknown as { autoRotate: boolean; target: THREE.Vector3 } | undefined;

  const addStop = (ids: string[]) => {
    const last = route.current.at(-1);
    if (last && last.length === ids.length && last.every((x, i) => x === ids[i])) return;
    route.current.push(ids);
    if (route.current.length > MAX_ROUTE) route.current.shift();
  };

  /**
   * Flies so that `c` ends up `distance` away. `shift` slides the framing
   * sideways (as a fraction of the distance): positive puts the target right
   * of centre, clear of a panel docked on the left.
   */
  /** You're moving the camera: stop any flight or glide, and drop pending automatic reframes. */
  function takeCamera() {
    camAnim.current = null;
    dollyGoal.current = null;
    userCamAt.current = performance.now();
    clearTimeout(refit.current);
  }

  function animateCamera(pos: THREE.Vector3, look: THREE.Vector3, ms: number) {
    const g = fg.current;
    const ctl = controls();
    if (!g || !ctl) return;
    dollyGoal.current = null;
    if (ms <= 0) {
      camAnim.current = null;
      g.camera().position.copy(pos);
      ctl.target.copy(look);
      return;
    }
    camAnim.current = { fromCam: g.camera().position.clone(), fromTarget: ctl.target.clone(), toCam: pos.clone(), toTarget: look.clone(), t0: performance.now(), ms };
  }

  /** Frame the whole map, as a flight you can interrupt. */
  function fitView(ms: number, padding: number) {
    const g = fg.current;
    const ctl = controls();
    if (!g || !ctl) return;
    // Let the library work out the framing, take its answer, put the camera back, then fly there ourselves.
    const camera = g.camera();
    const [cam, target, q] = [camera.position.clone(), ctl.target.clone(), camera.quaternion.clone()];
    g.zoomToFit(0, padding);
    const to = { cam: camera.position.clone(), target: controls()!.target.clone() };
    camera.position.copy(cam);
    controls()!.target.copy(target);
    camera.quaternion.copy(q);
    animateCamera(to.cam, to.target, ms);
  }

  /** Run an automatic camera move later — unless you've taken the camera in the meantime. */
  const unlessTouched = (fn: () => void) => {
    const at = performance.now();
    return () => userCamAt.current < at && fn();
  };

  const flyToPoint = (c: { x: number; y: number; z: number }, rawDistance: number, shift = 0, ms = tu().flySeconds * 1000) => {
    const distance = rawDistance * tu().focusDistance;
    const g = fg.current;
    if (!g) return;
    const camera = g.camera();
    const dir = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(c.x, c.y, c.z));
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, dir).normalize();
    const look = new THREE.Vector3(c.x, c.y, c.z).addScaledVector(right, -shift * distance);
    const pos = look.clone().addScaledVector(dir, distance);
    const ctl = controls();
    if (ctl) ctl.autoRotate = false;
    animateCamera(pos, look, ms);
  };

  const focusIds = (ids: string[], shift = 0) => {
    const c = centroid(ids);
    if (!c) return;
    let r = 0;
    for (const id of ids) {
      const n = nodes.current.get(id);
      if (n?.x !== undefined) r = Math.max(r, Math.hypot(n.x - c.x, n.y! - c.y, n.z! - c.z));
    }
    flyToPoint(c, Math.max(150, r * 2.3 + 60), shift);
    addStop(ids);
  };

  useImperativeHandle(ref, () => ({
    flyTo(path, shift = 0) {
      const n = nodes.current.get(path);
      if (n?.x === undefined) return;
      flyToPoint({ x: n.x, y: n.y!, z: n.z! }, 150, shift);
      addStop([path]);
    },
    focus: focusIds,
    focusModule(id, shift = 0) {
      const m = state.current.overview?.modules.find((x) => x.id === id);
      if (m) focusIds(m.paths.filter((p) => nodes.current.has(p)), shift);
    },
    overview() {
      const g = fg.current;
      if (!g) return;
      fitView(tu().flySeconds * 900, 70);
      setTimeout(
        unlessTouched(() => {
          const ctl = controls();
          if (ctl) ctl.autoRotate = tu().autoRotate;
        }),
        1500,
      );
    },
    pulse(path) {
      if (objs.current.has(path)) pulses.current.set(path, performance.now());
    },
    relayout() {
      fg.current?.d3ReheatSimulation();
    },
    warp() {
      const g = fg.current;
      if (!g) return;
      // Start in deep space and fall into the map.
      g.cameraPosition({ x: 0, y: 300, z: 5200 }, { x: 0, y: 0, z: 0 }, 0);
      setTimeout(
        unlessTouched(() => {
          fitView(2600, 80);
          setTimeout(
            unlessTouched(() => {
              const ctl = controls();
              if (ctl) ctl.autoRotate = tu().autoRotate;
            }),
            2700,
          );
        }),
        350,
      );
    },
  }));

  return <div ref={el} className="absolute inset-0" />;
}
