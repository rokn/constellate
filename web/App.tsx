import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Commit, Frame, Isolated, Layer, LogicalModule, MapFilter, Note, NoteTarget, RepoGraph, SavedFilter, ScreenContext, TimeRange, Topic, UiCommand, ViewSettings } from "../shared/types";
import { commitsIn, couplingsOf, describeRange, heatOf, mapAcross, relevantPaths, resolveSpan, useGraphsAt, useHistory, type Span } from "./lib/history";
import { CommitList } from "./components/CommitList";
import { NoteEditor, NotesPanel, describeTarget } from "./components/Notes";
import { ChartChanges } from "./components/ChartChanges";
import { AnswersPanel } from "./components/AnswersPanel";
import { EMPTY_FILTER, applyFilter, describe, isActive } from "../shared/filter";
import { ask, clearFileCache, config, post, useGraph, useSession } from "./lib/api";
import { useVoice } from "./lib/useVoice";
import { territoryColors } from "./lib/colors";
import { Space, type Grouping, type Overlay, type SpaceHandle } from "./components/Space";
import { FilterPanel, GroupsPanel, Legend, OTHER, OrganizeBar } from "./components/MapControls";
import { TuningPanel } from "./components/TuningPanel";
import { DEFAULT_TUNING, loadTuning, saveTuning, type Tuning } from "./lib/tuning";
import { Dossier, type Pointer } from "./components/Dossier";
import { FilePanel } from "./components/FilePanel";
import { CommandBar, type Jump } from "./components/CommandBar";
import { ActivityTicker, Destinations, Intro, Landing, TourCaption, VoiceDock, rememberRepo } from "./components/Overlays";
import { StoryPlayer } from "./components/StoryPlayer";
import { StoriesPanel } from "./components/StoriesPanel";

const DEFAULT_LAYERS: Record<Layer, boolean> = { imports: false, logical: true, labels: true, folders: true, beacons: true, notes: true };

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
  /** Inworld TTS is configured: stories are voiced, not just captioned. */
  const [ttsAvailable, setTtsAvailable] = useState(false);
  // gopls on the server: Go files then open in VS Code's editor with real navigation.
  const [goplsReady, setGoplsReady] = useState(false);
  useEffect(() => {
    void fetch("/api/lsp/status")
      .then((r) => r.json())
      .then((s: { go?: { available?: boolean } }) => setGoplsReady(!!s.go?.available))
      .catch(() => setGoplsReady(false));
  }, [state?.repo?.root]);
  useEffect(
    () =>
      void config()
        .then((c) => {
          setVoiceAvailable(c.voice);
          setTtsAvailable(c.tts);
        })
        .catch(() => {}),
    [],
  );

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
  /** A short-lived note with an undo — after hiding something. */
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const [filter, setFilter] = useState<MapFilter>(EMPTY_FILTER);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  /** The saved view the current filter is, if any. */
  const activeView = useMemo(() => {
    const key = (f: MapFilter) => JSON.stringify({ ...EMPTY_FILTER, ...f });
    return savedFilters.find((v) => key(v.filter) === key(filter))?.name;
  }, [savedFilters, filter]);
  const [filterOpen, setFilterOpen] = useState(false);
  /** "folders", "modules", or the id of a lens the navigator wrote. */
  const [lensId, setLensId] = useState("folders");
  // Knobs start from the last values used in this browser, then each repo's
  // own saved view replaces them when it opens (see the repo-change effect).
  const [tuning, setTuning] = useState<Tuning>(loadTuning);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [storiesOpen, setStoriesOpen] = useState(false);
  const [answersOpen, setAnswersOpen] = useState(false);
  /** The story playing, the playlist it's in, and whether to start on its own. */
  const [story, setStory] = useState<{ id: string; queue: string[]; autoplay: boolean } | null>(null);
  /** The "what changed since the chart" list under the re-chart prompt. */
  const [changesOpen, setChangesOpen] = useState(false);
  /** The note being written or edited, and what it's pinned to. */
  const [noteEdit, setNoteEdit] = useState<{ target: NoteTarget; note?: Note } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [coupling, setCoupling] = useState(false);
  /** Stepping forward through the commits on its own. */
  const [playing, setPlaying] = useState(false);
  /** Fly to what each selected commit changed. */
  const [follow, setFollow] = useState(true);
  /** List commits that only touch filtered-out files too. */
  const [allCommits, setAllCommits] = useState(false);
  /** Where a Shift-selection started, and where its moving end is. */
  const anchor = useRef<string | null>(null);
  /** Opening one left-hand panel closes the other; they share the column. */
  const openPanel = (which: "filter" | "groups" | "notes" | "stories" | "answers" | null) => {
    setFilterOpen(which === "filter");
    setGroupsOpen(which === "groups");
    setNotesOpen(which === "notes");
    setStoriesOpen(which === "stories");
    setAnswersOpen(which === "answers");
  };
  /**
   * Where you've been, browser-style: `at` is where you are now; back and
   * forward move it, and going somewhere new drops anything ahead of it.
   */
  const history = useRef<{ stops: Stop[]; at: number }>({ stops: [], at: -1 });
  /** Set while back/forward re-applies a stop, so the move isn't recorded as new. */
  const traveling = useRef(false);

  /**
   * Where the camera should put its subject, given the panels about to be
   * open: right of centre past the code panel, left of centre clear of the
   * dossier, centred between both. Read from a ref because the panel state a
   * flight is for is usually being set in the same handler.
   */
  const panels = useRef({ file: false, frame: false });
  // How far to slide the subject right of a docked code panel grows with
  // the panel: a wide panel covers more of the map. (0.32 at the old 600px.)
  const shiftFor = (p: { file: boolean; frame: boolean }) =>
    p.file && !p.frame
      ? Math.min(0.6, (panelWidthRef.current / window.innerWidth) * 0.76)
      : p.frame && !p.file
        ? -Math.min(0.6, (dossierWidthRef.current / window.innerWidth) * 0.68)
        : 0;

  /* ----------------------------- panel size ------------------------------ */

  const PANEL_KEY = "codeflight.panelWidth";
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(PANEL_KEY)) || 600;
    } catch {
      return 600;
    }
  });
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;
  /** The code panel filling the window. */
  const [panelFull, setPanelFull] = useState(false);

  /**
   * Hide UI: just the map, the search bar and the voice button. Code and
   * answers still open in their panels. Remembered in this browser.
   */
  const [minimal, setMinimal] = useState(() => {
    try {
      return localStorage.getItem("codeflight.minimal") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("codeflight.minimal", minimal ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [minimal]);

  /** Drag the panel's right edge to resize it; the width is remembered in this browser. */
  const DOSSIER_KEY = "codeflight.dossierWidth";
  const [dossierWidth, setDossierWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(DOSSIER_KEY)) || 640;
    } catch {
      return 640;
    }
  });
  const dossierWidthRef = useRef(dossierWidth);
  dossierWidthRef.current = dossierWidth;

  /**
   * Drag a panel's inner edge to resize it — the code panel docks left (its
   * right edge moves), the answer panel docks right (its left edge moves).
   * Widths are remembered in this browser.
   */
  const startResize = (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const [ref, set, key] = side === "left" ? [panelWidthRef, setPanelWidth, PANEL_KEY] : [dossierWidthRef, setDossierWidth, DOSSIER_KEY];
    let last = ref.current;
    const move = (ev: PointerEvent) => {
      const raw = side === "left" ? ev.clientX - 16 : window.innerWidth - ev.clientX - 16;
      last = Math.round(Math.max(360, Math.min(window.innerWidth - 160, raw)));
      set(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      // The last move, not the last render: React may not have caught up yet.
      try {
        localStorage.setItem(key, String(last));
      } catch {
        /* private mode */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const frames = useMemo(() => state?.frames ?? [], [state?.frames]);
  const overview = state?.overview;
  const lenses = useMemo(() => state?.lenses ?? [], [state?.lenses]);
  const overlays = useMemo(() => state?.overlays ?? [], [state?.overlays]);
  const notes = useMemo(() => state?.notes ?? [], [state?.notes]);
  const shownOverlays: Overlay[] = useMemo(
    () =>
      overlays
        .filter((o) => o.visible)
        .map((o) => ({ id: o.id, label: o.label, paths: o.paths, color: o.color, reasons: o.reasons, summary: o.summary, by: o.createdBy })),
    [overlays],
  );

  /* -------------------------------- history -------------------------------- */

  const gitHistory = useHistory(historyOpen || !!range, state?.graphVersion);
  const rangeCommits = useMemo(() => (gitHistory && range ? commitsIn(gitHistory, range) : []), [gitHistory, range]);
  const heat = useMemo(() => (range ? heatOf(rangeCommits) : null), [range, rangeCommits]);

  // The commit list: only commits that touch something the filter shows.
  const relevant = useMemo(() => (gitHistory && graph ? relevantPaths(gitHistory, graph, filter) : null), [gitHistory, graph, filter]);
  const listed = useMemo(
    () => (!gitHistory ? [] : allCommits || !relevant ? gitHistory.commits : gitHistory.commits.filter((c) => c.files.some((f) => relevant.has(f.path)))),
    [gitHistory, relevant, allCommits],
  );

  // The map at the selection: built from the newest selected commit, compared
  // with the map just before the oldest. Uncommitted work is the live map,
  // compared with HEAD. The neighbours in the list load ahead, so stepping
  // with the arrows doesn't wait.
  const newest = rangeCommits[0];
  const oldest = rangeCommits.at(-1);
  const headSha = gitHistory?.commits.find((c) => !c.worktree)?.sha;
  const atSha = newest && !newest.worktree ? newest.sha : null;
  const beforeSha = oldest ? (oldest.worktree ? headSha : oldest.parents[0]) : undefined;
  const ahead = useMemo(() => {
    const i = newest ? listed.findIndex((c) => c.sha === newest.sha) : -1;
    if (i < 0) return [];
    return [listed[i - 1], listed[i + 1], listed[i + 2]].filter(Boolean).flatMap((c) => (c.worktree ? [] : [c.sha, c.parents[0]]));
  }, [listed, newest]);
  const maps = useGraphsAt([atSha, beforeSha, ...ahead]);
  const timeMap = useMemo(() => {
    if (!newest) return null;
    const after = newest.worktree ? graph : maps.get(atSha!);
    // A root commit has nothing before it.
    const before = beforeSha ? maps.get(beforeSha) : null;
    if (!after || before === undefined) return null;
    return mapAcross(after, before);
  }, [newest, graph, maps, atSha, beforeSha]);
  // While the next commit's map loads, the last one stays up rather than
  // flashing back to the present.
  const lastTimeMap = useRef<typeof timeMap>(null);
  if (!range) lastTimeMap.current = null;
  else if (timeMap) lastTimeMap.current = timeMap;
  const shownTime = range ? (timeMap ?? lastTimeMap.current) : null;
  const mapGraph = shownTime?.graph ?? graph;

  const onMap = useMemo(() => new Set(mapGraph?.files.map((f) => f.path) ?? []), [mapGraph]);
  const couplings = useMemo(
    () => (coupling && gitHistory ? couplingsOf(range ? rangeCommits : gitHistory.commits, onMap) : []),
    [coupling, gitHistory, range, rangeCommits, onMap],
  );

  /* ------------------------------ map shape ------------------------------- */

  const visible = useMemo(() => (mapGraph ? applyFilter(mapGraph.files, filter) : null), [mapGraph, filter]);

  const grouping: Grouping | null = useMemo(() => {
    if (lensId === "modules" && overview) return { key: "modules", groups: overview.modules, edges: overview.edges };
    const lens = lenses.find((l) => l.id === lensId);
    return lens ? { key: lens.id, groups: lens.groups, edges: lens.edges } : null;
  }, [lensId, overview, lenses]);
  // The grouping on screen was deleted (by you or the navigator): back to folders.
  useEffect(() => {
    if (lensId !== "folders" && lensId !== "modules" && graph && !lenses.some((l) => l.id === lensId)) setLensId("folders");
  }, [lensId, lenses, graph]);
  const lensTitle = lensId === "folders" ? "folders" : lensId === "modules" ? "modules" : lenses.find((l) => l.id === lensId)?.title;

  // The legend: each group with how many of the visible files it holds.
  // The legend counts without the isolation, so what you haven't isolated
  // stays listed for adding.
  const unisolated = useMemo(() => (graph ? applyFilter(graph.files, { ...filter, isolate: undefined }) : null), [graph, filter]);
  const legend = useMemo(() => {
    if (!graph) return null;
    if (!grouping) {
      // By folder: the top-level folders, in the map's own colours.
      const counts = new Map<string, number>();
      for (const f of graph.files) if (!unisolated || unisolated.has(f.path)) counts.set(f.top, (counts.get(f.top) ?? 0) + 1);
      const groups: LogicalModule[] = [...counts.keys()]
        .sort((a, b) => counts.get(b)! - counts.get(a)!)
        .map((t) => ({ id: t, label: t === "." ? "files at the root" : `${t}/`, summary: "", paths: [] }));
      const memberOf = new Map(graph.files.map((f) => [f.path, f.top]));
      return { kind: "dir" as const, groups, counts, memberOf, colors: territoryColors(graph.files.map((f) => f.top)) };
    }
    const groupOf = new Map<string, string>();
    for (const g of grouping.groups) for (const p of g.paths) if (!groupOf.has(p)) groupOf.set(p, g.id);
    const counts = new Map<string, number>();
    const others: string[] = [];
    for (const f of graph.files) {
      if (unisolated && !unisolated.has(f.path)) continue;
      const id = groupOf.get(f.path);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      else others.push(f.path);
    }
    const groups: LogicalModule[] = grouping.groups.filter((g) => counts.get(g.id));
    if (others.length) {
      counts.set(OTHER, others.length);
      groups.push({ id: OTHER, label: "Other", summary: "Not part of any group", paths: others });
    }
    const memberOf = new Map(graph.files.map((f) => [f.path, groupOf.get(f.path) ?? OTHER]));
    return { kind: "module" as const, groups, counts, memberOf, colors: undefined };
  }, [grouping, graph, unisolated]);

  /** The legend row you last flew to by clicking it (or its beacon), while that's still the focus. */
  const [pickedRow, setPickedRow] = useState<{ id: string; label: string } | null>(null);
  useEffect(() => {
    if (pickedRow && focusLabel !== pickedRow.label) setPickedRow(null);
  }, [focusLabel, pickedRow]);
  /**
   * For every other legend row, how many import lines run between it and the
   * selected rows (the ones isolated, and the one you clicked) — out of it
   * into them, and into it from them. Counted without the isolation, so hidden
   * rows show how tied they are too.
   */
  const rowLinks = useMemo(() => {
    if (!legend || !graph) return null;
    const selected = new Set([...(filter.isolate ?? []).filter((i) => !i.exclude && i.kind === legend.kind).map((i) => i.id), ...(pickedRow ? [pickedRow.id] : [])]);
    if (!selected.size) return null;
    const links = new Map<string, { out: number; in: number }>();
    const bump = (id: string, k: "out" | "in") => {
      const e = links.get(id) ?? { out: 0, in: 0 };
      e[k]++;
      links.set(id, e);
    };
    for (const e of graph.imports) {
      if (unisolated && (!unisolated.has(e.from) || !unisolated.has(e.to))) continue;
      const a = legend.memberOf.get(e.from);
      const b = legend.memberOf.get(e.to);
      if (!a || !b || a === b) continue;
      if (selected.has(b) && !selected.has(a)) bump(a, "out");
      if (selected.has(a) && !selected.has(b)) bump(b, "in");
    }
    return { selected, links };
  }, [legend, graph, filter.isolate, pickedRow, unisolated]);

  /**
   * Isolate a module or folder (show only it, and the others isolated), or
   * with `exclude` take it out of view. The same action again undoes it;
   * the other one switches it over.
   */
  const toggleIsolate = useCallback((item: Isolated, exclude = false) => {
    setFilter((f) => {
      const cur = f.isolate ?? [];
      const same = (i: Isolated) => i.kind === item.kind && i.id === item.id;
      const was = cur.find(same);
      const rest = cur.filter((i) => !same(i));
      const next = was && !!was.exclude === exclude ? rest : [...rest, { ...item, ...(exclude ? { exclude: true } : {}) }];
      return { ...f, isolate: next.length ? next : undefined };
    });
  }, []);
  /**
   * Show only this module or folder (double-click): it replaces whatever is
   * isolated, keeping what's hidden. Already the only one: show all again.
   */
  /** `focus`, for code above where it's defined. */
  const focusRef = useRef<(paths: string[], label?: string) => void>(() => {});
  const soloIsolate = useCallback((item: Isolated) => {
    // Becoming the only one shown (not undoing it): once the map has
    // regrouped around it, fly there and focus it.
    const ins = (filter.isolate ?? []).filter((i) => !i.exclude);
    const undoing = ins.length === 1 && ins[0].kind === item.kind && ins[0].id === item.id;
    if (!undoing && graph) {
      const paths =
        item.kind === "module"
          ? (item.paths ?? [])
          : graph.files.filter((f) => (item.id === "." ? !f.path.includes("/") : f.path.startsWith(`${item.id}/`))).map((f) => f.path);
      clearTimeout(soloFocus.current);
      // Only what the rest of the filter shows.
      const shown = unisolated ? paths.filter((p) => unisolated.has(p)) : paths;
      soloAt.current = performance.now();
      soloFocus.current = setTimeout(() => focusRef.current(shown, item.label), 120);
    }
    setFilter((f) => {
      const cur = f.isolate ?? [];
      const ins = cur.filter((i) => !i.exclude);
      const outs = cur.filter((i) => i.exclude && !(i.kind === item.kind && i.id === item.id));
      const alone = ins.length === 1 && ins[0].kind === item.kind && ins[0].id === item.id;
      const next = alone ? outs : [...outs, item];
      return { ...f, isolate: next.length ? next : undefined };
    });
  }, [filter.isolate, graph, unisolated]);
  const soloFocus = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** When a double-click last isolated something: it frames itself, so the general re-frame stays out. */
  const soloAt = useRef(0);

  // Isolating or hiding modules changes what's on the map: frame what's left
  // straight away (everything, when the isolation is cleared). The bodies
  // that stay keep their places, so there's no need to wait for the layout.
  const isoKey = JSON.stringify((filter.isolate ?? []).map((i) => `${i.exclude ? "-" : "+"}${i.kind}:${i.id}`));
  const lastIsoKey = useRef(isoKey);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (lastIsoKey.current === isoKey) return;
    lastIsoKey.current = isoKey;
    if (performance.now() - soloAt.current < 1000) return;
    const t = setTimeout(() => {
      const shown = visibleRef.current;
      if (!filter.isolate?.length || !shown) space.current?.overview();
      else if (shown.size) space.current?.focus([...shown], shiftFor(panels.current));
    }, 120);
    return () => clearTimeout(t);
    // Only a change in what's isolated or hidden re-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isoKey]);
  const isolatedIds = useMemo(
    () => new Map((filter.isolate ?? []).filter((i) => i.kind === legend?.kind).map((i) => [i.id, i.exclude ? ("out" as const) : ("in" as const)])),
    [filter, legend?.kind],
  );

  /* ------------------------------ navigation ------------------------------ */

  const record = (s: Stop) => {
    if (traveling.current) return;
    const h = history.current;
    // Re-opening where you already are isn't a new place.
    if (h.at >= 0 && JSON.stringify(h.stops[h.at]) === JSON.stringify(s)) return;
    h.stops = h.stops.slice(0, h.at + 1);
    h.stops.push(s);
    if (h.stops.length > 100) h.stops.shift();
    h.at = h.stops.length - 1;
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
  focusRef.current = focus;

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

  /**
   * Take files off the map. They join the filter's hidden list — saved with
   * the repo, listed in the Filter panel — and anything showing them closes.
   */
  const hide = useCallback(
    (paths: string[], what: string) => {
      const already = new Set(filter.hidden ?? []);
      const add = paths.filter((p) => !already.has(p));
      if (!add.length) return;
      const gone = new Set(add);
      setFilter((f) => ({ ...f, hidden: [...(f.hidden ?? []), ...add] }));
      if (file && gone.has(file.path)) setFile(null);
      const left = emphasis.filter((p) => !gone.has(p));
      setEmphasis(left);
      if (!left.length) setFocusLabel(undefined);
      setToast({
        text: `Hid ${what}`,
        undo: () => setFilter((f) => ({ ...f, hidden: (f.hidden ?? []).filter((p) => !gone.has(p)) })),
      });
    },
    [filter.hidden, file, emphasis],
  );

  /** Back to what you had selected — the open file, else the focus, else everything. */
  /** What Space framed last for the selected file: just it, or it with its connections. */
  const framed = useRef<{ path: string; wide: boolean } | null>(null);
  const recenter = useCallback(() => {
    const shift = shiftFor(panels.current);
    if (file) {
      // Space flips between the file up close and the file with everything
      // it imports or is imported by in view; the first press is the file.
      const wide = framed.current?.path === file.path && !framed.current.wide;
      framed.current = { path: file.path, wide };
      const around = [...(neighbours.get(file.path) ?? [])];
      if (wide && around.length) space.current?.focus([file.path, ...around], shift);
      else space.current?.flyTo(file.path, shift);
    } else if (emphasis.length) space.current?.focus(emphasis, shift);
    else space.current?.overview();
  }, [file, emphasis, neighbours]);

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

  /** Move through the history by `delta` stops and re-apply where that lands. */
  const travel = useCallback(
    (delta: number) => {
      const h = history.current;
      const i = h.at + delta;
      if (i < 0 || i >= h.stops.length) return;
      h.at = i;
      const stop = h.stops[i];
      traveling.current = true;
      try {
        if (stop.kind === "overview") toOverview();
        else if (stop.kind === "file") openFile(stop.path, stop.line, stop.endLine);
        else if (stop.kind === "focus") focus(stop.paths, stop.label);
        else showFrame(stop.frameId);
      } finally {
        traveling.current = false;
      }
    },
    [toOverview, openFile, focus, showFrame],
  );
  const back = useCallback(() => travel(-1), [travel]);
  const forward = useCallback(() => travel(1), [travel]);

  // The mouse's back/forward buttons move through what you've opened. The
  // browser would otherwise take them as "leave this page".
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === "mouseup") (e.button === 3 ? back : forward)();
    };
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("mouseup", onMouse, true);
    return () => {
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("mouseup", onMouse, true);
    };
  }, [back, forward]);

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
    // The story's stage docks where answers do.
    panels.current = { file: !!file, frame: !!frameId || !!story };
  }, [file, frameId, story]);
  useEffect(() => {
    if (!file) setPanelFull(false);
  }, [file]);

  /* -------------------------------- asking -------------------------------- */

  const screen: ScreenContext = useMemo(
    () => ({
      openFile: file ? { path: file.path, line: file.line } : undefined,
      frameId: frameId ?? undefined,
      focusLabel,
      selection: selection || undefined,
      touring: tour !== null,
      lens: lensTitle,
      lensId,
      range: range ? describeRange(range, rangeCommits) : undefined,
      filter: isActive(filter) ? describe(filter) : undefined,
      visibleFiles: visible?.size,
    }),
    [file, frameId, focusLabel, selection, tour, lensTitle, lensId, filter, visible, range, rangeCommits],
  );

  const askNavigator = useCallback(
    (request: string, topicId?: string) => {
      setIntroDone(true);
      setTour(null);
      void ask(request, { topicId, screen });
    },
    [screen],
  );

  /**
   * Show a span of history. `fly` takes the camera to what changed — for a
   * picked commit or a named span; a drag on the timeline only relights the
   * map, so scrubbing doesn't yank the view around.
   */
  const showRange = useCallback((r: TimeRange | null) => {
    setRange(r);
    if (!r) {
      // Back to the present: what the last commit lit goes dark again.
      setPlaying(false);
      anchor.current = null;
      setEmphasis([]);
      setFocusLabel(undefined);
      return;
    }
    anchor.current ??= r.to;
    setHistoryOpen(true);
    setIntroDone(true);
  }, []);

  /** Select a commit, or (extend) widen the selection from the anchor to it. */
  const selectCommit = useCallback(
    (c: Commit, extend = false) => {
      if (!gitHistory) return;
      const label = c.worktree ? "Uncommitted changes" : c.subject;
      if (!extend || !anchor.current) {
        anchor.current = c.sha;
        return showRange({ from: c.sha, to: c.sha, label });
      }
      const order = (sha: string) => gitHistory.commits.findIndex((x) => x.sha === sha);
      const [to, from] = [anchor.current, c.sha].sort((a, b) => order(a) - order(b));
      showRange({ from, to });
    },
    [gitHistory, showRange],
  );
  /** The arrows: +1 an older commit, -1 a newer one. The moving end of a span is the one away from the anchor. */
  const cursor = useRef<string | null>(null);
  const step = useCallback(
    (dir: 1 | -1, extend = false) => {
      if (!listed.length) return;
      const at = cursor.current && range ? listed.findIndex((c) => c.sha === cursor.current) : -1;
      const next = at < 0 ? listed[0] : listed[Math.max(0, Math.min(listed.length - 1, at + dir))];
      cursor.current = next.sha;
      selectCommit(next, extend);
    },
    [listed, range, selectCommit],
  );

  // Follow: once a commit's map is up, fly to what it changed.
  useEffect(() => {
    if (!follow || !range || !timeMap) return;
    // What changed, and what its new and dropped imports connect it to.
    const ends = [...timeMap.delta.addedEdges, ...timeMap.delta.removedEdges].flatMap((k) => k.split(">"));
    const changed = [...new Set([...rangeCommits.flatMap((c) => c.files.map((f) => f.path)), ...ends])].filter((p) => (visible ?? onMap).has(p));
    if (changed.length) focus(changed, range.label ?? "Changed in this span");
    // Only a new selection (or its map arriving) moves the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMap, follow]);

  const showSpan = useCallback(
    (span: Span) => {
      const r = gitHistory ? resolveSpan(gitHistory, span) : null;
      if (r) showRange(r);
    },
    [gitHistory, showRange],
  );

  /** Play from the selection (or a few weeks of commits back) toward the present. */
  const startPlay = useCallback(() => {
    if (playing) return setPlaying(false);
    if (!listed.length) return;
    setTour(null);
    setFrameId(null);
    if (!range || listed.findIndex((c) => c.sha === range.to) <= 0) {
      const from = listed[Math.min(listed.length - 1, 20)];
      cursor.current = from.sha;
      selectCommit(from);
    }
    setPlaying(true);
  }, [playing, listed, range, selectCommit]);

  const goTopic = useCallback(
    (t: Topic) => {
      focus(t.paths, t.title);
      askNavigator(t.title, t.id);
    },
    [focus, askNavigator],
  );

  /* -------------------------------- stories ------------------------------- */

  const stories = useMemo(() => state?.stories ?? [], [state?.stories]);
  const introStories = useMemo(() => stories.filter((s) => s.intro).sort((a, b) => a.intro! - b.intro!), [stories]);

  /** Play a story (in a playlist, for the intro). One voiced with other settings is voiced again first. */
  const playStory = useCallback((id: string, queue: string[] = [], autoplay = true) => {
    setIntroDone(true);
    setTour(null);
    setFrameId(null);
    panels.current.frame = true;
    void post("/api/stories", { action: "voice", id });
    setStory({ id, queue, autoplay });
    // The stage needs the room; Stories is a key (s) away.
    setStoriesOpen(false);
  }, []);
  const playIntro = useCallback(() => {
    const ids = introStories.filter((s) => s.state !== "error").map((s) => s.id);
    if (ids.length) playStory(ids[0], ids);
  }, [introStories, playStory]);

  // A story you just asked for opens as it's being written, and plays once it's voiced.
  const storiesSeen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = stories.filter((s) => !s.intro && s.createdAt >= loadedAt.current && !storiesSeen.current.has(s.id));
    for (const s of fresh) storiesSeen.current.add(s.id);
    if (fresh.length) playStory(fresh.at(-1)!.id);
    // A story that was deleted closes.
    if (story && !stories.some((s) => s.id === story.id)) setStory(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stories]);

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
          // What you hid yourself stays hidden.
          return setFilter((f) => ({ ...EMPTY_FILTER, ...c.filter, hidden: f.hidden }));
        case "clear_filter":
          return setFilter((f) => ({ ...EMPTY_FILTER, hidden: f.hidden }));
        case "set_lens":
          setTour(null);
          return setLensId(c.lensId);
        case "set_range":
          // The voice names spans ("span:week"); the navigator names commits.
          if (c.range.from.startsWith("span:")) {
            setHistoryOpen(true);
            return showSpan(c.range.from.slice(5) as Span);
          }
          cursor.current = c.range.to;
          return showRange(c.range);
        case "clear_range":
          return showRange(null);
        case "replay":
          return startPlay();
      }
    },
    [openFile, focus, focusModule, toOverview, back, showFrame, showRange, showSpan, startPlay],
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
    const view: ViewSettings = { tuning, layers, lensId, filter, savedFilters };
    const t = setTimeout(() => void post("/api/view", { view }), 600);
    return () => clearTimeout(t);
  }, [graph?.root, tuning, layers, lensId, filter, savedFilters]);

  /* ------------------------------ repo changes ----------------------------- */

  // The same repo, rescanned (a pull, deleted files): file contents may have
  // changed too, so the code panel reads them fresh.
  const scannedFor = useRef<RepoGraph | null>(null);
  useEffect(() => {
    if (graph && scannedFor.current && scannedFor.current.root === graph.root) clearFileCache();
    scannedFor.current = graph;
  }, [graph]);

  // Each newly opened repo falls in from deep space.
  const warped = useRef<string | null>(null);
  useEffect(() => {
    if (!graph || warped.current === graph.root) return;
    warped.current = graph.root;
    rememberRepo(graph.root);
    clearFileCache();
    history.current = { stops: [], at: -1 };
    setFile(null);
    setFrameId(null);
    setEmphasis([]);
    setIntroDone(false);
    setTour(null);
    // Restore this repo's saved view; a repo without one keeps the knobs you
    // were last using rather than resetting them.
    const saved = stateRef.current?.view;
    if (saved) {
      if (saved.tuning) {
        const t = { ...DEFAULT_TUNING, ...(saved.tuning as Partial<Tuning>) };
        // 36 was the old default; a saved 36 means "never changed", so it moves to the new one.
        if (t.fileLabelLimit === 36) t.fileLabelLimit = DEFAULT_TUNING.fileLabelLimit;
        setTuning(t);
      }
      setLayers({ ...DEFAULT_LAYERS, ...(saved.layers ?? {}) });
      const known = saved.lensId === "folders" || saved.lensId === "modules" || stateRef.current?.lenses.some((l) => l.id === saved.lensId);
      setLensId(saved.lensId && known ? saved.lensId : "folders");
      setFilter({ ...EMPTY_FILTER, ...(saved.filter ?? {}) });
      setSavedFilters(saved.savedFilters ?? []);
    } else {
      setLayers(DEFAULT_LAYERS);
      setFilter(EMPTY_FILTER);
      setSavedFilters([]);
      setLensId("folders");
    }
    viewFor.current = graph.root;
    const t = setTimeout(() => space.current?.warp(), 120);
    return () => clearTimeout(t);
  }, [graph]);

  /* --------------------------------- play --------------------------------- */

  // One commit at a time toward the present. Each step waits for its map, so
  // playback never outruns what's drawn.
  const PLAY_STEP_MS = 1800;
  useEffect(() => {
    if (!playing || !timeMap) return;
    const at = listed.findIndex((c) => c.sha === range?.to);
    if (at <= 0) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => step(-1), PLAY_STEP_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timeMap]);

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
      // The Go editor reports its own selection; DOM selection inside it is noise.
      if (anchor?.closest(".monaco-editor")) return;
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
        if (panelFull) setPanelFull(false);
        else if (playing) setPlaying(false);
        else if (tour !== null) setTour(null);
        else if (pointer) setPointer(null);
        else if (frameId) setFrameId(null);
        else if (file) setFile(null);
        else if (range) showRange(null);
        else if (emphasis.length) {
          setEmphasis([]);
          setFocusLabel(undefined);
        }
        // Nothing else on screen: the last step back is the whole map again.
        else if (filter.isolate?.length) setFilter((f) => ({ ...f, isolate: undefined }));
        else setIntroDone(true);
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && historyOpen && listed.length) {
        // Down is older, as the list reads.
        e.preventDefault();
        setPlaying(false);
        step(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      } else if (e.key === "n") {
        // A note on the import line under the pointer, else on the open file.
        // (The key press mustn't also land in the editor it opens.)
        e.preventDefault();
        const link = space.current?.hoveredLink();
        if (link) setNoteEdit({ target: { kind: "link", ...link } });
        else if (file) setNoteEdit({ target: { kind: "file", path: file.path } });
        else openPanel("notes");
      } else if (e.key === " " || e.code === "Space") {
        // Space recenters even if a button has focus — it shouldn't also press it.
        e.preventDefault();
        if (e.target instanceof HTMLElement) e.target.blur();
        recenter();
      } else if (e.key === "x") {
        if (file) hide([file.path], file.path.split("/").pop()!);
        else if (emphasis.length) hide(emphasis, `${emphasis.length} file${emphasis.length === 1 ? "" : "s"}`);
      } else if (e.key === "o") toOverview();
      else if (e.key === "[" || e.key === "Backspace") back();
      else if (e.key === "]") forward();
      else if (e.key === "u") setMinimal((m) => !m);
      else if (e.key === "i") setLayers((l) => ({ ...l, imports: !l.imports }));
      else if (e.key === "l") setLayers((l) => ({ ...l, logical: !l.logical }));
      else if (e.key === "t" && overview) setTour(0);
      else if (e.key === "f") openPanel(filterOpen ? null : "filter");
      else if (e.key === "g") openPanel(groupsOpen ? null : "groups");
      else if (e.key === "s") openPanel(storiesOpen ? null : "stories");
      else if (e.key === "a" && frames.length) {
        // The key press mustn't also land in the search box the panel opens with.
        e.preventDefault();
        openPanel(answersOpen ? null : "answers");
      }
      else if (e.key === ",") setTuneOpen((o) => !o);
      else if (e.key === "h") {
        if (historyOpen) showRange(null);
        setHistoryOpen(!historyOpen);
      }
      else if (e.key === "v" && voiceAvailable) {
        if (voice.state === "idle" || voice.state === "error") startVoice();
        else voice.stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openPanel only calls setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, pointer, frameId, file, emphasis, overview, voiceAvailable, voice, toOverview, back, filterOpen, groupsOpen, storiesOpen, answersOpen, frames, recenter, startVoice, hide, forward, panelFull, playing, range, historyOpen, listed, step, showRange, filter]);

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
  const showIntro = !minimal && !introDone && tour === null && !file && !frameId;
  const showDestinations = !minimal && introDone && tour === null && !file && !frameId && !emphasis.length && !!overview?.topics.length;

  return (
    <div className="relative h-full overflow-hidden bg-night">
      {graph && fontsReady && (
        <Space
          ref={space}
          graph={mapGraph!}
          overview={overview}
          grouping={grouping}
          overlays={shownOverlays}
          heat={heat}
          delta={shownTime?.delta ?? null}
          pinned={!!range}
          // The history panel (up to 380px, or 46% of the view) and the bar under it.
          insetBottom={historyOpen ? (Math.min(380, window.innerHeight * 0.46) + 90) / window.innerHeight : 0}
          couplings={couplings}
          tuning={tuning}
          visible={visible}
          layers={layers}
          emphasis={emphasis}
          active={file?.path ?? null}
          onPick={(p) => openFile(p, undefined, undefined, false)}
          notes={notes}
          onPickNote={(id, edit) => {
            const n = notes.find((x) => x.id === id);
            if (!n) return;
            if (edit) return setNoteEdit({ target: n.target, note: n });
            // Go to what it's pinned to: the file, or the importing file at the import.
            const t = n.target;
            if (t.kind === "file") return openFile(t.path);
            const edge = graph?.imports.find((e) => e.from === t.from && e.to === t.to);
            openFile(t.from, edge?.line);
          }}
          onNoteOnLink={(from, to) => setNoteEdit({ target: { kind: "link", from, to } })}
          onPickModule={(id, how) => {
            if (!how) {
              const m = legend?.groups.find((x) => x.id === id);
              if (m) setPickedRow({ id: m.id, label: m.label });
              return focusModule(id);
            }
            if (how === "solo") {
              const m = grouping?.groups.find((x) => x.id === id) ?? overview?.modules.find((x) => x.id === id);
              if (m) soloIsolate({ kind: "module", id: m.id, label: m.label, paths: m.paths });
              return;
            }
            // Shift+click a beacon isolates its module (or group); Alt+click takes it out of view.
            const m = grouping?.groups.find((x) => x.id === id) ?? overview?.modules.find((x) => x.id === id);
            if (!m) return;
            const item: Isolated = { kind: "module", id: m.id, label: m.label, paths: m.paths };
            toggleIsolate(item, how === "exclude");
            // Hiding a whole module is a big change to the map: say so, with a way back.
            const wasHidden = filter.isolate?.some((i) => i.kind === "module" && i.id === m.id && i.exclude);
            if (how === "exclude" && !wasHidden) {
              setToast({ text: `Hid ${m.label} — bring it back from the legend or Filter`, undo: () => toggleIsolate(item, true) });
            }
          }}
          onOpenImport={(from, line) => openFile(from, line)}
          onHideOverlay={(id) => {
            const g = overlays.find((o) => o.id === id);
            void post("/api/overlays", { action: "update", id, visible: false });
            setToast({
              text: `Hid the group ${g?.label ?? ""} — it's still in Groups`,
              undo: () => void post("/api/overlays", { action: "update", id, visible: true }),
            });
          }}
          onPickOverlay={(id) => {
            const g = overlays.find((o) => o.id === id);
            if (g) focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label);
          }}
          onHide={(t) => {
            if ("file" in t) return hide([t.file], t.file.split("/").pop()!);
            const under = graph.files.map((f) => f.path).filter((p) => p.startsWith(`${t.dir}/`) && (!visible || visible.has(p)));
            hide(under, `${t.dir}/ (${under.length} file${under.length === 1 ? "" : "s"})`);
          }}
          onPickDir={(d, how) =>
            how
              ? toggleIsolate({ kind: "dir", id: d, label: d === "." ? "files at the root" : `${d}/` }, how === "exclude")
              : focus(graph.files.filter((f) => f.path.startsWith(`${d}/`)).map((f) => f.path), `${d}/`)
          }
          onBackground={() => setPointer(null)}
        />
      )}

      {noteEdit && (
        <div className="pointer-events-none fixed inset-x-0 top-[132px] z-30 flex justify-center px-4">
          <NoteEditor
            key={noteEdit.note?.id ?? JSON.stringify(noteEdit.target)}
            target={noteEdit.target}
            note={noteEdit.note}
            onSave={(text) => {
              void post("/api/notes", noteEdit.note ? { action: "update", id: noteEdit.note.id, text } : { action: "add", text, target: noteEdit.target });
              setNoteEdit(null);
            }}
            onDelete={
              noteEdit.note
                ? () => {
                    const note = noteEdit.note!;
                    void post("/api/notes", { action: "delete", id: note.id });
                    setNoteEdit(null);
                    setToast({ text: `Deleted the note on ${describeTarget(note.target)}`, undo: () => void post("/api/notes", { action: "restore", note }) });
                  }
                : undefined
            }
            onGo={() => {
              const t = noteEdit.target;
              space.current?.focus(t.kind === "file" ? [t.path] : [t.from, t.to], shiftFor(panels.current));
            }}
            onClose={() => setNoteEdit(null)}
          />
        </div>
      )}

      {showIntro && (
        <Intro
          state={state}
          graph={graph}
          intro={introStories}
          onPlayIntro={playIntro}
          onTour={() => (setIntroDone(true), setTour(0))}
          onExplore={() => setIntroDone(true)}
        />
      )}

      {/* Instruments */}
      <div className={`${minimal ? "hidden " : ""}pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2`}>
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
          <Toggle on={layers.folders} tone="muted" onClick={() => setLayers((l) => ({ ...l, folders: !l.folders }))}>
            Folders
          </Toggle>
          <Toggle on={layers.beacons} tone="runtime" onClick={() => setLayers((l) => ({ ...l, beacons: !l.beacons }))}>
            Beacons
          </Toggle>
          <Toggle on={layers.notes !== false} tone="runtime" onClick={() => setLayers((l) => ({ ...l, notes: l.notes === false }))}>
            Notes
          </Toggle>
        </div>
        {!showIntro && (
          <div className="pointer-events-auto flex flex-wrap gap-1.5 text-[13px]">
            <Btn onClick={recenter} hint="Space">Recenter</Btn>
            <Btn onClick={toOverview} hint="o">Overview</Btn>
            <Btn onClick={back} hint="[ or mouse back">Back</Btn>
            <Btn onClick={forward} hint="] or mouse forward">Forward</Btn>
            {overview && <Btn onClick={() => setTour(0)} hint="t">Tour</Btn>}
            <Btn onClick={() => openPanel(storiesOpen ? null : "stories")} hint="s">
              Stories{stories.length ? ` (${stories.length})` : ""}
            </Btn>
            {frames.length > 0 && !frameId && (
              <Btn onClick={() => openPanel(answersOpen ? null : "answers")} hint="a">
                Answers ({frames.length})
              </Btn>
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
            onRemove={(lens) => {
              void post("/api/lenses", { action: "delete", id: lens.id });
              setToast({ text: `Deleted the grouping ${lens.title}`, undo: () => void post("/api/lenses", { action: "restore", lens }) });
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
              onClick={() => openPanel(notesOpen ? null : "notes")}
              aria-expanded={notesOpen}
              title="Your notes on the map (n writes one on the open file)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${notesOpen ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Notes{notes.length ? ` (${notes.length})` : ""}
            </button>
            <button
              onClick={() => setTuneOpen((o) => !o)}
              aria-expanded={tuneOpen}
              title="Tune the map (,)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${tuneOpen ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Tune
            </button>
            <button
              onClick={() => {
                if (historyOpen) showRange(null);
                setHistoryOpen(!historyOpen);
              }}
              aria-expanded={historyOpen}
              title="History: what changed, when, and what changes together (h)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${historyOpen || range ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              History
            </button>
            {visible && (
              <span className="glass rounded-md px-2.5 py-0.5 text-[12.5px]">
                {activeView && <b className="mr-1.5 font-semibold text-course">{activeView}</b>}
                {visible.size.toLocaleString("en-US")} of {graph.files.length.toLocaleString("en-US")} files · {describe(filter)}
                <button onClick={() => setFilter(EMPTY_FILTER)} className="ml-2 text-muted hover:text-course">
                  Clear
                </button>
              </span>
            )}
          </div>
        )}
        {filterOpen && graph && (
          <FilterPanel
            graph={graph}
            filter={filter}
            saved={savedFilters}
            onChange={setFilter}
            onSave={setSavedFilters}
            onClose={() => setFilterOpen(false)}
          />
        )}
        {answersOpen && (
          <AnswersPanel frames={frames} current={frameId} onOpen={(id) => showFrame(id)} onClose={() => setAnswersOpen(false)} />
        )}
        {storiesOpen && state && (
          <StoriesPanel
            stories={stories}
            settings={state.storySettings}
            charted={!!overview}
            onPlay={(id) => {
              const s = stories.find((x) => x.id === id);
              // An intro story plays on into the ones after it.
              const queue = s?.intro ? introStories.filter((x) => x.state !== "error").map((x) => x.id) : [];
              playStory(id, queue);
            }}
            onPlayIntro={playIntro}
            onClose={() => setStoriesOpen(false)}
          />
        )}
        {notesOpen && (
          <NotesPanel
            notes={notes}
            onOpen={(n) => {
              space.current?.flyToNote(n.id);
              setNoteEdit({ target: n.target, note: n });
            }}
            onClose={() => setNotesOpen(false)}
          />
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
                // How the group was made is why its files are in it.
                ...(from === "focus"
                  ? { paths: emphasis, why: `was in focus${focusLabel ? `: ${focusLabel}` : ""}` }
                  : from === "filter"
                    ? { paths: [...(visible ?? [])], why: `in the filter: ${describe(filter)}` }
                    : { include: pattern!.split(",").map((x) => x.trim()).filter(Boolean) }),
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
        {!showIntro && !filterOpen && !groupsOpen && !notesOpen && !storiesOpen && !answersOpen && legend && !file && (
          <Legend
            groups={legend.groups}
            counts={legend.counts}
            colors={legend.colors}
            isolated={isolatedIds}
            links={rowLinks?.links}
            selected={rowLinks?.selected}
            onPick={(g) => {
              setPickedRow({ id: g.id, label: g.label });
              if (legend.kind === "dir") {
                focus(graph!.files.filter((f) => (g.id === "." ? !f.path.includes("/") : f.path.startsWith(`${g.id}/`)) && (!visible || visible.has(f.path))).map((f) => f.path), g.label);
              } else focusModule(g.id);
            }}
            onIsolate={(g, exclude) =>
              toggleIsolate(legend.kind === "dir" ? { kind: "dir", id: g.id, label: g.label } : { kind: "module", id: g.id, label: g.label, paths: g.paths }, exclude)
            }
            onSolo={(g) => soloIsolate(legend.kind === "dir" ? { kind: "dir", id: g.id, label: g.label } : { kind: "module", id: g.id, label: g.label, paths: g.paths })}
            onShowAll={() => setFilter((f) => ({ ...f, isolate: undefined }))}
          />
        )}
        {state.stale && (
          <div className={`glass pointer-events-auto rounded-md px-3 py-1.5 text-[12.5px] text-text/90 ${changesOpen ? "w-[min(440px,calc(100vw-2rem))]" : "max-w-[340px]"}`}>
            The code has changed since this map was charted. Your groupings, groups and answers are kept.{" "}
            <button onClick={() => setChangesOpen((o) => !o)} aria-expanded={changesOpen} className="text-text underline-offset-2 hover:underline">
              {changesOpen ? "Hide changes" : "What changed?"}
            </button>{" "}
            ·{" "}
            <button onClick={() => void post("/api/reanalyze")} disabled={state.busy} className="text-course underline-offset-2 hover:underline disabled:opacity-50">
              Re-chart the overview
            </button>
            {changesOpen && (
              <ChartChanges
                version={state.graphVersion}
                onMap={visible ?? onMap}
                onOpenFile={(p) => openFile(p)}
                onLight={(paths) => focus(paths, "Changed since the chart")}
                onHistory={(to, from) => {
                  setHistoryOpen(true);
                  showRange({ from, to, label: "Since the chart" });
                }}
              />
            )}
          </div>
        )}
        {status === "error" && state.error && (
          <p className="glass pointer-events-auto max-w-[340px] rounded-md px-3 py-2 text-[12.5px] text-bad">
            The navigator couldn’t chart this repo: {state.error}. The map still works.
          </p>
        )}
      </div>

      {!minimal && focusLabel && emphasis.length > 0 && tour === null && !story && (
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
          <button
            onClick={() => hide(emphasis, `${emphasis.length} file${emphasis.length === 1 ? "" : "s"}`)}
            className="glass pointer-events-auto ml-1.5 rounded-full px-3 py-1 text-[13px] text-muted hover:text-text"
            title="Hide these files from the map (x)"
          >
            Hide
          </button>
        </div>
      )}
      {!minimal && toast && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2">
          <p className="glass rise pointer-events-auto flex items-center gap-3 rounded-full px-3.5 py-1 text-[13px]">
            <span className="max-w-[420px] truncate">{toast.text}</span>
            <button
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
              className="text-course hover:underline"
            >
              Undo
            </button>
          </p>
        </div>
      )}

      {/* Panels */}
      {file && (
        <div
          // A story's transport sits low in the middle; the code panel stops above it.
          className={panelFull ? "pointer-events-none absolute inset-4 z-40" : `pointer-events-none absolute left-4 top-28 z-20 ${story ? "bottom-[264px]" : "bottom-28"}`}
          style={panelFull ? undefined : { width: `min(${panelWidth}px, calc(100% - 2rem))` }}
        >
          {!panelFull && (
            <div
              onPointerDown={startResize("left")}
              onDoubleClick={() => setPanelWidth(600)}
              className="group pointer-events-auto absolute -right-2 bottom-4 top-4 z-10 flex w-3 cursor-col-resize items-center justify-center"
              title="Drag to resize · double-click to reset"
              role="separator"
              aria-orientation="vertical"
            >
              <span className="h-12 w-[3px] rounded-full bg-line transition-colors group-hover:bg-course/70" />
            </div>
          )}
          <FilePanel
            full={panelFull}
            onToggleFull={() => setPanelFull((f) => !f)}
            path={file.path}
            line={file.line}
            endLine={file.endLine}
            change={(() => {
              const h = heat?.get(file.path);
              if (!h || !range) return undefined;
              return { from: range.from, to: range.to, add: h.add, del: h.del, status: h.status, label: range.label };
            })()}
            onClose={() => setFile(null)}
            onNavigate={(p, l) => openFile(p, l)}
            onAsk={(r) => askNavigator(r)}
            onHide={() => hide([file.path], file.path.split("/").pop()!)}
            onNote={() => setNoteEdit({ target: { kind: "file", path: file.path } })}
            goEditor={goplsReady}
            onReferences={(name, paths) => {
              // Light who uses it on the map, without moving the camera off the code.
              setEmphasis([...new Set([file.path, ...paths])]);
              setFocusLabel(`References to ${name}`);
            }}
            onSelection={setSelection}
          />
        </div>
      )}
      {activeFrame && !story && (
        <div
          className="pointer-events-none absolute bottom-28 right-4 top-4 z-20"
          style={{ width: `min(${dossierWidth}px, calc(100% - 2rem))` }}
        >
          <div
            onPointerDown={startResize("right")}
            onDoubleClick={() => setDossierWidth(640)}
            className="group pointer-events-auto absolute -left-2 bottom-4 top-4 z-10 flex w-3 cursor-col-resize items-center justify-center"
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-orientation="vertical"
          >
            <span className="h-12 w-[3px] rounded-full bg-line transition-colors group-hover:bg-course/70" />
          </div>
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

      {story && (() => {
        const s = stories.find((x) => x.id === story.id);
        if (!s) return null;
        // Voiced with other settings (or not at all): the server is voicing it again, so wait for that.
        // (The key is server/tts.ts's voiceKey.)
        const ss = state.storySettings;
        const stale = ttsAvailable && s.state === "ready" && (s.silent || s.voiceKey !== `${ss.ttsModel}|${ss.voiceId}|${ss.rate}`);
        return (
          <StoryPlayer
            story={stale ? { ...s, state: "voicing", progress: "Voicing with the new settings" } : s}
            queue={story.queue.map((id) => stories.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x)}
            autoplay={story.autoplay}
            onFocus={(paths, label) => {
              // Fly to what the filter shows of it, unless it hides all of it.
              const shown = visible ? paths.filter((p) => visible.has(p)) : paths;
              focus(shown.length ? shown : paths, label);
            }}
            onOpenFile={(p, l, e) => openFile(p, l, e)}
            onPick={(id, autoplay) => playStory(id, story.queue, autoplay)}
            onClose={() => setStory(null)}
          />
        );
      })()}

      {!minimal && tuneOpen && (
        <div className="pointer-events-none absolute bottom-28 right-4 top-4 z-40 w-[min(360px,calc(100%-2rem))]">
          <TuningPanel tuning={tuning} onChange={setTuning} onRelayout={() => space.current?.relayout()} onClose={() => setTuneOpen(false)} />
        </div>
      )}

      {/* Bottom deck */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3 px-4 pb-4">
        {!minimal && !story && tour !== null && modules[tour] && (
          <TourCaption
            module={modules[tour]}
            index={tour}
            total={modules.length}
            onNext={() => setTour((i) => (i === null ? null : i + 1))}
            onStop={() => setTour(null)}
          />
        )}
        {historyOpen && gitHistory?.available && graph && (
          <CommitList
            commits={listed}
            total={gitHistory.commits.length}
            showAll={allCommits}
            selected={range}
            span={rangeCommits}
            delta={timeMap?.delta ?? null}
            loading={!!range && !timeMap}
            onMapPaths={visible ?? onMap}
            follow={follow}
            playing={playing}
            coupling={coupling}
            onSelect={(c, extend) => {
              setPlaying(false);
              cursor.current = c.sha;
              selectCommit(c, extend);
            }}
            onOpenFile={(p) => openFile(p)}
            onExplain={() => {
              const [a, b] = [rangeCommits.at(-1)!, rangeCommits[0]];
              askNavigator(
                rangeCommits.length > 1
                  ? `Explain the ${rangeCommits.length} commits from ${a.short} to ${b.short}: what changed, why, and how it reshaped the code around it.`
                  : b.worktree
                    ? "Explain my uncommitted changes: what they change and what they touch."
                    : `Explain commit ${b.short} ("${b.subject}"): what it changed, why, and how it affects the code around it.`,
              );
            }}
            onShowAll={setAllCommits}
            onFollow={setFollow}
            onPlay={startPlay}
            onCoupling={setCoupling}
            onClear={() => showRange(null)}
            onClose={() => {
              showRange(null);
              setHistoryOpen(false);
            }}
          />
        )}
        {historyOpen && gitHistory && !gitHistory.available && (
          <p className="glass pointer-events-auto rounded-lg px-3 py-2 text-[13px] text-muted">This folder isn’t a git repository, so there’s no history to show.</p>
        )}
        {showDestinations && !historyOpen && !story && <Destinations topics={overview!.topics} onPick={goTopic} />}
        <div className="flex w-full items-end justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-end justify-end gap-3">
            {!minimal && (
              <div className="hidden min-w-0 flex-1 md:block">
                <ActivityTicker activity={state.activity} busy={state.busy} />
              </div>
            )}
            <button
              onClick={() => setMinimal((m) => !m)}
              aria-pressed={minimal}
              title={minimal ? "Show everything again (u)" : "Hide everything but search and voice (u)"}
              className="glass pointer-events-auto shrink-0 rounded-full px-3 py-1.5 text-[12.5px] text-muted hover:text-text"
            >
              {minimal ? "Show UI" : "Hide UI"}
            </button>
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

