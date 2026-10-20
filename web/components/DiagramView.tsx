import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import dagre from "@dagrejs/dagre";
import type { DiagramEdge, DiagramNode } from "../../shared/types";

/**
 * The diagram renderer.
 *
 * Layout and edge routing are dagre's, not ours. The first version hand-rolled
 * both, and per-edge heuristics produced exactly what hand-rolled graph layout
 * always produces eventually: sideways arrows into top-down flows, edges routed
 * through label chips, labels stacked on labels. Dagre is the layered-layout
 * algorithm behind most diagram tools that work — it minimizes crossings,
 * routes edges around nodes with bend points, and reserves space in the layout
 * for every edge label, which makes label collisions impossible by
 * construction rather than unlikely by tuning.
 *
 * We keep the rendering: nodes are plain HTML (real, highlightable, wrappable
 * text; addressable for emphasis and zooming), edges are an SVG underlay drawn
 * through dagre's points.
 */

export type DiagramSpecView = {
  dir: "TD" | "LR";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

type LaidOut = {
  w: number;
  h: number;
  nodes: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: { id: string; from: string; to: string; d: string; label?: string; lx: number; ly: number }[];
};

/** Rough chip footprint for an edge label — dagre reserves this in the layout. */
function labelBox(label: string) {
  return { width: Math.ceil(label.length * 6.3) + 18, height: 22 };
}

/** A smooth path through dagre's points: quadratics through the bends. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i];
    const n = pts[i + 1];
    d += ` Q ${c.x} ${c.y} ${(c.x + n.x) / 2} ${(c.y + n.y) / 2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function runDagre(spec: DiagramSpecView, sizes: Map<string, { w: number; h: number }>): LaidOut {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: spec.dir === "LR" ? "LR" : "TB",
    nodesep: 28,
    ranksep: 48,
    edgesep: 18,
    marginx: 12,
    marginy: 12,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of spec.nodes) {
    const s = sizes.get(n.id) ?? { w: 120, h: 40 };
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of spec.edges) {
    if (e.from === e.to) continue; // self-loops explain nothing at this size
    g.setEdge(e.from, e.to, e.label ? { ...labelBox(e.label), labelpos: "c" } : {});
  }

  dagre.layout(g);

  const nodes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (n) nodes.set(id, { x: n.x, y: n.y, w: n.width, h: n.height });
  }

  const edges: LaidOut["edges"] = [];
  for (const e of g.edges()) {
    const ge = g.edge(e);
    if (!ge?.points?.length) continue;
    const spec_ = spec.edges.find((s) => s.from === e.v && s.to === e.w);
    edges.push({
      id: `${e.v}->${e.w}`,
      from: e.v,
      to: e.w,
      d: smoothPath(ge.points),
      label: spec_?.label,
      lx: ge.x ?? ge.points[Math.floor(ge.points.length / 2)].x,
      ly: ge.y ?? ge.points[Math.floor(ge.points.length / 2)].y,
    });
  }

  const graph = g.graph();
  return { w: Math.ceil(graph.width ?? 0), h: Math.ceil(graph.height ?? 0), nodes, edges };
}

export function DiagramView(props: {
  spec: DiagramSpecView;
  /** Resting edge colour: cyan for static structure, amber for runtime behaviour. */
  tone?: string;
  /** Node ids (or "from->to" edge ids) to emphasize; everything else dims. */
  emphasis?: string[];
  onNodeClick?: (nodeId: string) => void;
  /** Allow scaling up (to 2×), not just down — for a full-screen view. */
  grow?: boolean;
  /** Also fit within this height, in pixels. */
  maxHeight?: number;
  /** Draw at natural size, unscaled — when something outside handles zoom. */
  natural?: boolean;
}) {
  // A new spec is a full remount: measurement and layout state reset naturally
  // instead of being carefully invalidated.
  const key = useMemo(
    () => JSON.stringify([props.spec.dir, props.spec.nodes, props.spec.edges]),
    [props.spec],
  );
  return <Laid key={key} {...props} />;
}

function Laid({
  spec,
  tone = "var(--muted)",
  emphasis = [],
  onNodeClick,
  grow = false,
  maxHeight,
  natural = false,
}: {
  spec: DiagramSpecView;
  tone?: string;
  emphasis?: string[];
  onNodeClick?: (nodeId: string) => void;
  grow?: boolean;
  maxHeight?: number;
  natural?: boolean;
}) {
  const markerId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const measureRefs = useRef(new Map<string, HTMLDivElement>());
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }> | null>(null);

  // Pass 1: the nodes render invisibly in normal flow so the browser tells us
  // their real wrapped sizes; dagre needs them before it can place anything.
  // DOM measurement is the one legitimate reason to set state from a layout
  // effect: the sizes cannot exist before the browser has laid the text out,
  // and the `sizes` guard makes this run exactly once per spec (the component
  // remounts per spec via the key above).
  useLayoutEffect(() => {
    if (sizes) return;
    const m = new Map<string, { w: number; h: number }>();
    for (const n of spec.nodes) {
      const el = measureRefs.current.get(n.id);
      if (el) m.set(n.id, { w: el.offsetWidth, h: el.offsetHeight });
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (m.size === spec.nodes.length) setSizes(m);
  }, [sizes, spec.nodes]);

  const layout = useMemo(() => (sizes ? runDagre(spec, sizes) : null), [sizes, spec]);

  // Fit to the panel rather than scroll sideways: a pipeline drawn LR is
  // often wider than the dossier, and half a diagram explains nothing.
  const frame = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);

    const emphasized = useMemo(() => new Set(emphasis), [emphasis]);
  const hasEmphasis = emphasized.size > 0;

  if (!layout) {
    return (
      <div className="flex flex-wrap gap-2 opacity-0" aria-hidden>
        {spec.nodes.map((n) => (
          <div
            key={n.id}
            ref={(el) => {
              if (el) measureRefs.current.set(n.id, el);
              else measureRefs.current.delete(n.id);
            }}
            className="max-w-[220px] rounded-md border border-line px-3.5 py-2 text-center"
          >
            <p className="text-[13px] font-medium leading-snug">{n.label}</p>
            {n.detail && <p className="mt-0.5 text-[11.5px] leading-snug">{n.detail}</p>}
          </div>
        ))}
      </div>
    );
  }

  // Shrink to fit the width (and height, if bounded); grow too when allowed.
  const fit = natural
    ? 1
    : avail
      ? Math.min(grow ? 2 : 1, avail / layout.w, maxHeight ? maxHeight / layout.h : Infinity)
      : 1;

  return (
    <div ref={frame} style={{ height: layout.h * fit, width: natural ? layout.w : undefined }}>
      <div
        className="relative origin-top-left"
        style={{
          width: layout.w,
          height: layout.h,
          transform: fit !== 1 ? `scale(${fit})` : undefined,
          // Centred by hand: a scaled box keeps its unscaled width for layout.
          marginLeft: !natural && avail ? Math.max(0, (avail - layout.w * fit) / 2) : undefined,
        }}
      >
        {/* Edge underlay */}
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={layout.w}
          height={layout.h}
          aria-hidden
        >
          <defs>
            <marker
              id={`a${markerId}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill={tone} />
            </marker>
            <marker
              id={`h${markerId}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--course)" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const hot =
              emphasized.has(e.id) || (emphasized.has(e.from) && emphasized.has(e.to));
            const dim = hasEmphasis && !hot;
            return (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={hot ? "var(--course)" : tone}
                strokeOpacity={dim ? 0.25 : hot ? 1 : 0.55}
                strokeWidth={hot ? 2 : 1.4}
                markerEnd={`url(#${hot ? "h" : "a"}${markerId})`}
              />
            );
          })}
        </svg>

        {/* Edge labels: above the edges, below the nodes. Dagre reserved this
            spot in the layout, so nothing else occupies it. */}
        {layout.edges.map(
          (e) =>
            e.label && (
              <span
                key={`l-${e.id}`}
                className={`pointer-events-none absolute z-[1] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-line bg-panelsolid px-1.5 py-0.5 font-sans text-[11px] ${
                  emphasized.has(e.id) || (emphasized.has(e.from) && emphasized.has(e.to))
                    ? "border-course/60 text-course"
                    : "text-muted"
                } ${
                  hasEmphasis &&
                  !(emphasized.has(e.id) || (emphasized.has(e.from) && emphasized.has(e.to)))
                    ? "opacity-40"
                    : ""
                }`}
                style={{ left: e.lx, top: e.ly }}
              >
                {e.label}
              </span>
            ),
        )}

        {/* Nodes at dagre's positions */}
        {spec.nodes.map((n) => {
          const p = layout.nodes.get(n.id);
          if (!p) return null;
          const hot = emphasized.has(n.id);
          const dim = hasEmphasis && !hot;
          return (
            <div
              key={n.id}
              data-node-id={n.id}
              onClick={onNodeClick && n.path ? () => onNodeClick(n.id) : undefined}
              className={`absolute z-[2] rounded-md border bg-panelsolid px-3.5 py-2 text-center transition-all duration-200 ${
                hot ? "border-course shadow-[0_0_0_1px_var(--course)]" : "border-line"
              } ${dim ? "opacity-45" : ""} ${
                onNodeClick && n.path ? "cursor-pointer hover:border-course/70" : ""
              }`}
              style={{
                left: p.x - p.w / 2,
                top: p.y - p.h / 2,
                width: p.w,
              }}
            >
              <p className="text-[13px] font-medium leading-snug">{n.label}</p>
              {n.detail && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{n.detail}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
