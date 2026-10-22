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
};

export type ToWorker =
  | { type: "graph"; nodes: LayoutNode[]; links: LayoutLink[]; params: LayoutParams; version: number }
  | { type: "reheat" };
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

function post(settled: boolean) {
  const positions = new Float32Array(order.length * 3);
  order.forEach((n, i) => {
    positions[i * 3] = n.x;
    positions[i * 3 + 1] = n.y;
    positions[i * 3 + 2] = n.z;
  });
  ctx.postMessage({ type: "tick", version, positions, settled } satisfies FromWorker, [positions.buffer]);
}

function run() {
  clearInterval(timer);
  startedAt = performance.now();
  timer = setInterval(() => {
    if (!sim) return;
    sim.tick();
    const done = performance.now() - startedAt > settleMs || sim.alpha() < 0.002;
    post(done);
    if (done) clearInterval(timer);
  }, 16);
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "reheat") {
    sim?.alpha(0.6);
    run();
    return;
  }
  version = msg.version;
  const p = msg.params;
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
  type SL = (typeof links)[number];
  const fresh = !sim;
  sim ??= forceSimulation([], 3).alphaDecay(0.0228);
  sim
    .nodes(order)
    .velocityDecay(p.friction)
    .force(
      "charge",
      forceManyBody().strength((n: SimNode) => (n.type === "module" && p.grouped ? -p.clusterSeparation : -p.repulsion)),
    )
    .force(
      "link",
      forceLink(links)
        .distance((l: SL) =>
          l.type === "member" && p.grouped
            ? p.clusterDistance
            : { contains: p.folderDistance, import: p.importDistance, member: 26, logical: p.runtimeDistance }[l.type],
        )
        .strength((l: SL) =>
          l.type === "member" && p.grouped
            ? p.clusterTightness
            : { contains: p.folderPull, import: p.importPull, member: 0.12, logical: p.runtimePull }[l.type],
        ),
    )
    .force("center", forceCenter())
    .stop();
  sim.alpha(fresh ? 1 : 0.7);
  // The desktop map warms up 40 ticks before it shows anything.
  if (fresh) for (let i = 0; i < 40; i++) sim.tick();
  post(false);
  run();
};
