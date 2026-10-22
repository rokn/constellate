/// <reference lib="webworker" />
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

/**
 * The map's layout, off the render thread. The desktop map runs d3-force-3d
 * inside 3d-force-graph on the page's own thread; on a headset that would cost
 * the frame budget the reprojection needs, so the same forces run here and the
 * page only gets positions back.
 *
 * Forces and their knobs are the desktop's (see Space.tsx, setForces): charge
 * by repulsion (beacons repel by clusterSeparation when grouped), and link
 * distance and strength per link type.
 */

export type LayoutNode = { id: string; type: "file" | "dir" | "module"; x?: number; y?: number; z?: number; pinned?: boolean };
export type LayoutLink = { s: number; t: number; type: "import" | "contains" | "member" | "logical" };
export type LayoutParams = {
  grouped: boolean;
  repulsion: number;
  clusterSeparation: number;
  folderPull: number;
  folderDistance: number;
  importPull: number;
  importDistance: number;
  clusterTightness: number;
  clusterDistance: number;
  runtimePull: number;
  runtimeDistance: number;
  friction: number;
  settleSeconds: number;
  freeze: boolean;
};

export type ToWorker =
  /** `gentle`: only bodies went away (a hide, a filter): the rest settle in place instead of being stirred up. */
  | { type: "graph"; nodes: LayoutNode[]; links: LayoutLink[]; params: LayoutParams; version: number; gentle?: boolean }
  | { type: "reheat" }
  /** New knobs, same graph: the forces change and the layout warms up to show it. */
  | { type: "params"; params: LayoutParams }
  /** A body held by a hand: pinned where the hand is while the rest give way. */
  | { type: "drag"; index: number; x: number; y: number; z: number }
  /** `pin`: it stays where it was let go. */
  | { type: "release"; index: number; pin?: boolean };
export type FromWorker = { type: "tick"; version: number; positions: Float32Array; settled: boolean };

type SimNode = { id: string; type: LayoutNode["type"]; index?: number; x: number; y: number; z: number; vx?: number; vy?: number; vz?: number; fx?: number; fy?: number; fz?: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const byId = new Map<string, SimNode>();
let sim: ReturnType<typeof forceSimulation> | null = null;
let order: SimNode[] = [];
let version = 0;
let startedAt = 0;
let settleMs = 14000;
let timer: ReturnType<typeof setInterval> | undefined;
let params: LayoutParams | null = null;
/** Bodies being dragged right now: the simulation keeps running while any are. */
const held = new Set<SimNode>();

function post(settled: boolean) {
  const positions = new Float32Array(order.length * 3);
  order.forEach((n, i) => {
    positions[i * 3] = n.x;
    positions[i * 3 + 1] = n.y;
    positions[i * 3 + 2] = n.z;
  });
  ctx.postMessage({ type: "tick", version, positions, settled } satisfies FromWorker, [positions.buffer]);
}

function run(evenFrozen = false) {
  clearInterval(timer);
  // Frozen: bodies stay where they are, unless one is being dragged. (A new
  // graph still settles: the headset's layout starts from nothing.)
  if (params?.freeze && !held.size && !evenFrozen) return;
  startedAt = performance.now();
  timer = setInterval(() => {
    if (!sim) return;
    sim.tick();
    const done = !held.size && (performance.now() - startedAt > settleMs || sim.alpha() < 0.002);
    post(done);
    if (done) clearInterval(timer);
  }, 16);
}

/** The desktop's forces (Space.tsx, setForces), from the knobs. */
function setForces(p: LayoutParams, links: { source: SimNode; target: SimNode; type: LayoutLink["type"] }[] | null) {
  if (!sim) return;
  type SL = { type: LayoutLink["type"] };
  sim
    .velocityDecay(p.friction)
    .force(
      "charge",
      forceManyBody().strength((n: SimNode) => (n.type === "module" && p.grouped ? -p.clusterSeparation : -p.repulsion)),
    );
  const link = links ? forceLink(links) : sim.force("link");
  if (!link) return;
  link
    .distance((l: SL) =>
      l.type === "member" && p.grouped ? p.clusterDistance : { contains: p.folderDistance, import: p.importDistance, member: 26, logical: p.runtimeDistance }[l.type],
    )
    .strength((l: SL) => (l.type === "member" && p.grouped ? p.clusterTightness : { contains: p.folderPull, import: p.importPull, member: 0.12, logical: p.runtimePull }[l.type]));
  if (links) sim.force("link", link);
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "reheat") {
    sim?.alpha(0.6);
    run();
    return;
  }
  if (msg.type === "params") {
    const was = params;
    params = msg.params;
    settleMs = params.settleSeconds * 1000;
    setForces(params, null);
    // As on the desktop: new forces (or unfreezing) warm the layout up to show them.
    if (!params.freeze && (!was || was.freeze || JSON.stringify({ ...was, friction: 0, settleSeconds: 0 }) !== JSON.stringify({ ...params, friction: 0, settleSeconds: 0 }))) {
      sim?.alpha(0.6);
      run();
    } else if (params.freeze) clearInterval(timer);
    return;
  }
  if (msg.type === "drag" || msg.type === "release") {
    const n = order[msg.index];
    if (!n || !sim) return;
    if (msg.type === "drag") {
      Object.assign(n, { x: msg.x, y: msg.y, z: msg.z, fx: msg.x, fy: msg.y, fz: msg.z });
      if (!held.has(n)) {
        held.add(n);
        // Keep the engine running at a low heat while the body is held, as the desktop's drag does.
        sim.alphaTarget(0.3);
        run();
      }
    } else if (held.delete(n)) {
      if (!msg.pin) delete n.fx, delete n.fy, delete n.fz;
      if (!held.size) sim.alphaTarget(0);
      run();
    }
    return;
  }
  version = msg.version;
  const p = msg.params;
  params = p;
  held.clear();
  settleMs = p.settleSeconds * 1000;
  // Bodies already on the map keep their place and velocity, so a regroup or a
  // filter moves the map into its new shape instead of exploding it.
  const next = new Map<string, SimNode>();
  order = msg.nodes.map((n) => {
    const prev = byId.get(n.id);
    const s: SimNode = prev ?? {
      id: n.id,
      type: n.type,
      x: n.x ?? (Math.random() - 0.5) * 200,
      y: n.y ?? (Math.random() - 0.5) * 200,
      z: n.z ?? (Math.random() - 0.5) * 200,
    };
    s.type = n.type;
    if (n.pinned) Object.assign(s, { fx: s.x, fy: s.y, fz: s.z });
    else delete s.fx, delete s.fy, delete s.fz;
    next.set(n.id, s);
    return s;
  });
  byId.clear();
  for (const [k, v] of next) byId.set(k, v);

  const links = msg.links.map((l) => ({ source: order[l.s], target: order[l.t], type: l.type }));
  const fresh = !sim;
  sim ??= forceSimulation([], 3).alphaDecay(0.0228);
  sim.nodes(order).alphaTarget(0);
  setForces(p, links);
  sim.force("center", forceCenter()).stop();
  sim.alpha(fresh ? 1 : msg.gentle ? 0.08 : 0.7);
  // The desktop map warms up 40 ticks before it shows anything.
  if (fresh) for (let i = 0; i < 40; i++) sim.tick();
  post(false);
  run(true);
};
