import { useMemo, useState } from "react";
import { EMPTY_FILTER, describe, isActive } from "../../shared/filter";
import type { GroupOverlay, Lens, LogicalModule, MapFilter, RepoGraph } from "../../shared/types";
import { territoryColors } from "../lib/colors";

export const OTHER = "__other";

/* ------------------------------- organize ------------------------------- */

/**
 * How the map is organized. Folders is the repo as stored; Modules is the
 * intro's logical map; the rest are groupings the navigator wrote on request.
 * "New grouping…" asks for another one in plain words.
 */
export function OrganizeBar({
  lensId,
  lenses,
  hasModules,
  busy,
  onPick,
  onRequest,
}: {
  lensId: string;
  lenses: Lens[];
  hasModules: boolean;
  busy: boolean;
  onPick: (id: string) => void;
  onRequest: (how: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [how, setHow] = useState("");
  const options = [
    { id: "folders", title: "Folders" },
    ...(hasModules ? [{ id: "modules", title: "Modules" }] : []),
    ...lenses.map((l) => ({ id: l.id, title: l.title })),
  ];

  return (
    <div className="pointer-events-auto flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Organize the map by">
        <span className="mr-1 text-[12.5px] text-muted">Organize by</span>
        {options.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={lensId === o.id}
            onClick={() => onPick(o.id)}
            className={`rounded-full px-2.5 py-0.5 text-[12.5px] ${
              lensId === o.id ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"
            }`}
          >
            {o.title}
          </button>
        ))}
        <button
          onClick={() => setAsking((a) => !a)}
          className="glass rounded-full px-2.5 py-0.5 text-[12.5px] text-muted hover:text-text"
          aria-expanded={asking}
        >
          New grouping…
        </button>
      </div>
      {asking && (
        <form
          className="glass rise flex w-[min(420px,calc(100vw-2rem))] items-center gap-2 rounded-lg px-2.5 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!how.trim()) return;
            onRequest(how.trim());
            setHow("");
            setAsking(false);
          }}
        >
          <input
            autoFocus
            value={how}
            onChange={(e) => setHow(e.target.value)}
            placeholder="by layer, by feature, by service, by data flow…"
            className="min-w-0 flex-1 bg-transparent py-0.5 text-[13.5px] focus:outline-none"
            aria-label="How should the navigator group the code?"
            onKeyDown={(e) => e.key === "Escape" && setAsking(false)}
          />
          <button disabled={busy} className="rounded-md bg-course px-2.5 py-0.5 font-cond text-[14px] font-semibold text-night disabled:opacity-50">
            Regroup
          </button>
        </form>
      )}
    </div>
  );
}

/** The groups of the active organization, as a key — and a way to fly to one. */
export function Legend({
  groups,
  counts,
  onPick,
}: {
  groups: LogicalModule[];
  counts: Map<string, number>;
  onPick: (g: LogicalModule) => void;
}) {
  // Same inputs as the space uses, so a legend dot and its cluster always match.
  const colors = useMemo(() => {
    const c = territoryColors(groups.filter((g) => g.id !== OTHER).map((g) => g.id));
    c.set(OTHER, "#5d6a85");
    return c;
  }, [groups]);
  return (
    <ul className="glass pointer-events-auto max-h-[38vh] w-[250px] overflow-y-auto rounded-lg py-1.5">
      {groups.map((g) => (
        <li key={g.id}>
          <button onClick={() => onPick(g)} className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-white/5" title={g.summary}>
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: colors.get(g.id) }} />
            <span className="min-w-0 flex-1 truncate text-[13px]">{g.label}</span>
            <span className="text-[11.5px] tabular-nums text-muted">{counts.get(g.id) ?? 0}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------- filter -------------------------------- */

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function FilterPanel({
  graph,
  filter,
  onChange,
  onClose,
}: {
  graph: RepoGraph;
  filter: MapFilter;
  onChange: (f: MapFilter) => void;
  onClose: () => void;
}) {
  const [include, setInclude] = useState(filter.include.join(", "));
  const [exclude, setExclude] = useState(filter.exclude.join(", "));

  const langs = useMemo(
    () => Object.entries(graph.languages).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l]) => l),
    [graph],
  );
  const tops = useMemo(() => {
    const count = new Map<string, number>();
    for (const f of graph.files) count.set(f.top, (count.get(f.top) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  }, [graph]);

  // Hand-edited filters drop the navigator's name and exact file set: they
  // no longer describe what's shown.
  const set = (patch: Partial<MapFilter>) => onChange({ ...filter, label: undefined, paths: undefined, ...patch });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="glass rise pointer-events-auto w-[min(400px,calc(100vw-2rem))] space-y-3 rounded-xl p-3.5">
      <div className="flex items-center justify-between">
        <h2 className="font-cond text-[18px] font-semibold">Filter the map</h2>
        <div className="flex gap-1">
          {isActive(filter) && (
            <button
              onClick={() => {
                setInclude("");
                setExclude("");
                onChange(EMPTY_FILTER);
              }}
              className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text"
            >
              Show everything
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text">
            Done
          </button>
        </div>
      </div>

      {!!filter.hidden?.length && (
        <div className="rounded-md border border-line px-2.5 py-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] text-muted">Hidden files ({filter.hidden.length})</span>
            <button onClick={() => onChange({ ...filter, hidden: [] })} className="text-[12.5px] text-course hover:underline">
              Show all
            </button>
          </div>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
            {filter.hidden.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text/85" title={p}>{p}</span>
                <button
                  onClick={() => onChange({ ...filter, hidden: filter.hidden!.filter((x) => x !== p) })}
                  className="shrink-0 text-[12px] text-muted hover:text-text"
                >
                  Show
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {filter.paths && (
        <p className="rounded-md bg-course/10 px-2.5 py-1.5 text-[12.5px] text-text/90">
          The navigator chose {filter.paths.length} files{filter.label ? ` for “${filter.label}”` : ""}. Editing below replaces its choice.
        </p>
      )}

      <label className="block">
        <span className="text-[12.5px] text-muted">Only paths matching</span>
        <input
          value={include}
          onChange={(e) => setInclude(e.target.value)}
          onBlur={() => set({ include: splitList(include) })}
          onKeyDown={(e) => e.key === "Enter" && set({ include: splitList(include) })}
          placeholder="internal/**, *.go, auth"
          className="mt-1 w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 font-mono text-[12.5px] focus:border-course/60 focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="text-[12.5px] text-muted">Hide paths matching</span>
        <input
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          onBlur={() => set({ exclude: splitList(exclude) })}
          onKeyDown={(e) => e.key === "Enter" && set({ exclude: splitList(exclude) })}
          placeholder="generated/**, *.pb.go, mocks"
          className="mt-1 w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 font-mono text-[12.5px] focus:border-course/60 focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap gap-1.5">
        <Chip on={filter.hideTests} onClick={() => set({ hideTests: !filter.hideTests })}>Hide tests</Chip>
        <Chip on={filter.hideDocs} onClick={() => set({ hideDocs: !filter.hideDocs })}>Hide docs and config</Chip>
      </div>

      <div>
        <p className="mb-1 text-[12.5px] text-muted">Languages</p>
        <div className="flex flex-wrap gap-1.5">
          {langs.map((l) => (
            <Chip key={l} on={filter.langs.includes(l)} onClick={() => set({ langs: toggle(filter.langs, l) })}>{l}</Chip>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-[12.5px] text-muted">Top-level folders</p>
        <div className="flex flex-wrap gap-1.5">
          {tops.map(([t, n]) => (
            <Chip key={t} on={filter.tops.includes(t)} onClick={() => set({ tops: toggle(filter.tops, t) })}>
              {t === "." ? "root" : t} <span className="text-muted">{n}</span>
            </Chip>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-muted">Patterns are globs or plain words. Selected chips narrow to just those.</p>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full px-2.5 py-0.5 text-[12.5px] ${on ? "bg-course/20 text-text ring-1 ring-course/60" : "border border-line text-muted hover:text-text"}`}
    >
      {children}
    </button>
  );
}

export { describe as describeFilter };

/* -------------------------------- groups -------------------------------- */

/**
 * Groups marked on top of the map. Making one never moves anything — it
 * draws a beacon over its files, in whatever organization the map is in.
 */
export function GroupsPanel({
  overlays,
  focusCount,
  focusLabel,
  filterCount,
  busy,
  onCreate,
  onAskNavigator,
  onToggle,
  onRemove,
  onFly,
  onClose,
}: {
  overlays: GroupOverlay[];
  focusCount: number;
  focusLabel?: string;
  filterCount: number | null;
  busy: boolean;
  onCreate: (g: { label: string; from: "focus" | "filter" | "pattern"; pattern?: string }) => void;
  onAskNavigator: (what: string) => void;
  onToggle: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
  onFly: (g: GroupOverlay) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<"focus" | "filter" | "pattern" | "navigator">(
    focusCount ? "focus" : filterCount ? "filter" : "pattern",
  );
  const [label, setLabel] = useState(focusLabel ?? "");
  const [pattern, setPattern] = useState("");
  const [ask, setAsk] = useState("");

  const sources = [
    { id: "focus" as const, title: `What's in focus (${focusCount})`, ok: focusCount > 0 },
    { id: "filter" as const, title: `What the filter shows (${filterCount ?? 0})`, ok: !!filterCount },
    { id: "pattern" as const, title: "Paths matching…", ok: true },
    { id: "navigator" as const, title: "Ask the navigator…", ok: true },
  ];

  const submit = () => {
    if (from === "navigator") {
      if (!ask.trim()) return;
      onAskNavigator(ask.trim());
      setAsk("");
      return;
    }
    if (!label.trim() || (from === "pattern" && !pattern.trim())) return;
    onCreate({ label: label.trim(), from, pattern: pattern.trim() || undefined });
    setLabel("");
    setPattern("");
  };

  return (
    <div className="glass rise pointer-events-auto w-[min(400px,calc(100vw-2rem))] space-y-3 rounded-xl p-3.5">
      <div className="flex items-center justify-between">
        <h2 className="font-cond text-[18px] font-semibold">Groups</h2>
        <div className="flex gap-1">
          {overlays.length > 1 && (
            <button
              onClick={() => {
                // Hide them all unless they're all hidden already, then show them all.
                const anyShown = overlays.some((g) => g.visible);
                for (const g of overlays) if (g.visible === anyShown) onToggle(g.id, !anyShown);
              }}
              className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text"
            >
              {overlays.some((g) => g.visible) ? "Hide all" : "Show all"}
            </button>
          )}
          <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text">Done</button>
        </div>
      </div>
      <p className="text-[12.5px] leading-snug text-muted">
        A group is drawn over its files as a beacon. The map keeps its current layout.
      </p>

      {overlays.length > 0 && (
        <ul className="space-y-0.5">
          {overlays.map((g) => (
            <li key={g.id} className={`flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/5 ${g.visible ? "" : "opacity-55"}`}>
              <button
                role="switch"
                aria-checked={g.visible}
                onClick={() => onToggle(g.id, !g.visible)}
                title={g.visible ? "Hide" : "Show"}
                className="h-3 w-3 shrink-0 rounded-full border-2"
                style={{ borderColor: g.color, background: g.visible ? g.color : "transparent" }}
              />
              <button onClick={() => onFly(g)} className="min-w-0 flex-1 truncate text-left text-[13px] hover:text-course" title={g.summary || "Fly there"}>
                {g.label}
              </button>
              <span className="text-[11.5px] tabular-nums text-muted">{g.paths.length}</span>
              {g.createdBy === "navigator" && <span className="text-[11px] text-muted" title="Marked by the navigator">nav</span>}
              <button
                onClick={() => onToggle(g.id, !g.visible)}
                className="w-10 shrink-0 rounded px-1 text-[12px] text-muted hover:bg-white/5 hover:text-text"
                title={g.visible ? "Hide from the map — it stays here" : "Show on the map"}
              >
                {g.visible ? "Hide" : "Show"}
              </button>
              <button onClick={() => onRemove(g.id)} className="rounded px-1 text-[12px] text-muted hover:text-bad" aria-label={`Remove ${g.label}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-[12.5px] text-muted">New group from</p>
        <div className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <button
              key={s.id}
              disabled={!s.ok}
              onClick={() => setFrom(s.id)}
              aria-pressed={from === s.id}
              className={`rounded-full px-2.5 py-0.5 text-[12.5px] disabled:opacity-35 ${
                from === s.id ? "bg-course/20 text-text ring-1 ring-course/60" : "border border-line text-muted hover:text-text"
              }`}
            >
              {s.title}
            </button>
          ))}
        </div>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {from === "navigator" ? (
            <input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder="everything that touches billing, the request hot path…"
              className="w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 text-[13px] focus:border-course/60 focus:outline-none"
              aria-label="What should the navigator mark?"
            />
          ) : (
            <>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Group name"
                className="w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 text-[13px] focus:border-course/60 focus:outline-none"
                aria-label="Group name"
              />
              {from === "pattern" && (
                <input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="internal/billing/**, *payment*"
                  className="w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 font-mono text-[12.5px] focus:border-course/60 focus:outline-none"
                  aria-label="Path patterns"
                />
              )}
            </>
          )}
          <button
            disabled={from === "navigator" && busy}
            className="rounded-md bg-course px-3 py-1 font-cond text-[15px] font-semibold text-night disabled:opacity-50"
          >
            {from === "navigator" ? "Ask to mark it" : "Add group"}
          </button>
        </form>
      </div>
    </div>
  );
}
