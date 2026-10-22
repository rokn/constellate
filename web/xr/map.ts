import * as THREE from "three";
import SpriteText from "three-spritetext";
import type { Layer, LogicalEdge, LogicalModule, Note, Overview, RepoGraph } from "../../shared/types";
import { COURSE, RUNTIME, STATIC, territoryColors } from "../lib/colors";
import type { Tuning } from "../lib/tuning";
import type { FromWorker, LayoutLink, LayoutNode, LayoutParams, ToWorker } from "./layout.worker";
import LayoutWorker from "./layout.worker?worker";
import { C, FONT_COND, FONT_MONO, cond, fit, roundRect } from "./ui";

/**
 * The map, as it is on the desktop (web/components/Space.tsx), drawn for a
 * headset. Files are bodies sized by length and coloured by territory;
 * folders are the faint scaffolding; modules are amber wireframe beacons with
 * runtime arcs between them; imports are cyan routes, lit when both ends are
 * in view and brought up by pointing at a file. The course is magenta.
 *
 * What changes is the plumbing. A headset can't afford one draw call per
 * file, so bodies, glows, lit routes and particles are instanced; the layout
 * runs in a worker; and labels keep a minimum angular size so they stay
 * readable however small you've made the map. The desktop's bloom is redone
 * for stereo in bloom.ts; each lit body can also carry a soft additive halo,
 * which is all the glow there is with bloom off.
 */

export type Grouping = { key: string; groups: LogicalModule[]; edges: LogicalEdge[] };
export type Overlay = { id: string; label: string; paths: string[]; color: string; summary?: string };

export type MapInput = {
  graph: RepoGraph;
  overview?: Overview;
  grouping: Grouping | null;
  visible: Set<string> | null;
  notes: Note[];
  overlays: Overlay[];
  tuning: Tuning;
};
export type MapStyle = { emphasis: string[]; active: string | null; layers: Record<Layer, boolean> };

export type MapHit =
  | { kind: "file"; id: string; t: number }
  | { kind: "dir"; id: string; t: number }
  | { kind: "module"; id: string; label: string; summary?: string; files?: number; t: number }
  | { kind: "overlay"; id: string; t: number }
  | { kind: "note"; id: string; t: number };

type NodeType = "file" | "dir" | "module";
type N = { id: string; type: NodeType; label: string; summary?: string; files?: number; top?: string; loc?: number; depth?: number };
type L = { s: number; t: number; type: "import" | "contains" | "member" | "logical"; label?: string };

const OTHER = "__other";
const BUMP = "#b4f0ff";
const NIGHT = "#060b16";
const MAX_ROUTE = 48;

const mix = (from: string, to: string, t: number) => new THREE.Color(from).lerp(new THREE.Color(to), Math.max(0, Math.min(1, t)));

/* ------------------------------- shaders ------------------------------- */

const BODY_VS = /* glsl */ `
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vColor = instanceColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const BODY_FS = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = max(dot(normalize(vN), normalize(vV)), 0.0);
    // A bright core and a lit rim: what the desktop's bloom does to a flat dot.
    vec3 c = vColor * (0.78 + 0.5 * pow(facing, 2.0)) + vColor * pow(1.0 - facing, 3.0) * 0.5;
    gl_FragColor = vec4(c, vAlpha);
    #include <colorspace_fragment>
  }
`;
const GLOW_VS = /* glsl */ `
  attribute float aAlpha;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    vAlpha = aAlpha;
    vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length((modelViewMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    c.xy += position.xy * s;
    gl_Position = projectionMatrix * c;
  }
`;
const GLOW_FS = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 2.4) * vAlpha;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }
`;

/** Instanced spheres with per-instance colour and opacity. */
class Spheres {
  readonly mesh: THREE.InstancedMesh;
  readonly alpha: THREE.InstancedBufferAttribute;
  count = 0;
  constructor(capacity: number, transparent: boolean, detail: [number, number] = [14, 10]) {
    const geo = new THREE.SphereGeometry(1, detail[0], detail[1]);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alpha);
    const mat = new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: BODY_FS, transparent, depthWrite: !transparent });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }
}

class Glows {
  readonly mesh: THREE.InstancedMesh;
  readonly alpha: THREE.InstancedBufferAttribute;
  constructor(capacity: number) {
    const geo = new THREE.PlaneGeometry(2, 2);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAlpha", this.alpha);
    const mat = new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color());
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
  }
}

/** A label that never gets smaller than `minAngle` radians tall, however far or small the map is. */
type Label = { sprite: SpriteText; height: number; minAngle: number };

function label(text: string, height: number, color: string, font: string, weight: string, minAngle: number): Label {
  const s = new SpriteText(text, height, color);
  s.fontFace = font;
  s.fontWeight = weight;
  s.material.depthWrite = false;
  s.renderOrder = 6;
  return { sprite: s, height, minAngle };
}

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class MapView {
  /** Map units. The engine places and scales this in the room. */
  readonly root = new THREE.Group();
  /** Fires when the layout moves, so camera flights can aim at where things are now. */
  onSettled: (() => void) | null = null;

  private worker = new LayoutWorker();
  private version = 0;
  private nodes: N[] = [];
  private index = new Map<string, number>();
  private links: L[] = [];
  private pos: Float32Array = new Float32Array(0);
  private base = new Float32Array(0);
  private colors: THREE.Color[] = [];
  private inDegree = new Map<string, number>();
  private neighbours = new Map<string, Set<string>>();
  private fileColor = new Map<string, string>();
  private groupColor = new Map<string, string>();
  private grouped = false;
  private input: MapInput | null = null;
  private style: MapStyle = { emphasis: [], active: null, layers: { imports: false, logical: true, labels: true, folders: true, beacons: true, notes: true } };
  private emph = new Set<string>();
  private moved = true;
  private restyle = true;
  private settled = false;
  private hovered: string | null = null;
  private pulses = new Map<string, number>();
  /** Bodies held by a hand, by index, at their held position. */
  private dragging = new Map<number, [number, number, number]>();
  /** The halo drawn around each lit body (XR settings), and whether the real bloom pass is on. */
  private glow = { amount: 0.35, bloom: true };

  private lit = new Spheres(4096, false);
  private dim = new Spheres(4096, true);
  private glows = new Glows(4096);
  private litIdx: number[] = [];
  private dimIdx: number[] = [];
  private glowIdx: number[] = [];

  private beacons = new Map<string, { mesh: THREE.Mesh; label: Label; i: number }>();
  private dirLabels = new Map<number, Label>();
  private fileLabels = new Map<number, Label>();
  private near = new Set<number>();
  private nearAt = 0;

  private folderLines: THREE.LineSegments;
  private importLines: THREE.LineSegments;
  private importShown: number[] = [];
  private tubes: THREE.InstancedMesh;
  private tubeShown: { l: number; color: THREE.Color; width: number }[] = [];
  private particles: THREE.InstancedMesh;
  private arcs: THREE.LineSegments;
  private arrows: THREE.InstancedMesh;
  private logical: number[] = [];

  private halo: THREE.Mesh;
  private route: THREE.Line;
  private stops: string[][] = [];

  private overlayObjs = new Map<string, { beacon: THREE.Mesh; spokes: THREE.LineSegments; label: Label; members: number[]; at: THREE.Vector3 }>();
  private noteObjs = new Map<string, { sprite: THREE.Sprite; note: Note; at: THREE.Vector3; w: number }>();

  constructor() {
    this.root.add(this.lit.mesh, this.dim.mesh, this.glows.mesh);
    this.folderLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: "#3a4f7a", transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.importLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.arcs = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    for (const l of [this.folderLines, this.importLines, this.arcs]) l.frustumCulled = false;
    const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    this.tubes = new THREE.InstancedMesh(tubeGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }), 1500);
    this.tubes.setColorAt(0, new THREE.Color());
    this.tubes.count = 0;
    this.tubes.frustumCulled = false;
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshBasicMaterial({ toneMapped: false }), 3000);
    this.particles.setColorAt(0, new THREE.Color());
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.arrows = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.6, 8), new THREE.MeshBasicMaterial({ color: RUNTIME, toneMapped: false, transparent: true }), 400);
    this.arrows.count = 0;
    this.arrows.frustumCulled = false;
    this.root.add(this.folderLines, this.importLines, this.arcs, this.tubes, this.particles, this.arrows);

    this.halo = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 8, 48), new THREE.MeshBasicMaterial({ color: COURSE, transparent: true, opacity: 0.95, toneMapped: false }));
    this.halo.visible = false;
    this.root.add(this.halo);
    this.route = new THREE.Line(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_ROUTE * 3), 3)),
      new THREE.LineDashedMaterial({ color: COURSE, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.9 }),
    );
    this.route.frustumCulled = false;
    this.root.add(this.route);

    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.version !== this.version || m.positions.length !== this.nodes.length * 3) return;
      this.pos = m.positions;
      // A held body sits where the hand is, not where the last tick (a frame behind) left it.
      for (const [i, at] of this.dragging) this.pos.set(at, i * 3);
      this.moved = true;
      if (m.settled && !this.settled) {
        this.settled = true;
        this.onSettled?.();
      }
    };
  }

  dispose() {
    this.worker.terminate();
  }

  /* -------------------------------- data -------------------------------- */

  /** Build the map from the graph and its organization, the way Space.tsx does. */
  setData(input: MapInput) {
    const prevInput = this.input;
    this.input = input;
    const { graph, overview, grouping, visible, tuning } = input;
    const grouped = !!grouping;
    const shown = (p: string) => !visible || visible.has(p);
    this.inDegree = new Map();
    this.neighbours = new Map();
    for (const e of graph.imports) {
      this.inDegree.set(e.to, (this.inDegree.get(e.to) ?? 0) + 1);
      if (!this.neighbours.has(e.from)) this.neighbours.set(e.from, new Set());
      if (!this.neighbours.has(e.to)) this.neighbours.set(e.to, new Set());
      this.neighbours.get(e.from)!.add(e.to);
      this.neighbours.get(e.to)!.add(e.from);
    }
    const files = graph.files.filter((f) => shown(f.path));

    const groupOf = new Map<string, string>();
    const groups = grouping ? [...grouping.groups] : [];
    if (grouping) {
      for (const gr of grouping.groups) for (const p of gr.paths) if (!groupOf.has(p)) groupOf.set(p, gr.id);
      if (files.some((f) => !groupOf.has(f.path))) groups.push({ id: OTHER, label: "Other", summary: "Not part of any group", paths: [] });
    }
    const groupColor = territoryColors(groups.filter((x) => x.id !== OTHER).map((x) => x.id));
    groupColor.set(OTHER, "#5d6a85");
    const territory = territoryColors(graph.files.map((f) => f.top));
    this.fileColor = new Map(files.map((f) => [f.path, grouped ? groupColor.get(groupOf.get(f.path) ?? OTHER)! : territory.get(f.top)!]));
    this.groupColor = groupColor;
    const modeChanged = this.grouped !== grouped;
    this.grouped = grouped;

    const prevPos = new Map<string, [number, number, number]>();
    this.nodes.forEach((n, i) => prevPos.set(n.id, [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]));

    const nodes: N[] = [];
    const index = new Map<string, number>();
    const add = (n: N) => {
      index.set(n.id, nodes.length);
      nodes.push(n);
    };
    const links: L[] = [];
    const link = (a: string, b: string, type: L["type"], lbl?: string) => {
      const s = index.get(a);
      const t = index.get(b);
      if (s !== undefined && t !== undefined) links.push({ s, t, type, label: lbl });
    };
    const parent = (p: string) => {
      const i = p.lastIndexOf("/");
      return i < 0 ? "dir:." : `dir:${p.slice(0, i)}`;
    };

    for (const f of files) add({ id: f.path, type: "file", label: f.path, top: f.top, loc: f.loc });
    if (!grouped) {
      const dirs = new Set<string>();
      for (const f of files) for (let d = parent(f.path); d !== "dir:." && !dirs.has(d); d = parent(d.slice(4))) dirs.add(d);
      add({ id: "dir:.", type: "dir", label: graph.name, depth: -1 });
      for (const d of dirs) {
        const p = d.slice(4);
        add({ id: d, type: "dir", label: p.split("/").pop()!, depth: p.split("/").length - 1 });
      }
      for (const d of dirs) link(parent(d.slice(4)), d, "contains");
      for (const f of files) link(parent(f.path), f.path, "contains");
      for (const m of overview?.modules ?? []) {
        const members = m.paths.filter((p) => index.has(p));
        if (!members.length) continue;
        add({ id: `mod:${m.id}`, type: "module", label: m.label, summary: m.summary, files: members.length });
        const step = Math.max(1, Math.floor(members.length / 24));
        for (let i = 0; i < members.length; i += step) link(`mod:${m.id}`, members[i], "member");
      }
      for (const e of overview?.edges ?? []) link(`mod:${e.from}`, `mod:${e.to}`, "logical", e.label);
    } else {
      for (const gr of groups) {
        const members = files.filter((f) => (groupOf.get(f.path) ?? OTHER) === gr.id).map((f) => f.path);
        if (!members.length) continue;
        add({ id: `grp:${gr.id}`, type: "module", label: gr.label, summary: gr.summary, files: members.length });
        for (const p of members) link(`grp:${gr.id}`, p, "member");
      }
      for (const e of grouping!.edges) link(`grp:${e.from}`, `grp:${e.to}`, "logical", e.label);
    }
    for (const e of graph.imports) link(e.from, e.to, "import");

    // Same structure as before: keep the layout as it is, just restyle.
    const key = `${nodes.map((n) => n.id).join("|")}#${links.map((l) => `${l.s}>${l.t}:${l.type}`).join("|")}#${grouped}`;
    const sameShape = prevInput && key === this.shapeKey;
    this.shapeKey = key;
    this.nodes = nodes;
    this.index = index;
    this.links = links;

    // Where new bodies are born: beside their folder, or for a group's beacon
    // among its files, so a regroup reads as the files gathering.
    const centroidOf = (ids: string[]) => {
      let x = 0, y = 0, z = 0, k = 0;
      for (const id of ids) {
        const p = prevPos.get(id);
        if (!p) continue;
        x += p[0]; y += p[1]; z += p[2]; k++;
      }
      return k ? [x / k, y / k, z / k] : null;
    };
    const birth = (n: N): [number, number, number] | null => {
      const p = prevPos.get(n.id);
      if (p && !(n.id.startsWith("grp:") && modeChanged)) return p;
      if (n.type === "module") {
        const c = centroidOf(links.filter((l) => nodes[l.s] === n && l.type === "member").map((l) => nodes[l.t].id));
        if (c) return c as [number, number, number];
      }
      for (let d = parent(n.id.startsWith("dir:") ? n.id.slice(4) : n.id); ; d = parent(d.slice(4))) {
        const at = prevPos.get(d);
        if (at) return [at[0] + (Math.random() - 0.5) * 24, at[1] + (Math.random() - 0.5) * 24, at[2] + (Math.random() - 0.5) * 24];
        if (d === "dir:.") return null;
      }
    };
    const pos = new Float32Array(nodes.length * 3);
    const lnodes: LayoutNode[] = nodes.map((n, i) => {
      const b = birth(n);
      if (b) pos.set(b, i * 3);
      return { id: n.id, type: n.type, ...(b ? { x: b[0], y: b[1], z: b[2] } : {}) };
    });
    this.pos = pos;
    this.sizes(tuning);
    this.buildObjects();
    const params: LayoutParams = {
      grouped,
      repulsion: tuning.repulsion,
      clusterSeparation: tuning.clusterSeparation,
      folderPull: tuning.folderPull,
      folderDistance: tuning.folderDistance,
      importPull: tuning.importPull,
      importDistance: tuning.importDistance,
      clusterTightness: tuning.clusterTightness,
      clusterDistance: tuning.clusterDistance,
      runtimePull: tuning.runtimePull,
      runtimeDistance: tuning.runtimeDistance,
      friction: tuning.friction,
      settleSeconds: tuning.settleSeconds,
      freeze: tuning.freeze,
    };
    const paramsKey = JSON.stringify(params);
    if (!sameShape) {
      this.version++;
      this.settled = false;
      this.dragging.clear();
      const llinks: LayoutLink[] = links.map((l) => ({ s: l.s, t: l.t, type: l.type }));
      this.worker.postMessage({ type: "graph", nodes: lnodes, links: llinks, params, version: this.version } satisfies ToWorker);
    } else if (paramsKey !== this.paramsKey) {
      // Same map, new forces: the layout warms up to show them, as on the desktop.
      this.worker.postMessage({ type: "params", params } satisfies ToWorker);
    }
    this.paramsKey = paramsKey;
    this.setNotes(input.notes);
    this.setOverlays(input.overlays);
    this.restyle = true;
    this.moved = true;
  }
  private shapeKey = "";
  private paramsKey = "";

  get tuning(): Tuning | null {
    return this.input?.tuning ?? null;
  }

  /** Bodies' radii, from the same knobs as the desktop. */
  private sizes(tu: Tuning) {
    this.base = new Float32Array(this.nodes.length);
    this.colors = this.nodes.map((n) => {
      if (n.type === "file") return new THREE.Color(this.fileColor.get(n.id) ?? "#9aa");
      if (n.type === "module") return new THREE.Color(n.id.startsWith("grp:") ? this.groupColor.get(n.id.slice(4)) ?? RUNTIME : RUNTIME);
      return new THREE.Color(0x3a4a6c);
    });
    this.nodes.forEach((n, i) => {
      if (n.type === "file") {
        const boost = 1 + (tu.sizeByImporters * Math.log2(1 + (this.inDegree.get(n.id) ?? 0))) / 3;
        this.base[i] = Math.min(7, 1.1 + (Math.sqrt(n.loc ?? 1) / 5.5) * tu.sizeByLines) * tu.nodeSize * boost;
      } else if (n.type === "module") this.base[i] = (n.id.startsWith("grp:") ? 8 : 6.5) * tu.beaconSize;
      else this.base[i] = 0.8;
    });
  }

  /** Beacons and folder names: the few objects that aren't instanced. */
  private buildObjects() {
    const tu = this.input!.tuning;
    for (const b of this.beacons.values()) {
      this.root.remove(b.mesh, b.label.sprite);
      b.mesh.geometry.dispose();
    }
    this.beacons.clear();
    for (const l of this.dirLabels.values()) this.root.remove(l.sprite);
    this.dirLabels.clear();
    for (const l of this.fileLabels.values()) this.root.remove(l.sprite);
    this.fileLabels.clear();
    this.nodes.forEach((n, i) => {
      if (n.type === "module") {
        const tint = `#${this.colors[i].getHexString()}`;
        const mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(this.base[i], 1),
          new THREE.MeshBasicMaterial({ color: tint, wireframe: true, transparent: true, opacity: tu.beaconOpacity, toneMapped: false }),
        );
        const lb = label(n.label, (n.id.startsWith("grp:") ? 7.5 : 6) * tu.beaconLabelSize, tint, FONT_COND, "600", 0.02);
        this.root.add(mesh, lb.sprite);
        this.beacons.set(n.id, { mesh, label: lb, i });
      } else if (n.type === "dir" && (n.depth ?? 9) <= tu.folderLabelDepth) {
        const lb = label(n.label, ((n.depth ?? 0) <= 0 ? 6.5 : 4.2) * tu.labelSize, "#b9c4da", FONT_COND, "500", 0.016);
        this.root.add(lb.sprite);
        this.dirLabels.set(i, lb);
      }
    });
  }

  /* -------------------------------- style -------------------------------- */

  setStyle(style: MapStyle) {
    this.style = style;
    this.emph = new Set(style.emphasis);
    this.restyle = true;
  }

  setHover(id: string | null) {
    if (id === this.hovered) return;
    this.hovered = id;
    this.restyle = true;
  }

  pulse(path: string) {
    if (this.index.has(path)) this.pulses.set(path, performance.now());
  }

  /** A stop on the course: the dashed magenta line runs through where you've been. */
  addStop(ids: string[]) {
    const on = ids.filter((id) => this.index.has(id));
    if (!on.length) return;
    this.stops.push(on);
    if (this.stops.length > MAX_ROUTE) this.stops.shift();
    this.moved = true;
  }

  private isLit(i: number) {
    const id = this.nodes[i].id;
    return this.emph.size === 0 || this.emph.has(id) || id === this.style.active;
  }

  private both(l: L) {
    return this.emph.has(this.nodes[l.s].id) && this.emph.has(this.nodes[l.t].id);
  }

  private bumped(l: L) {
    const h = this.hovered;
    return !!h && l.type === "import" && (this.nodes[l.s].id === h || this.nodes[l.t].id === h);
  }

  private applyStyle() {
    const tu = this.input!.tuning;
    const lay = this.style.layers;
    this.litIdx = [];
    this.dimIdx = [];
    this.glowIdx = [];
    this.nodes.forEach((n, i) => {
      if (n.type === "module") return;
      if (n.type === "dir") {
        if (lay.folders === false) return;
        // Folder points never glow; they're scaffolding.
        (this.emph.size === 0 ? this.litIdx : this.dimIdx).push(i);
        return;
      }
      if (this.isLit(i)) {
        this.litIdx.push(i);
        this.glowIdx.push(i);
      } else this.dimIdx.push(i);
    });
    // "File brightness": the desktop's default (0.88) is how they're drawn here at 1.
    const bright = tu.bodyOpacity / 0.88;
    const tmpC = new THREE.Color();
    const setColors = (s: Spheres, idx: number[], alphaOf: (i: number) => number) => {
      idx.forEach((i, k) => {
        s.mesh.setColorAt(k, this.nodes[i].type === "file" ? tmpC.copy(this.colors[i]).multiplyScalar(bright) : this.colors[i]);
        s.alpha.array[k] = alphaOf(i);
      });
      s.mesh.count = idx.length;
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
      s.alpha.needsUpdate = true;
    };
    const emphOn = this.emph.size > 0;
    const dirAlpha = (i: number) => (this.nodes[i].type === "dir" ? (emphOn ? tu.folderPointOpacity * 0.2 : tu.folderPointOpacity) : 1);
    setColors(this.lit, this.litIdx, (i) => (this.nodes[i].type === "dir" ? dirAlpha(i) : 1));
    setColors(this.dim, this.dimIdx, (i) => (this.nodes[i].type === "dir" ? dirAlpha(i) : Math.max(0.1, tu.dimOpacity)));
    this.glowIdx.forEach((i, k) => {
      this.glows.mesh.setColorAt(k, this.colors[i]);
      // With the bloom pass on it does the glowing; the halo is a softer extra.
      this.glows.alpha.array[k] = (emphOn ? 0.55 : 0.32) * (this.glow.amount / 0.35) * (this.glow.bloom ? 0.5 : 0.4 + tu.bloomStrength);
    });
    this.glows.mesh.count = this.glow.amount > 0 ? this.glowIdx.length : 0;
    if (this.glows.mesh.instanceColor) this.glows.mesh.instanceColor.needsUpdate = true;
    this.glows.alpha.needsUpdate = true;

    // Beacons belong to the runtime layer (group beacons are the organization itself).
    for (const [id, b] of this.beacons) {
      const on = lay.beacons !== false && (id.startsWith("grp:") || lay.logical);
      b.mesh.visible = on;
      b.label.sprite.visible = on && tu.showBeaconLabels;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = emphOn ? tu.beaconOpacity * 0.3 : tu.beaconOpacity;
      b.label.sprite.material.opacity = emphOn ? 0.22 : 1;
    }
    for (const l of this.dirLabels.values()) l.sprite.visible = lay.folders !== false && lay.labels && !emphOn;

    // Line opacity scales every kind of line; 0.55 is the desktop's default.
    const lineK = tu.linkOpacity / 0.55;
    (this.folderLines.material as THREE.LineBasicMaterial).opacity = Math.min(1, 0.5 * lineK);
    (this.importLines.material as THREE.LineBasicMaterial).opacity = Math.min(1, 0.7 * lineK);
    (this.arcs.material as THREE.LineBasicMaterial).opacity = Math.min(1, 0.9 * lineK);
    (this.tubes.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.85 * lineK);
    (this.route.material as THREE.LineDashedMaterial).opacity = tu.courseOpacity;

    // Folder scaffolding.
    const folder = this.links.filter((l) => l.type === "contains");
    this.folderLines.visible = lay.folders !== false && !this.grouped;
    (this.folderLines.material as THREE.LineBasicMaterial).color = mix(NIGHT, "#3a4f7a", tu.folderLinkBrightness * (emphOn ? 0.4 : 1) + 0.25);
    this.folderLinks = folder;
    this.folderLines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(folder.length * 6), 3));

    // Imports: the whole web as thin lines when the layer is on; lit ones
    // (both ends in view) and the hovered file's as tubes with particles.
    this.importShown = [];
    this.tubeShown = [];
    const lineColors: number[] = [];
    const rest = mix(NIGHT, STATIC, tu.importBrightness * (emphOn ? 0.35 : 0.9) + 0.15);
    this.links.forEach((l, k) => {
      if (l.type !== "import") return;
      const lit = this.both(l);
      const bump = this.bumped(l);
      if (lit || bump) this.tubeShown.push({ l: k, color: new THREE.Color(bump ? BUMP : STATIC), width: tu.importWidth });
      else if (lay.imports) {
        this.importShown.push(k);
        lineColors.push(rest.r, rest.g, rest.b, rest.r, rest.g, rest.b);
      }
    });
    if (this.tubeShown.length > this.tubes.instanceMatrix.count) this.tubeShown.length = this.tubes.instanceMatrix.count;
    const ig = this.importLines.geometry;
    ig.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.importShown.length * 6), 3));
    ig.setAttribute("color", new THREE.BufferAttribute(new Float32Array(lineColors), 3));
    this.tubeShown.forEach((t, k) => this.tubes.setColorAt(k, t.color));
    this.tubes.count = this.tubeShown.length;
    if (this.tubes.instanceColor) this.tubes.instanceColor.needsUpdate = true;

    // Runtime arcs between beacons.
    this.logical = [];
    if (lay.logical || this.grouped) this.links.forEach((l, k) => l.type === "logical" && this.logical.push(k));
    const arcColor = emphOn ? new THREE.Color("#4a3510") : new THREE.Color(RUNTIME);
    const ac: number[] = [];
    for (let k = 0; k < this.logical.length * ARC_SEG; k++) ac.push(arcColor.r, arcColor.g, arcColor.b, arcColor.r, arcColor.g, arcColor.b);
    this.arcs.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.logical.length * ARC_SEG * 6), 3));
    this.arcs.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(ac), 3));
    (this.arrows.material as THREE.MeshBasicMaterial).color.copy(arcColor);
    this.arrows.count = Math.min(this.logical.length, 400);

    // Names on the bodies you're looking at.
    this.pickLabelled();
    for (const ov of this.overlayObjs.values()) ov.beacon.visible = ov.spokes.visible = ov.label.sprite.visible = lay.beacons !== false;
    for (const n of this.noteObjs.values()) n.sprite.visible = lay.notes !== false;
    this.moved = true;
  }
  private folderLinks: L[] = [];

  /** Which files wear their name: the open one, the focus (up to the limit, most-imported first), and the near ones. */
  private pickLabelled() {
    const tu = this.input!.tuning;
    const want = new Set<number>();
    const act = this.style.active ? this.index.get(this.style.active) : undefined;
    if (act !== undefined) want.add(act);
    if (this.hovered && this.index.has(this.hovered) && this.nodes[this.index.get(this.hovered)!].type === "file") want.add(this.index.get(this.hovered)!);
    if (this.emph.size) {
      const ranked = [...this.emph].filter((id) => this.index.has(id)).sort((a, b) => (this.inDegree.get(b) ?? 0) - (this.inDegree.get(a) ?? 0));
      for (const id of ranked.slice(0, tu.fileLabelLimit)) want.add(this.index.get(id)!);
    }
    for (const i of this.near) if (this.isLit(i)) want.add(i);
    for (const [i, l] of this.fileLabels) {
      if (!want.has(i)) {
        this.root.remove(l.sprite);
        this.fileLabels.delete(i);
      }
    }
    for (const i of want) {
      if (this.fileLabels.has(i) || this.nodes[i]?.type !== "file") continue;
      const id = this.nodes[i].id;
      const lb = label(tu.fullPaths ? id : id.split("/").pop()!, 2.6 * tu.fileLabelSize, "#e4eaf4", FONT_MONO, "400", 0.012);
      this.root.add(lb.sprite);
      this.fileLabels.set(i, lb);
    }
  }

  /* ------------------------------- markers ------------------------------- */

  private setOverlays(list: Overlay[]) {
    for (const o of this.overlayObjs.values()) this.root.remove(o.beacon, o.spokes, o.label.sprite);
    this.overlayObjs.clear();
    for (const ov of list) {
      const members = ov.paths.map((p) => this.index.get(p)).filter((i): i is number => i !== undefined);
      if (!members.length) continue;
      const beacon = new THREE.Mesh(
        new THREE.OctahedronGeometry(9 * (this.input?.tuning.groupBeaconSize ?? 1), 0),
        new THREE.MeshBasicMaterial({ color: ov.color, wireframe: true, transparent: true, opacity: 0.85, toneMapped: false }),
      );
      const spokes = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(members.length * 6), 3)),
        new THREE.LineBasicMaterial({ color: ov.color, transparent: true, opacity: Math.max(0.3, this.input?.tuning.groupSpokes ?? 0.22), depthWrite: false }),
      );
      spokes.frustumCulled = false;
      const lb = label(ov.label, 7, ov.color, FONT_COND, "600", 0.02);
      this.root.add(beacon, spokes, lb.sprite);
      this.overlayObjs.set(ov.id, { beacon, spokes, label: lb, members, at: new THREE.Vector3() });
    }
  }

  private setNotes(notes: Note[]) {
    const keep = new Set(notes.map((n) => n.id));
    for (const [id, o] of this.noteObjs) {
      if (!keep.has(id) || o.note !== notes.find((n) => n.id === id)) {
        this.root.remove(o.sprite);
        (o.sprite.material.map as THREE.Texture | null)?.dispose();
        this.noteObjs.delete(id);
      }
    }
    for (const n of notes) {
      if (this.noteObjs.has(n.id)) continue;
      const { sprite, w } = noteCard(n.text);
      this.root.add(sprite);
      this.noteObjs.set(n.id, { sprite, note: n, at: new THREE.Vector3(), w });
    }
  }

  /* ------------------------------- per frame ------------------------------- */

  /** `eye` is the viewer's head in this map's units (local space). */
  update(eye: THREE.Vector3, now: number, unitsPerMeter: number) {
    if (!this.input) return;
    if (this.restyle) {
      this.restyle = false;
      this.applyStyle();
    }
    const pulsing = this.pulses.size > 0;
    if (this.moved || pulsing) this.writeBodies(now);
    if (this.moved) {
      this.writeLines();
      this.writeMarkers();
      this.writeRoute();
    }
    this.moved = false;
    this.writeTubesAndParticles(now);

    // Names for what's near you, refreshed a few times a second.
    if (now - this.nearAt > 350) {
      this.nearAt = now;
      // "Name nearby files": the desktop's 240 map units is half a metre from your eyes here.
      const reach = 0.5 * (this.input.tuning.nearLabels / 240) * unitsPerMeter;
      const cands: { i: number; d: number }[] = [];
      for (let i = 0; i < this.nodes.length; i++) {
        if (this.nodes[i].type !== "file") continue;
        const dx = this.pos[i * 3] - eye.x, dy = this.pos[i * 3 + 1] - eye.y, dz = this.pos[i * 3 + 2] - eye.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < reach * reach) cands.push({ i, d });
      }
      cands.sort((a, b) => a.d - b.d);
      const next = new Set(cands.slice(0, 30).map((c) => c.i));
      if ([...next].some((i) => !this.near.has(i)) || [...this.near].some((i) => !next.has(i))) {
        this.near = next;
        this.pickLabelled();
      }
    }

    // Labels: placed over their body, never smaller than readable.
    const sizeLabel = (l: Label, x: number, y: number, z: number, lift: number) => {
      l.sprite.position.set(x, y + lift, z);
      const d = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
      const k = Math.max(1, (l.minAngle * d) / l.height);
      l.sprite.scale.set(l.sprite.scale.x / (l.sprite.userData.k ?? 1) * k, l.sprite.scale.y / (l.sprite.userData.k ?? 1) * k, 1);
      l.sprite.userData.k = k;
    };
    for (const [i, l] of this.fileLabels) sizeLabel(l, this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.base[i] + 3);
    for (const [i, l] of this.dirLabels) sizeLabel(l, this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], 5);
    for (const b of this.beacons.values()) {
      const i = b.i;
      b.mesh.position.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      b.mesh.rotation.y = now * 0.0002;
      sizeLabel(b.label, this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.base[i] + 7);
    }
    for (const o of this.overlayObjs.values()) sizeLabel(o.label, o.at.x, o.at.y, o.at.z, 14);
    for (const n of this.noteObjs.values()) {
      const d = n.at.distanceTo(eye);
      const h = Math.max(12, d * 0.045);
      n.sprite.position.copy(n.at);
      n.sprite.scale.set(h * n.w, h, 1);
    }

    // The open file's halo faces you.
    const act = this.style.active ? this.index.get(this.style.active) : undefined;
    this.halo.visible = act !== undefined;
    if (act !== undefined) {
      this.halo.position.set(this.pos[act * 3], this.pos[act * 3 + 1], this.pos[act * 3 + 2]);
      this.halo.lookAt(eye);
      const r = this.base[act] * 2.1 * (this.input.tuning.haloSize ?? 1) * (1 + 0.06 * Math.sin(now / 300));
      this.halo.scale.setScalar(r);
    }
  }

  private writeBodies(now: number) {
    const m = new THREE.Matrix4();
    const write = (mesh: THREE.InstancedMesh, idx: number[], k: number) => {
      const arr = mesh.instanceMatrix.array as Float32Array;
      idx.forEach((i, j) => {
        let s = this.base[i] * k;
        const t0 = this.pulses.get(this.nodes[i].id);
        if (t0 !== undefined) {
          const t = (now - t0) / 1200;
          if (t >= 1) this.pulses.delete(this.nodes[i].id);
          else s *= 1 + 1.6 * Math.sin(Math.PI * t) * (1 - t);
        }
        m.makeScale(s, s, s);
        m.setPosition(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
        m.toArray(arr, j * 16);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    write(this.lit.mesh, this.litIdx, 1);
    write(this.dim.mesh, this.dimIdx, 1);
    write(this.glows.mesh, this.glowIdx, 2.4 * (0.6 + (this.input?.tuning.bloomRadius ?? 0.22) * 2));
  }

  private writeLines() {
    const p = this.pos;
    const seg = (arr: Float32Array, k: number, a: number, b: number) => {
      arr[k * 6] = p[a * 3]; arr[k * 6 + 1] = p[a * 3 + 1]; arr[k * 6 + 2] = p[a * 3 + 2];
      arr[k * 6 + 3] = p[b * 3]; arr[k * 6 + 4] = p[b * 3 + 1]; arr[k * 6 + 5] = p[b * 3 + 2];
    };
    const fa = this.folderLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.folderLinks.forEach((l, k) => seg(fa.array as Float32Array, k, l.s, l.t));
    fa.needsUpdate = true;
    const ia = this.importLines.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.importShown.forEach((li, k) => seg(ia.array as Float32Array, k, this.links[li].s, this.links[li].t));
    ia.needsUpdate = true;

    // Runtime arcs: a bend of `curvature`, as the desktop draws them.
    const aa = this.arcs.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = aa.array as Float32Array;
    const curv = this.input!.tuning.curvature;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), M = new THREE.Vector3(), P = new THREE.Vector3(), Q = new THREE.Vector3();
    this.logical.forEach((li, k) => {
      const l = this.links[li];
      A.fromArray(p, l.s * 3);
      B.fromArray(p, l.t * 3);
      const len = A.distanceTo(B);
      M.addVectors(A, B).multiplyScalar(0.5);
      tmpV.subVectors(B, A).normalize();
      tmpV2.crossVectors(tmpV, UP);
      if (tmpV2.lengthSq() < 1e-6) tmpV2.set(1, 0, 0);
      M.addScaledVector(tmpV2.normalize(), len * curv * 0.5);
      for (let s = 0; s < ARC_SEG; s++) {
        bez(A, M, B, s / ARC_SEG, P);
        bez(A, M, B, (s + 1) / ARC_SEG, Q);
        const o = (k * ARC_SEG + s) * 6;
        arr[o] = P.x; arr[o + 1] = P.y; arr[o + 2] = P.z;
        arr[o + 3] = Q.x; arr[o + 4] = Q.y; arr[o + 5] = Q.z;
      }
      if (k < 400) {
        bez(A, M, B, 0.92, P);
        bez(A, M, B, 0.95, Q);
        tmpQ.setFromUnitVectors(UP, tmpV.subVectors(Q, P).normalize());
        tmpS.setScalar(2.2 * (this.input!.tuning.runtimeWidth / 1.2));
        tmpM.compose(P, tmpQ, tmpS);
        this.arrows.setMatrixAt(k, tmpM);
      }
    });
    aa.needsUpdate = true;
    this.arrows.instanceMatrix.needsUpdate = true;
  }

  private writeTubesAndParticles(now: number) {
    const p = this.pos;
    const tu = this.input!.tuning;
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    let pc = 0;
    const pcap = this.particles.instanceMatrix.count;
    const particle = (pt: THREE.Vector3, r: number, color: THREE.Color) => {
      if (pc >= pcap) return;
      tmpM.makeScale(r, r, r).setPosition(pt);
      this.particles.setMatrixAt(pc, tmpM);
      this.particles.setColorAt(pc, color);
      pc++;
    };
    this.tubeShown.forEach((t, k) => {
      const l = this.links[t.l];
      A.fromArray(p, l.s * 3);
      B.fromArray(p, l.t * 3);
      const len = A.distanceTo(B) || 0.001;
      tmpV.subVectors(B, A).divideScalar(len);
      tmpQ.setFromUnitVectors(UP, tmpV);
      tmpS.set(0.32 * t.width, len, 0.32 * t.width);
      tmpM.compose(tmpV2.addVectors(A, B).multiplyScalar(0.5), tmpQ, tmpS);
      this.tubes.setMatrixAt(k, tmpM);
      // Particles run from importer to imported, as on the desktop.
      const n = Math.min(2, Math.max(1, tu.particles));
      for (let j = 0; j < n; j++) {
        const f = ((now * 0.012 * tu.particleSpeed * 60) / 1000 / Math.max(0.2, len / 40) + j / n) % 1;
        particle(tmpV2.lerpVectors(A, B, f), 0.7 * tu.particleSize, t.color);
      }
    });
    this.tubes.instanceMatrix.needsUpdate = true;
    // Runtime arcs carry amber particles while nothing is focused.
    if (this.emph.size === 0 && tu.particles > 0) {
      const curv = tu.curvature;
      const runtime = new THREE.Color(RUNTIME);
      const M = new THREE.Vector3(), P = new THREE.Vector3();
      for (const li of this.logical) {
        const l = this.links[li];
        A.fromArray(p, l.s * 3);
        B.fromArray(p, l.t * 3);
        const len = A.distanceTo(B);
        M.addVectors(A, B).multiplyScalar(0.5);
        tmpV.subVectors(B, A).normalize();
        tmpV2.crossVectors(tmpV, UP);
        if (tmpV2.lengthSq() < 1e-6) tmpV2.set(1, 0, 0);
        M.addScaledVector(tmpV2.normalize(), len * curv * 0.5);
        for (let j = 0; j < tu.particles; j++) {
          const f = ((now * 0.006 * tu.particleSpeed * 60) / 1000 / Math.max(0.2, len / 80) + j / tu.particles) % 1;
          particle(bez(A, M, B, f, P), 1.1 * tu.particleSize, runtime);
        }
      }
    }
    this.particles.count = pc;
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  private writeMarkers() {
    for (const o of this.overlayObjs.values()) {
      const c = this.centroidIdx(o.members);
      if (!c) continue;
      const r = this.radiusIdx(o.members, c);
      o.at.copy(c).add(tmpV.set(0, r * 0.6 + 22, 0));
      o.beacon.position.copy(o.at);
      const arr = (o.spokes.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
      o.members.forEach((i, k) => {
        arr.set([o.at.x, o.at.y, o.at.z, this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]], k * 6);
      });
      o.spokes.geometry.getAttribute("position").needsUpdate = true;
    }
    for (const n of this.noteObjs.values()) {
      const t = n.note.target;
      const a = this.index.get(t.kind === "file" ? t.path : t.from);
      const b = t.kind === "link" ? this.index.get(t.to) : a;
      if (a === undefined || b === undefined) {
        n.sprite.visible = false;
        continue;
      }
      n.sprite.visible = this.style.layers.notes !== false;
      n.at.set((this.pos[a * 3] + this.pos[b * 3]) / 2, (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) / 2 + this.base[a] + 9, (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) / 2);
    }
  }

  private writeRoute() {
    const attr = this.route.geometry.getAttribute("position") as THREE.BufferAttribute;
    let k = 0;
    for (const ids of this.stops) {
      const c = this.centroid(ids);
      if (!c) continue;
      attr.setXYZ(k++, c.x, c.y, c.z);
    }
    this.route.geometry.setDrawRange(0, k);
    attr.needsUpdate = true;
    this.route.computeLineDistances();
    this.route.visible = k > 1 && (this.input?.tuning.showCourse ?? true);
  }

  /* ------------------------------- geometry ------------------------------- */

  has(id: string) {
    return this.index.has(id);
  }

  neighboursOf(path: string) {
    return this.neighbours.get(path) ?? new Set<string>();
  }

  private centroidIdx(idx: number[]) {
    if (!idx.length) return null;
    const c = new THREE.Vector3();
    for (const i of idx) c.add(tmpV.fromArray(this.pos, i * 3));
    return c.divideScalar(idx.length);
  }

  private radiusIdx(idx: number[], c: THREE.Vector3) {
    const d = idx.map((i) => tmpV.fromArray(this.pos, i * 3).distanceTo(c) + this.base[i]).sort((a, b) => a - b);
    // The 90th percentile: one stray body shouldn't shrink the whole framing.
    return d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.9))] : 10;
  }

  centroid(ids: string[]) {
    return this.centroidIdx(ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined));
  }

  /** Centre and radius (map units) of some files, or of everything. */
  bounds(ids?: string[]): { center: THREE.Vector3; radius: number } | null {
    const idx = ids ? ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined) : this.nodes.map((_, i) => i);
    const c = this.centroidIdx(idx);
    if (!c) return null;
    return { center: c, radius: Math.max(idx.length === 1 ? this.base[idx[0]] * 4 : 12, this.radiusIdx(idx, c)) };
  }

  /** What a ray (in world space) points at: the nearest body within reach of it. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3): MapHit | null {
    if (!this.input) return null;
    this.root.updateWorldMatrix(true, false);
    const inv = tmpM.copy(this.root.matrixWorld).invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    const lay = this.style.layers;
    let best: MapHit | null = null;
    let bestScore = Infinity;
    const test = (x: number, y: number, z: number, r: number, mk: (t: number) => MapHit, bias = 1) => {
      const ox = x - o.x, oy = y - o.y, oz = z - o.z;
      const t = ox * d.x + oy * d.y + oz * d.z;
      if (t <= 0) return;
      const perp2 = ox * ox + oy * oy + oz * oz - t * t;
      // Within the body, or within a sliver of angle of it: small and far
      // bodies stay pointable.
      const reach = Math.max(r * 1.25, t * 0.014);
      if (perp2 > reach * reach) return;
      const score = t * bias + Math.sqrt(Math.max(0, perp2)) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = mk(t);
      }
    };
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.type === "file") {
        // Dimmed bodies can still be pointed at, but lit ones win.
        test(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.base[i], (t) => ({ kind: "file", id: n.id, t }), this.isLit(i) ? 1 : 1.6);
      } else if (n.type === "module") {
        const b = this.beacons.get(n.id);
        if (!b?.mesh.visible) continue;
        test(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.base[i], (t) => ({ kind: "module", id: n.id.slice(4), label: n.label, summary: n.summary, files: n.files, t }), 1.1);
      } else if (lay.folders !== false && !this.grouped && n.id !== "dir:.") {
        test(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], 1.2, (t) => ({ kind: "dir", id: n.id.slice(4), t }), 2.5);
      }
    }
    for (const [id, ov] of this.overlayObjs) if (ov.beacon.visible) test(ov.at.x, ov.at.y, ov.at.z, 10, (t) => ({ kind: "overlay", id, t }), 0.9);
    for (const [id, n] of this.noteObjs) if (n.sprite.visible) test(n.at.x, n.at.y, n.at.z, n.sprite.scale.y * 0.6, (t) => ({ kind: "note", id, t }), 0.8);
    return best;
  }

  /** A point in map units to world. */
  toWorld(v: THREE.Vector3) {
    this.root.updateWorldMatrix(true, false);
    return v.clone().applyMatrix4(this.root.matrixWorld);
  }

  /** Every file on the map, for scripted checks. */
  files() {
    return this.nodes.filter((n) => n.type === "file").map((n) => n.id);
  }

  positionOf(id: string) {
    const i = this.index.get(id);
    return i === undefined ? null : new THREE.Vector3().fromArray(this.pos, i * 3);
  }

  reheat() {
    this.worker.postMessage({ type: "reheat" } satisfies ToWorker);
  }

  setGlow(amount: number, bloom: boolean) {
    if (amount === this.glow.amount && bloom === this.glow.bloom) return;
    this.glow = { amount, bloom };
    this.restyle = true;
  }

  /** The body a hit is on, if it's one that can be dragged (files, beacons, folder points). */
  bodyOf(hit: MapHit): string | null {
    const id = hit.kind === "file" ? hit.id : hit.kind === "dir" ? `dir:${hit.id}` : hit.kind === "module" ? (this.index.has(`mod:${hit.id}`) ? `mod:${hit.id}` : `grp:${hit.id}`) : null;
    return id && this.index.has(id) ? id : null;
  }

  /** Hold a body at `at` (map units); the rest of the map gives way, as when dragging on the desktop. */
  drag(id: string, at: THREE.Vector3) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.dragging.set(i, [at.x, at.y, at.z]);
    this.pos.set([at.x, at.y, at.z], i * 3);
    this.moved = true;
    this.worker.postMessage({ type: "drag", index: i, x: at.x, y: at.y, z: at.z } satisfies ToWorker);
  }

  release(id: string) {
    const i = this.index.get(id);
    if (i === undefined || !this.dragging.delete(i)) return;
    this.worker.postMessage({ type: "release", index: i } satisfies ToWorker);
  }

  get count() {
    return this.nodes.length;
  }
}

const ARC_SEG = 16;

function bez(a: THREE.Vector3, m: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const u = 1 - t;
  return out.set(u * u * a.x + 2 * u * t * m.x + t * t * b.x, u * u * a.y + 2 * u * t * m.y + t * t * b.y, u * u * a.z + 2 * u * t * m.z + t * t * b.z);
}

/** A sticky note, as the desktop draws them: yellow, its first line. */
function noteCard(text: string): { sprite: THREE.Sprite; w: number } {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const first = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  ctx.font = cond(44, 600);
  const t = fit(ctx, first, 460);
  const w = Math.min(512, ctx.measureText(t).width + 48);
  roundRect(ctx, (512 - w) / 2, 8, w, 112, 14);
  ctx.fillStyle = C.note;
  ctx.fill();
  ctx.fillStyle = "#1b1606";
  ctx.textAlign = "center";
  ctx.fillText(t, 256, 80);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  sprite.renderOrder = 7;
  return { sprite, w: 4 };
}
