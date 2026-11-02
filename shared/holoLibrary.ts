import type { Part } from "./board";

/**
 * Holograms ready to place, no assistant needed: each a set of parts that
 * glows, turns and pulls apart like one Jarvis would make. About 0.4 m tall,
 * standing on the table.
 */

export type Prefab = { name: string; color: string; parts: Part[] };

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const LIBRARY: Prefab[] = [
  {
    name: "Arc reactor",
    color: "cyan",
    parts: [
      { shape: "cylinder", radius: 0.13, height: 0.03, pos: [0, 0.2, 0], rot: [90, 0, 0], opacity: 0.08, explode: [0, 0, -0.12] },
      { shape: "torus", radius: 0.115, tube: 0.008, pos: [0, 0.2, 0.012], explode: [0, 0, 0.06], anim: { pulse: 0.6 } },
      { shape: "torus", radius: 0.07, tube: 0.006, pos: [0, 0.2, 0.02], color: "ice", explode: [0, 0, 0.12], anim: { spin: [0, 0, 40] } },
      { shape: "sphere", radius: 0.035, pos: [0, 0.2, 0.025], color: "white", opacity: 0.5, explode: [0, 0, 0.2], anim: { pulse: 1 } },
      ...range(10).map((i): Part => {
        const a = (i / 10) * Math.PI * 2;
        return { shape: "box", size: [0.016, 0.04, 0.012], pos: [Math.cos(a) * 0.092, 0.2 + Math.sin(a) * 0.092, 0.016], rot: [0, 0, (a * 180) / Math.PI + 90], explode: [Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0.03] };
      }),
      { shape: "cylinder", radius: 0.012, height: 0.18, pos: [0, 0.09, 0], opacity: 0.1 },
      { shape: "ring", radius: 0.08, tube: 0.05, pos: [0, 0.004, 0] },
    ],
  },
  {
    name: "Globe",
    color: "teal",
    parts: [
      { shape: "sphere", radius: 0.14, pos: [0, 0.22, 0], opacity: 0.05, anim: { spin: [0, 12, 0] } },
      ...range(6).map((i): Part => ({ shape: "torus", radius: 0.14, tube: 0.0015, pos: [0, 0.22, 0], rot: [0, i * 30, 0], anim: { spin: [0, 12, 0] }, explode: [0, 0, 0] })),
      ...range(5).map((i): Part => {
        const y = (i - 2) * 0.05;
        const r = Math.sqrt(Math.max(0, 0.14 * 0.14 - y * y));
        return { shape: "torus", radius: r, tube: 0.0015, pos: [0, 0.22 + y, 0], rot: [90, 0, 0], explode: [0, y * 0.8, 0] };
      }),
      { shape: "torus", radius: 0.19, tube: 0.003, pos: [0, 0.22, 0], rot: [70, 0, 20], color: "amber", anim: { spin: [0, 0, 30] }, explode: [0, 0.1, 0] },
      { shape: "sphere", radius: 0.012, pos: [0.19, 0.22, 0], color: "amber", anim: { pulse: 0.8 }, explode: [0.12, 0.1, 0] },
      { shape: "cone", radius: 0.06, height: 0.06, pos: [0, 0.03, 0], opacity: 0.08 },
    ],
  },
  {
    name: "Server rack",
    color: "blue",
    parts: [
      { shape: "box", size: [0.16, 0.38, 0.14], pos: [0, 0.19, 0], opacity: 0.04, wire: false, explode: [0, 0, -0.14] },
      ...range(7).map((i): Part => ({ shape: "box", size: [0.14, 0.035, 0.12], pos: [0, 0.03 + i * 0.05, 0.005], opacity: 0.12, explode: [0, 0, 0.05 + i * 0.03] })),
      ...range(7).map((i): Part => ({ shape: "sphere", radius: 0.005, pos: [0.055, 0.03 + i * 0.05, 0.068], color: i % 3 ? "green" : "amber", anim: { pulse: 1 }, explode: [0, 0, 0.05 + i * 0.03] })),
    ],
  },
  {
    name: "Rocket",
    color: "ice",
    parts: [
      { shape: "lathe", points: [[0, 0.42], [0.025, 0.38], [0.045, 0.31], [0.05, 0.24]], pos: [0, 0, 0], explode: [0, 0.12, 0] },
      { shape: "cylinder", radius: 0.05, height: 0.16, pos: [0, 0.16, 0], explode: [0, 0.04, 0] },
      { shape: "cylinder", radius: 0.05, radiusTop: 0.05, height: 0.04, pos: [0, 0.06, 0], color: "amber", explode: [0, -0.02, 0] },
      { shape: "cone", radius: 0.035, height: 0.04, pos: [0, 0.025, 0], rot: [180, 0, 0], color: "orange", explode: [0, -0.08, 0], anim: { pulse: 1 } },
      ...range(3).map((i): Part => {
        const a = (i / 3) * Math.PI * 2;
        return { shape: "extrude", points: [[0, 0], [0.05, -0.02], [0.05, 0.03], [0, 0.07]], depth: 0.004, pos: [Math.cos(a) * 0.048, 0.04, Math.sin(a) * 0.048], rot: [0, (-a * 180) / Math.PI, 0], explode: [Math.cos(a) * 0.1, -0.02, Math.sin(a) * 0.1] };
      }),
      { shape: "sphere", radius: 0.014, pos: [0, 0.27, 0.045], color: "white", opacity: 0.4, explode: [0, 0.05, 0.08] },
    ],
  },
  {
    name: "DNA helix",
    color: "magenta",
    parts: [
      ...range(20).flatMap((i): Part[] => {
        const t = i / 20;
        const a = t * Math.PI * 4;
        const y = 0.03 + t * 0.36;
        const x = Math.cos(a) * 0.06;
        const z = Math.sin(a) * 0.06;
        return [
          { shape: "sphere", radius: 0.009, pos: [x, y, z], explode: [x * 0.8, 0, z * 0.8] },
          { shape: "sphere", radius: 0.009, pos: [-x, y, -z], color: "cyan", explode: [-x * 0.8, 0, -z * 0.8] },
          { shape: "box", size: [0.12, 0.003, 0.003], pos: [0, y, 0], rot: [0, (-a * 180) / Math.PI, 0], color: "violet", opacity: 0.3 },
        ];
      }),
    ],
  },
  {
    name: "Robot arm",
    color: "amber",
    parts: [
      { shape: "cylinder", radius: 0.07, height: 0.03, pos: [0, 0.015, 0], explode: [0, -0.04, 0] },
      { shape: "cylinder", radius: 0.03, height: 0.05, pos: [0, 0.055, 0], anim: { spin: [0, 20, 0] } },
      { shape: "box", size: [0.035, 0.17, 0.035], pos: [0.03, 0.15, 0], rot: [0, 0, -20], explode: [0.04, 0.04, 0] },
      { shape: "sphere", radius: 0.025, pos: [0.06, 0.23, 0], color: "cyan", explode: [0.06, 0.06, 0] },
      { shape: "box", size: [0.03, 0.14, 0.03], pos: [0.12, 0.27, 0], rot: [0, 0, -60], explode: [0.1, 0.08, 0] },
      { shape: "torus", radius: 0.018, tube: 0.005, pos: [0.18, 0.3, 0], rot: [0, 90, 0], color: "cyan", explode: [0.15, 0.1, 0], anim: { spin: [60, 0, 0] } },
      { shape: "box", size: [0.008, 0.04, 0.012], pos: [0.2, 0.29, 0.012], color: "white", explode: [0.18, 0.1, 0.04] },
      { shape: "box", size: [0.008, 0.04, 0.012], pos: [0.2, 0.29, -0.012], color: "white", explode: [0.18, 0.1, -0.04] },
    ],
  },
  {
    name: "Satellite",
    color: "gold",
    parts: [
      { shape: "box", size: [0.08, 0.1, 0.08], pos: [0, 0.22, 0], explode: [0, 0, 0] },
      { shape: "box", size: [0.18, 0.004, 0.07], pos: [-0.14, 0.22, 0], color: "blue", opacity: 0.25, explode: [-0.12, 0, 0] },
      { shape: "box", size: [0.18, 0.004, 0.07], pos: [0.14, 0.22, 0], color: "blue", opacity: 0.25, explode: [0.12, 0, 0] },
      { shape: "lathe", points: [[0, 0], [0.05, 0.02], [0.06, 0.035]], pos: [0, 0.28, 0], explode: [0, 0.1, 0] },
      { shape: "cylinder", radius: 0.003, height: 0.06, pos: [0, 0.31, 0], explode: [0, 0.14, 0] },
      { shape: "sphere", radius: 0.006, pos: [0, 0.34, 0], color: "red", anim: { pulse: 1 }, explode: [0, 0.16, 0] },
      { shape: "torus", radius: 0.25, tube: 0.0015, pos: [0, 0.22, 0], rot: [80, 0, 0], color: "ice", anim: { spin: [0, 0, 10] } },
    ],
  },
  {
    name: "City block",
    color: "cyan",
    parts: [
      { shape: "plane", size: [0.36, 0.36, 0], pos: [0, 0.002, 0], rot: [-90, 0, 0], opacity: 0.05 },
      ...range(16).map((i): Part => {
        const x = ((i % 4) - 1.5) * 0.085;
        const z = (Math.floor(i / 4) - 1.5) * 0.085;
        const h = 0.05 + ((i * 7919) % 13) * 0.022;
        return { shape: "box", size: [0.05, h, 0.05], pos: [x, h / 2, z], color: i % 5 === 0 ? "amber" : undefined, explode: [x * 0.6, h * 0.6, z * 0.6] };
      }),
    ],
  },
  {
    name: "Neural net",
    color: "violet",
    parts: [
      ...[3, 5, 5, 2].flatMap((n, layer): Part[] =>
        range(n).map((i) => ({ shape: "sphere", radius: 0.014, pos: [(layer - 1.5) * 0.1, 0.22 + (i - (n - 1) / 2) * 0.055, 0], color: layer === 3 ? "amber" : undefined, anim: { pulse: 0.5 }, explode: [(layer - 1.5) * 0.08, 0, 0] })),
      ),
      ...[3, 5, 5].flatMap((n, layer): Part[] => {
        const next = [5, 5, 2][layer];
        return range(n).flatMap((i) =>
          range(next).map((j) => ({
            shape: "tube" as const,
            points: [
              [(layer - 1.5) * 0.1, 0.22 + (i - (n - 1) / 2) * 0.055, 0],
              [(layer - 0.5) * 0.1, 0.22 + (j - (next - 1) / 2) * 0.055, 0],
            ],
            radius: 0.0012,
            opacity: 0.3,
          })),
        );
      }),
    ],
  },
  {
    name: "Gear train",
    color: "amber",
    parts: [
      { shape: "gear", radius: 0.09, teeth: 18, depth: 0.025, pos: [-0.07, 0.2, 0], anim: { spin: [0, 0, 30] }, explode: [-0.08, 0, 0.05] },
      { shape: "gear", radius: 0.06, teeth: 12, depth: 0.025, pos: [0.08, 0.2, 0], anim: { spin: [0, 0, -45] }, explode: [0.08, 0, 0.05] },
      { shape: "gear", radius: 0.04, teeth: 8, depth: 0.025, pos: [0.08, 0.31, 0], anim: { spin: [0, 0, 67] }, explode: [0.06, 0.08, 0.05] },
      { shape: "box", size: [0.3, 0.02, 0.05], pos: [0, 0.07, 0], opacity: 0.08, explode: [0, -0.04, 0] },
      { shape: "cylinder", radius: 0.006, height: 0.13, pos: [-0.07, 0.135, -0.015] },
      { shape: "cylinder", radius: 0.006, height: 0.13, pos: [0.08, 0.135, -0.015] },
    ],
  },
];

export function findPrefab(name: string): Prefab | undefined {
  const n = name.trim().toLowerCase();
  return LIBRARY.find((p) => p.name.toLowerCase() === n) ?? LIBRARY.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()));
}
