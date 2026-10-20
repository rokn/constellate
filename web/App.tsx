import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Frame, Layer, LogicalModule, MapFilter, ScreenContext, Topic, UiCommand, ViewSettings } from "../shared/types";
import { EMPTY_FILTER, applyFilter, describe, isActive } from "../shared/filter";
import { ask, clearFileCache, config, post, useGraph, useSession } from "./lib/api";
import { useVoice } from "./lib/useVoice";
import { Space, type Grouping, type Overlay, type SpaceHandle } from "./components/Space";
import { FilterPanel, GroupsPanel, Legend, OTHER, OrganizeBar } from "./components/MapControls";
import { TuningPanel } from "./components/TuningPanel";
import { DEFAULT_TUNING, loadTuning, saveTuning, type Tuning } from "./lib/tuning";
import { Dossier, type Pointer } from "./components/Dossier";
import { FilePanel } from "./components/FilePanel";
import { CommandBar, type Jump } from "./components/CommandBar";
import { ActivityTicker, Destinations, Intro, Landing, TourCaption, VoiceDock, rememberRepo } from "./components/Overlays";

const DEFAULT_LAYERS: Record<Layer, boolean> = { imports: false, logical: true, labels: true };

/** A place you've been, so "back" retraces the flight. */
type Stop =
  | { kind: "overview" }
  | { kind: "file"; path: string; line?: number; endLine?: number }
  | { kind: "focus"; paths: string[]; label?: string }
  | { kind: "frame"; frameId: string };

const TOUR_STEP_MS = 7000;

export function App() {
  const { state } = useSession();
  const status = state?.status ?? "idle";
  const graph = useGraph(state?.graphVersion, status !== "idle" && status !== "scanning");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => void config().then((c) => setVoiceAvailable(c.voice)).catch(() => {}), []);

  const space = useRef<SpaceHandle>(null);
  // Map labels are painted to canvas once, so the faces have to be loaded first.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    void Promise.all(
      ['600 20px "Barlow Condensed"', '500 20px "Barlow Condensed"', '12px "JetBrains Mono"'].map((f) => document.fonts.load(f)),
    )
      .catch(() => {})
      .finally(() => setFontsReady(true));
  }, []);
  const askInput = useRef<HTMLInputElement>(null);

  const [layers, setLayers] = useState<Record<Layer, boolean>>(DEFAULT_LAYERS);
  const [file, setFile] = useState<{ path: string; line?: number; endLine?: number } | null>(null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [emphasis, setEmphasis] = useState<string[]>([]);
  const [focusLabel, setFocusLabel] = useState<string | undefined>();
  const [pointer, setPointer] = useState<Pointer>(null);
  const [introDone, setIntroDone] = useState(false);
  const [tour, setTour] = useState<number | null>(null);
  const [selection, setSelection] = useState("");
  const [filter, setFilter] = useState<MapFilter>(EMPTY_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  /** "folders", "modules", or the id of a lens the navigator wrote. */
  const [lensId, setLensId] = useState("folders");
  // Knobs start from the last values used in this browser, then each repo's
  // own saved view replaces them when it opens (see the repo-change effect).
  const [tuning, setTuning] = useState<Tuning>(loadTuning);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  /** Opening one left-hand panel closes the other; they share the column. */
  const openPanel = (which: "filter" | "groups" | null) => {
    setFilterOpen(which === "filter");
    setGroupsOpen(which === "groups");
  };
  const history = useRef<Stop[]>([]);

  /**
   * Where the camera should put its subject, given the panels about to be
   * open: right of centre past the code panel, left of centre clear of the
   * dossier, centred between both. Read from a ref because the panel state a
   * flight is for is usually being set in the same handler.
   */
  const panels = useRef({ file: false, frame: false });
  const shiftFor = (p: { file: boolean; frame: boolean }) => (p.file && !p.frame ? 0.32 : p.frame && !p.file ? -0.3 : 0);

  const frames = useMemo(() => state?.frames ?? [], [state?.frames]);
  const overview = state?.overview;
  const lenses = useMemo(() => state?.lenses ?? [], [state?.lenses]);
  const overlays = useMemo(() => state?.overlays ?? [], [state?.overlays]);
  const shownOverlays: Overlay[] = useMemo(
    () => overlays.filter((o) => o.visible).map((o) => ({ id: o.id, label: o.label, paths: o.paths, color: o.color })),
    [overlays],
  );

  /* ------------------------------ map shape ------------------------------- */

  const visible = useMemo(() => (graph ? applyFilter(graph.files, filter) : null), [graph, filter]);

  const grouping: Grouping | null = useMemo(() => {
    if (lensId === "modules" && overview) return { key: "modules", groups: overview.modules, edges: overview.edges };
    const lens = lenses.find((l) => l.id === lensId);
    return lens ? { key: lens.id, groups: lens.groups, edges: lens.edges } : null;
  }, [lensId, overview, lenses]);
  const lensTitle = lensId === "folders" ? "folders" : lensId === "modules" ? "modules" : lenses.find((l) => l.id === lensId)?.title;

  // The legend: each group with how many of the visible files it holds.
  const legend = useMemo(() => {
    if (!grouping || !graph) return null;
    const groupOf = new Map<string, string>();
    for (const g of grouping.groups) for (const p of g.paths) if (!groupOf.has(p)) groupOf.set(p, g.id);
    const counts = new Map<string, number>();
    const others: string[] = [];
    for (const f of graph.files) {
      if (visible && !visible.has(f.path)) continue;
      const id = groupOf.get(f.path);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      else others.push(f.path);
    }
    const groups: LogicalModule[] = grouping.groups.filter((g) => counts.get(g.id));
    if (others.length) {
      counts.set(OTHER, others.length);
      groups.push({ id: OTHER, label: "Other", summary: "Not part of any group", paths: others });
    }
    return { groups, counts };
  }, [grouping, graph, visible]);

  /* ------------------------------ navigation ------------------------------ */

  const record = (s: Stop) => {
    history.current.push(s);
    if (history.current.length > 80) history.current.shift();
  };

  // Direct neighbours in the import graph, for lighting up where you can go next.
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of graph?.imports ?? []) {
      if (!m.has(e.from)) m.set(e.from, new Set());
      if (!m.has(e.to)) m.set(e.to, new Set());
      m.get(e.from)!.add(e.to);
      m.get(e.to)!.add(e.from);
    }
    return m;
  }, [graph]);

  const openFile = useCallback(
    (path: string, line?: number, endLine?: number, fly = true) => {
      setIntroDone(true);
      setTour(null);
      setFile({ path, line, endLine });
      panels.current.file = true;
      // The open file and its neighbourhood stay lit, with the import routes
      // between them flowing — the ways out of here are always visible.
      setEmphasis([path, ...(neighbours.get(path) ?? [])]);
      setFocusLabel(path.split("/").pop());
      if (fly) space.current?.flyTo(path, shiftFor(panels.current));
      record({ kind: "file", path, line, endLine });
    },
    [neighbours],
  );

  const focus = useCallback((paths: string[], label?: string) => {
    setIntroDone(true);
    setEmphasis(paths);
    setFocusLabel(label);
    space.current?.focus(paths, shiftFor(panels.current));
    record({ kind: "focus", paths, label });
  }, []);

  const showFrame = useCallback(
    (id: string) => {
      setIntroDone(true);
      setTour(null);
      setFrameId(id);
      panels.current.frame = true;
      setPointer(null);
      const f = frames.find((x) => x.id === id);
      if (f?.focus.length) {
        setEmphasis(f.focus);
        setFocusLabel(f.title);
        space.current?.focus(f.focus, shiftFor(panels.current));
      }
      record({ kind: "frame", frameId: id });
    },
    [frames],
  );

  /** Back to what you had selected — the open file, else the focus, else everything. */
  const recenter = useCallback(() => {
    const shift = shiftFor(panels.current);
    if (file) space.current?.flyTo(file.path, shift);
    else if (emphasis.length) space.current?.focus(emphasis, shift);
    else space.current?.overview();
  }, [file, emphasis]);

  const toOverview = useCallback(() => {
    setTour(null);
    setFile(null);
    setFrameId(null);
    setEmphasis([]);
    setFocusLabel(undefined);
    setPointer(null);
    space.current?.overview();
    record({ kind: "overview" });
  }, []);

  const back = useCallback(() => {
    history.current.pop(); // where we are now
    const prev = history.current.pop();
    if (!prev || prev.kind === "overview") return toOverview();
    if (prev.kind === "file") openFile(prev.path, prev.line, prev.endLine);
    else if (prev.kind === "focus") focus(prev.paths, prev.label);
    else showFrame(prev.frameId);
  }, [toOverview, openFile, focus, showFrame]);

  // A beacon is a module in folder view and a group under a lens; either way,
  // focusing it means flying to its files.
  const focusModule = useCallback(
    (id: string) => {
      const m = legend?.groups.find((x) => x.id === id) ?? overview?.modules.find((x) => x.id === id);
      if (m) focus(visible ? m.paths.filter((p) => visible.has(p)) : m.paths, m.label);
    },
    [overview, legend, visible, focus],
  );

  useEffect(() => {
    panels.current = { file: !!file, frame: !!frameId };
  }, [file, frameId]);

  /* -------------------------------- asking -------------------------------- */

  const screen: ScreenContext = useMemo(
    () => ({
      openFile: file ? { path: file.path, line: file.line } : undefined,
      frameId: frameId ?? undefined,
      focusLabel,
      selection: selection || undefined,
      touring: tour !== null,
      lens: lensTitle,
      filter: isActive(filter) ? describe(filter) : undefined,
      visibleFiles: visible?.size,
    }),
    [file, frameId, focusLabel, selection, tour, lensTitle, filter, visible],
  );

  const askNavigator = useCallback(
    (request: string, topicId?: string) => {
      setIntroDone(true);
      setTour(null);
      void ask(request, { topicId, screen });
    },
    [screen],
  );

  const goTopic = useCallback(
    (t: Topic) => {
      focus(t.paths, t.title);
      askNavigator(t.title, t.id);
    },
    [focus, askNavigator],
  );

  // A frame born after this page loaded is the answer to something just
  // asked: open it. Frames restored from an earlier session are older than the
  // page, so they never pop open on their own. (Counting frames instead broke
  // whenever the first stream update after a reset already carried the new one.)
  const loadedAt = useRef(Date.now());
  const opened = useRef(new Set<string>());
  useEffect(() => {
    const fresh = frames.filter((f) => f.createdAt >= loadedAt.current && !opened.current.has(f.id));
    if (!fresh.length) return;
    for (const f of fresh) opened.current.add(f.id);
    const f = fresh.at(-1)!;
    setFrameId(f.id);
    panels.current.frame = true;
    setPointer(null);
    record({ kind: "frame", frameId: f.id });
  }, [frames]);

  /* ------------------------------- commands ------------------------------- */

  const run = useCallback(
    (c: UiCommand) => {
      switch (c.cmd) {
        case "fly_to":
          return openFile(c.path);
        case "open_file":
          return openFile(c.path, c.line, c.endLine, false);
        case "focus":
          return focus(c.paths, c.label);
        case "focus_module":
          return focusModule(c.moduleId);
        case "overview":
          return toOverview();
        case "back":
          return back();
        case "show_frame":
          return showFrame(c.frameId);
        case "highlight":
          return setPointer({ viewId: c.viewId, nodeIds: c.nodeIds, lines: c.lines });
        case "clear_highlight":
          return setPointer(null);
        case "set_layer":
          return setLayers((l) => ({ ...l, [c.layer]: c.on }));
        case "start_tour":
          setIntroDone(true);
          return setTour(0);
        case "close_panel":
          setFile(null);
          return setFrameId(null);
        case "filter":
          // A navigator filter replaces the old one; it names what it shows.
          return setFilter({ ...EMPTY_FILTER, ...c.filter });
        case "clear_filter":
          return setFilter(EMPTY_FILTER);
        case "set_lens":
          setTour(null);
          return setLensId(c.lensId);
      }
    },
    [openFile, focus, focusModule, toOverview, back, showFrame],
  );
  const runRef = useRef(run);
  runRef.current = run;

  // The navigator's commands ride the session stream. Replay only what is new
  // since this page loaded — never an old session's camera moves.
  const lastCmd = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const cmds = state.commands;
    if (lastCmd.current === null) {
      lastCmd.current = cmds.at(-1)?.id ?? 0;
      return;
    }
    for (const c of cmds) {
      if (c.id > lastCmd.current) {
        lastCmd.current = c.id;
        runRef.current(c.cmd);
      }
    }
  }, [state]);

  // Files light up in the space as the navigator reads them.
  const lastAct = useRef(Date.now());
  useEffect(() => {
    for (const a of state?.activity ?? []) {
      if (a.at > lastAct.current) {
        lastAct.current = a.at;
        if (a.path) space.current?.pulse(a.path);
      }
    }
  }, [state?.activity]);

  const voice = useVoice({ screen, onCommand: (c) => runRef.current(c) });
  // Talking to the navigator means you're past the intro: the voice opens with
  // the welcome itself, so the title card would only sit on top of the map.
  const startVoice = useCallback(() => {
    setIntroDone(true);
    void voice.start();
  }, [voice]);

  /* ---------------------------- per-repo view ----------------------------- */

  // Your view of each repo — knobs, layers, organization, filter — is saved
  // with the repo and restored when it opens. Saving only starts once this
  // repo's view has been restored, so defaults never overwrite a saved view.
  const viewFor = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const root = graph?.root;
    if (!root || viewFor.current !== root) return;
    saveTuning(tuning); // also the starting point for repos with no saved view yet
    const view: ViewSettings = { tuning, layers, lensId, filter };
    const t = setTimeout(() => void post("/api/view", { view }), 600);
    return () => clearTimeout(t);
  }, [graph?.root, tuning, layers, lensId, filter]);

  /* ------------------------------ repo changes ----------------------------- */

  // Each newly opened repo falls in from deep space.
  const warped = useRef<string | null>(null);
  useEffect(() => {
    if (!graph || warped.current === graph.root) return;
    warped.current = graph.root;
    rememberRepo(graph.root);
    clearFileCache();
    history.current = [];
    setFile(null);
    setFrameId(null);
    setEmphasis([]);
    setIntroDone(false);
    setTour(null);
    // Restore this repo's saved view; a repo without one keeps the knobs you
    // were last using rather than resetting them.
    const saved = stateRef.current?.view;
    if (saved) {
      if (saved.tuning) setTuning({ ...DEFAULT_TUNING, ...(saved.tuning as Partial<Tuning>) });
      setLayers({ ...DEFAULT_LAYERS, ...(saved.layers ?? {}) });
      const known = saved.lensId === "folders" || saved.lensId === "modules" || stateRef.current?.lenses.some((l) => l.id === saved.lensId);
      setLensId(saved.lensId && known ? saved.lensId : "folders");
      setFilter({ ...EMPTY_FILTER, ...(saved.filter ?? {}) });
    } else {
      setLayers(DEFAULT_LAYERS);
      setFilter(EMPTY_FILTER);
      setLensId("folders");
    }
    viewFor.current = graph.root;
    const t = setTimeout(() => space.current?.warp(), 120);
    return () => clearTimeout(t);
  }, [graph]);

  /* --------------------------------- tour --------------------------------- */

  const modules = overview?.modules ?? [];
  useEffect(() => {
    if (tour === null) return;
    const m = modules[tour];
    if (!m) {
      setTour(null);
      toOverview();
      return;
    }
    setFile(null);
    setFrameId(null);
    setEmphasis(m.paths);
    setFocusLabel(m.label);
    space.current?.focus(m.paths);
    const t = setTimeout(() => setTour((i) => (i === null ? null : i + 1)), TOUR_STEP_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour]);

  /* ------------------------------- selection ------------------------------- */

  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const text = sel?.toString().trim() ?? "";
      const anchor = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
      // Only what is selected inside the panels is context; the ask box isn't.
      setSelection(text && anchor?.closest("aside") ? text.slice(0, 2000) : "");
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  /* ------------------------------- keyboard -------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        askInput.current?.focus();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (tour !== null) setTour(null);
        else if (pointer) setPointer(null);
        else if (frameId) setFrameId(null);
        else if (file) setFile(null);
        else if (emphasis.length) {
          setEmphasis([]);
          setFocusLabel(undefined);
        } else setIntroDone(true);
      } else if (e.key === " " || e.code === "Space") {
        // Space recenters even if a button has focus — it shouldn't also press it.
        e.preventDefault();
        if (e.target instanceof HTMLElement) e.target.blur();
        recenter();
      } else if (e.key === "o") toOverview();
      else if (e.key === "[" || e.key === "Backspace") back();
      else if (e.key === "i") setLayers((l) => ({ ...l, imports: !l.imports }));
      else if (e.key === "l") setLayers((l) => ({ ...l, logical: !l.logical }));
      else if (e.key === "t" && overview) setTour(0);
      else if (e.key === "f") openPanel(filterOpen ? null : "filter");
      else if (e.key === "g") openPanel(groupsOpen ? null : "groups");
      else if (e.key === ",") setTuneOpen((o) => !o);
      else if (e.key === "v" && voiceAvailable) {
        if (voice.state === "idle" || voice.state === "error") startVoice();
        else voice.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openPanel only calls setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, pointer, frameId, file, emphasis, overview, voiceAvailable, voice, toOverview, back, filterOpen, groupsOpen, recenter, startVoice]);

  /* -------------------------------- render -------------------------------- */

  if (!state) return <div className="h-full bg-night" />;

  if (status === "idle" || (!graph && status === "error")) {
    return (
      <div className="relative h-full bg-night">
        <Landing onOpen={(p) => void post("/api/open", { path: p })} error={state.error} />
      </div>
    );
  }

  const onJump = (j: Jump) => {
    if (j.kind === "file") openFile(j.path);
    else if (j.kind === "symbol") openFile(j.path, j.line);
    else if (j.kind === "module") focusModule(j.id);
    else {
      const t = overview?.topics.find((x) => x.id === j.id);
      if (t) goTopic(t);
    }
  };

  const activeFrame = frames.find((f) => f.id === frameId);
  const showIntro = !introDone && tour === null && !file && !frameId;
  const showDestinations = introDone && tour === null && !file && !frameId && !emphasis.length && !!overview?.topics.length;

  return (
    <div className="relative h-full overflow-hidden bg-night">
      {graph && fontsReady && (
        <Space
          ref={space}
          graph={graph}
          overview={overview}
          grouping={grouping}
          overlays={shownOverlays}
          tuning={tuning}
          visible={visible}
          layers={layers}
          emphasis={emphasis}
          active={file?.path ?? null}
          onPick={(p) => openFile(p)}
          onPickModule={focusModule}
          onPickOverlay={(id) => {
            const g = overlays.find((o) => o.id === id);
            if (g) focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label);
          }}
          onPickDir={(d) => focus(graph.files.filter((f) => f.path.startsWith(`${d}/`)).map((f) => f.path), `${d}/`)}
          onBackground={() => setPointer(null)}
        />
      )}

      {showIntro && <Intro state={state} graph={graph} onTour={() => (setIntroDone(true), setTour(0))} onExplore={() => setIntroDone(true)} />}

      {/* Instruments */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2">
        {!showIntro && (
          <div className="pointer-events-auto">
            <button onClick={toOverview} className="text-left" title="Back to the whole map (o)">
              <span className="font-cond text-[24px] font-semibold leading-none">{state.repo?.name}</span>
              {state.repo?.branch && <span className="ml-2 font-mono text-[11.5px] text-muted">{state.repo.branch}</span>}
            </button>
          </div>
        )}
        <div className="pointer-events-auto flex flex-wrap gap-1.5">
          <Toggle on={layers.imports} tone="static" onClick={() => setLayers((l) => ({ ...l, imports: !l.imports }))} hint="i">
            Imports
          </Toggle>
          <Toggle on={layers.logical} tone="runtime" onClick={() => setLayers((l) => ({ ...l, logical: !l.logical }))} hint="l" disabled={!overview}>
            Runtime
          </Toggle>
          <Toggle on={layers.labels} tone="muted" onClick={() => setLayers((l) => ({ ...l, labels: !l.labels }))}>
            Labels
          </Toggle>
        </div>
        {!showIntro && (
          <div className="pointer-events-auto flex flex-wrap gap-1.5 text-[13px]">
            <Btn onClick={recenter} hint="Space">Recenter</Btn>
            <Btn onClick={toOverview} hint="o">Overview</Btn>
            <Btn onClick={back} hint="[">Back</Btn>
            {overview && <Btn onClick={() => setTour(0)} hint="t">Tour</Btn>}
            {frames.length > 0 && !frameId && (
              <Btn onClick={() => showFrame(frames.at(-1)!.id)}>Answers ({frames.length})</Btn>
            )}
            {status === "error" && (
              <Btn onClick={() => void post("/api/reanalyze")}>Chart again</Btn>
            )}
          </div>
        )}
        {!showIntro && graph && (
          <OrganizeBar
            lensId={lensId}
            lenses={lenses}
            hasModules={!!overview?.modules.length}
            busy={state.busy}
            onPick={(id) => {
              setTour(null);
              setLensId(id);
            }}
            onRequest={(how) =>
              askNavigator(`Regroup the map ${/^(by|around|into)\b/i.test(how) ? how : `by ${how}`}. Publish the grouping with set_lens, then tell me what the clusters show.`)
            }
          />
        )}
        {!showIntro && graph && (
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => openPanel(filterOpen ? null : "filter")}
              aria-expanded={filterOpen}
              title="Filter the map (f)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${isActive(filter) ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Filter
            </button>
            <button
              onClick={() => openPanel(groupsOpen ? null : "groups")}
              aria-expanded={groupsOpen}
              title="Mark groups on the map (g)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${groupsOpen ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Groups{overlays.length ? ` (${overlays.length})` : ""}
            </button>
            <button
              onClick={() => setTuneOpen((o) => !o)}
              aria-expanded={tuneOpen}
              title="Tune the map (,)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${tuneOpen ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Tune
            </button>
            {visible && (
              <span className="glass rounded-md px-2.5 py-0.5 text-[12.5px]">
                {visible.size.toLocaleString()} of {graph.files.length.toLocaleString()} files · {describe(filter)}
                <button onClick={() => setFilter(EMPTY_FILTER)} className="ml-2 text-muted hover:text-course">
                  Clear
                </button>
              </span>
            )}
          </div>
        )}
        {filterOpen && graph && (
          <FilterPanel graph={graph} filter={filter} onChange={setFilter} onClose={() => setFilterOpen(false)} />
        )}
        {groupsOpen && graph && (
          <GroupsPanel
            overlays={overlays}
            focusCount={emphasis.length}
            focusLabel={focusLabel}
            filterCount={visible?.size ?? null}
            busy={state.busy}
            onCreate={({ label, from, pattern }) =>
              void post("/api/overlays", {
                action: "add",
                label,
                ...(from === "focus" ? { paths: emphasis } : from === "filter" ? { paths: [...(visible ?? [])] } : { include: pattern!.split(",").map((x) => x.trim()).filter(Boolean) }),
              })
            }
            onAskNavigator={(what) =>
              askNavigator(`Mark on the map, without reorganizing it: ${what}. Use add_groups, then tell me what you marked and why.`)
            }
            onToggle={(id, v) => void post("/api/overlays", { action: "update", id, visible: v })}
            onRemove={(id) => void post("/api/overlays", { action: "delete", id })}
            onFly={(g) => focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label)}
            onClose={() => setGroupsOpen(false)}
          />
        )}
        {!showIntro && !filterOpen && !groupsOpen && legend && !file && <Legend groups={legend.groups} counts={legend.counts} onPick={(g) => focusModule(g.id)} />}
        {state.stale && (
          <p className="glass pointer-events-auto max-w-[340px] rounded-md px-3 py-1.5 text-[12.5px] text-text/90">
            The code has changed since this map was charted. Your groupings, groups and answers are kept.{" "}
            <button onClick={() => void post("/api/reanalyze")} disabled={state.busy} className="text-course underline-offset-2 hover:underline disabled:opacity-50">
              Re-chart the overview
            </button>
          </p>
        )}
        {status === "error" && state.error && (
          <p className="glass pointer-events-auto max-w-[340px] rounded-md px-3 py-2 text-[12.5px] text-bad">
            The navigator couldn’t chart this repo: {state.error}. The map still works.
          </p>
        )}
      </div>

      {focusLabel && emphasis.length > 0 && tour === null && (
        <div className="pointer-events-none absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center">
          <button
            onClick={() => {
              setEmphasis([]);
              setFocusLabel(undefined);
            }}
            className="glass pointer-events-auto rounded-full px-3.5 py-1 text-[13px]"
            title="Clear focus (Esc)"
          >
            <span className="text-course">●</span> {focusLabel} <span className="ml-1 text-muted">{emphasis.length} files · clear</span>
          </button>
          <button
            onClick={() => openPanel("groups")}
            className="glass pointer-events-auto ml-1.5 rounded-full px-3 py-1 text-[13px] text-muted hover:text-text"
            title="Keep these files as a marked group"
          >
            Save as group
          </button>
        </div>
      )}

      {/* Panels */}
      {file && (
        <div className="pointer-events-none absolute bottom-28 left-4 top-28 z-20 w-[min(600px,calc(100%-2rem))] md:w-[min(600px,44vw)]">
          <FilePanel
            path={file.path}
            line={file.line}
            endLine={file.endLine}
            onClose={() => setFile(null)}
            onNavigate={(p, l) => openFile(p, l)}
            onAsk={(r) => askNavigator(r)}
          />
        </div>
      )}
      {activeFrame && (
        <div className="pointer-events-none absolute bottom-28 right-4 top-4 z-20 w-[min(640px,calc(100%-2rem))] md:w-[min(640px,46vw)]">
          <Dossier
            frames={frames}
            frameId={activeFrame.id}
            pointer={pointer}
            activity={state.activity}
            onSelect={showFrame}
            onClose={() => setFrameId(null)}
            onOpenFile={(p, l, e) => openFile(p, l, e)}
            onRetry={(f: Frame) => askNavigator(f.request || f.title, f.topicId)}
          />
        </div>
      )}

      {tuneOpen && (
        <div className="pointer-events-none absolute bottom-28 right-4 top-4 z-40 w-[min(360px,calc(100%-2rem))]">
          <TuningPanel tuning={tuning} onChange={setTuning} onRelayout={() => space.current?.relayout()} onClose={() => setTuneOpen(false)} />
        </div>
      )}

      {/* Bottom deck */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3 px-4 pb-4">
        {tour !== null && modules[tour] && (
          <TourCaption
            module={modules[tour]}
            index={tour}
            total={modules.length}
            onNext={() => setTour((i) => (i === null ? null : i + 1))}
            onStop={() => setTour(null)}
          />
        )}
        {showDestinations && <Destinations topics={overview!.topics} onPick={goTopic} />}
        <div className="flex w-full items-end justify-between gap-4">
          <div className="hidden min-w-0 flex-1 md:block">
            <ActivityTicker activity={state.activity} busy={state.busy} />
          </div>
          <CommandBar
            inputRef={askInput}
            graph={graph}
            overview={overview}
            busy={state.busy}
            onAsk={(t) => askNavigator(t)}
            onJump={onJump}
            onStop={() => void post("/api/interrupt")}
          />
          <div className="flex min-w-0 flex-1 justify-end">
            <VoiceDock
              available={voiceAvailable}
              state={voice.state}
              error={voice.error}
              caption={voice.caption}
              heard={voice.heard}
              turns={voice.turns}
              onStart={startVoice}
              onStop={voice.stop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  on,
  tone,
  onClick,
  hint,
  disabled,
  children,
}: {
  on: boolean;
  tone: "static" | "runtime" | "muted";
  onClick: () => void;
  hint?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const dot = tone === "static" ? "bg-static" : tone === "runtime" ? "bg-runtime" : "bg-muted";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={hint ? `Toggle (${hint})` : undefined}
      className={`glass flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12.5px] disabled:opacity-40 ${on ? "text-text" : "text-muted"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${on ? "" : "opacity-30"}`} />
      {children}
    </button>
  );
}

function Btn({ onClick, hint, children }: { onClick: () => void; hint?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={hint ? `${children} (${hint})` : undefined} className="glass rounded-md px-2.5 py-0.5 text-muted hover:text-text">
      {children}
    </button>
  );
}
