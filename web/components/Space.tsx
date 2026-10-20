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
type L = { source: string | N; target: string | N; type: LinkType; label?: string };

type Obj = { group: THREE.Group; mesh: THREE.Mesh; base: number; label?: SpriteText; fileLabel?: SpriteText };

/** A way of organizing the map: files gathered around group beacons. */
export type Grouping = { key: string; groups: LogicalModule[]; edges: LogicalEdge[] };

const OTHER = "__other";

/**
 * A group drawn on top of the map without reorganizing it: a beacon that
 * floats at the centre of its files with faint spokes out to each one. It takes
 * no part in the layout, so whatever separation the map has stays as it is.
 */
export type Overlay = { id: string; label: string; paths: string[]; color: string };

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
  onHide,
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
  /** Right-click: hide this file, or everything under this folder. */
  onHide: (target: { file: string } | { dir: string }) => void;
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
  });
  /** The current knob values, read at the moment of use. */
  const tu = () => state.current.tuning;
  const bloomRef = useRef<UnrealBloomPass | null>(null);
  const starMat = useRef<THREE.PointsMaterial | null>(null);
  const overlayObjs = useRef(
    new Map<string, { beacon: THREE.Group; mesh: THREE.Mesh; hit: THREE.Mesh; spokes: THREE.LineSegments; members: string[] }>(),
  );
  const handlers = useRef({ onPick, onPickModule, onPickDir, onPickOverlay, onHide, onBackground });
  handlers.current = { onPick, onPickModule, onPickDir, onPickOverlay, onHide, onBackground };

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
        if (n.type === "file") handlers.current.onPick(n.id);
        else if (n.type === "module") handlers.current.onPickModule(n.id.slice(4));
        else handlers.current.onPickDir(n.id.slice(4));
      })
      // A right-click that isn't a pan hides what's under it.
      .onNodeRightClick((n) => {
        if (n.type === "file") handlers.current.onHide({ file: n.id });
        else if (n.type === "dir" && n.id !== "dir:.") handlers.current.onHide({ dir: n.id.slice(4) });
      })
      // No dragging bodies around: a press on a body should orbit like
      // anywhere else, and the library's drag-end path fakes a touch pointerup
      // that crashes the orbit controls.
      .enableNodeDrag(false)
      .onBackgroundClick(() => handlers.current.onBackground());

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
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
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
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      // A drag that ends on a beacon is still an orbit, not a click.
      if (!start || e.button !== 0 || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      const id = overlayAt(e);
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      handlers.current.onPickOverlay(id);
    };
    const onHover = (e: PointerEvent) => {
      if (e.buttons || !overlayObjs.current.size) return;
      const over = !!overlayAt(e);
      host.style.cursor = over ? "pointer" : "";
      g.renderer().domElement.style.cursor = over ? "pointer" : "";
    };
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("pointerup", onUp, true);
    host.addEventListener("pointermove", onHover, true);
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    // Grabbing the map is a request to stop drifting.
    controls.addEventListener("start", () => (controls.autoRotate = false));

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      controls.update();

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
        for (let i = 0; i < shown; i++) {
          const m = nodes.current.get(members[i])!;
          sp.setXYZ(i * 2, c.x, c.y, c.z);
          sp.setXYZ(i * 2 + 1, m.x!, m.y!, m.z!);
        }
        ov.spokes.geometry.setDrawRange(0, shown * 2);
        sp.needsUpdate = true;
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
      // Names appear on the bodies you're looking at, never on all of them.
      const wantLabel = (emph.size > 0 && emph.has(id) && emph.size <= tu().fileLabelLimit) || id === act;
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

  function applyAll() {
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
        l.type === "logical" ? (emph.size ? "#4a3510" : RUNTIME)
          : l.type === "import" ? (both(l) ? STATIC : mix("#060b16", STATIC, tu().importBrightness * (emph.size ? 0.35 : 0.9)))
            : mix("#060b16", "#3a4f7a", tu().folderLinkBrightness * (emph.size ? 0.4 : 1)),
      )
      .linkWidth((l) => (l.type === "logical" ? tu().runtimeWidth : l.type === "import" && both(l) ? tu().importWidth : 0))
      .linkDirectionalParticles((l) =>
        l.type === "logical" ? (emph.size ? 0 : tu().particles) : l.type === "import" && both(l) ? Math.min(2, tu().particles) : 0,
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
      if (next.has(e.from) && next.has(e.to)) links.push({ source: e.from, target: e.to, type: "import" });
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
    g.linkLabel((l) => (l.type === "logical" && l.label ? l.label : ""));
    applyAll();

    // A filter or regrouping changes the map's shape; once it has mostly
    // settled, reframe it — unless the reader is looking at something.
    // (The first build is framed by the warp instead.)
    clearTimeout(refit.current);
    if (built.current && state.current.emphasis.size === 0 && tu().autoRefit) {
      refit.current = setTimeout(() => {
        if (state.current.emphasis.size === 0) fg.current?.zoomToFit(1200, 90);
      }, 2200);
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
        refit.current = setTimeout(() => state.current.emphasis.size === 0 && g.zoomToFit(1200, 90), 2500);
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
      live.set(ov.id, { beacon, mesh, hit, spokes, members: ov.paths });
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
    g.cameraPosition({ x: pos.x, y: pos.y, z: pos.z }, { x: look.x, y: look.y, z: look.z }, ms);
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
      g.zoomToFit(tu().flySeconds * 900, 70);
      setTimeout(() => {
        const ctl = controls();
        if (ctl) ctl.autoRotate = tu().autoRotate;
      }, 1500);
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
      setTimeout(() => {
        g.zoomToFit(2600, 80);
        setTimeout(() => {
          const ctl = controls();
          if (ctl) ctl.autoRotate = tu().autoRotate;
        }, 2700);
      }, 350);
    },
  }));

  return <div ref={el} className="absolute inset-0" />;
}
