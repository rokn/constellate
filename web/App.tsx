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

const DEFAULT_LAYERS: Record<Layer, boolean> = { imports: false, logical: true, labels: true, folders: true, beacons: true };

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
  // gopls on the server: Go files then open in VS Code's editor with real navigation.
  const [goplsReady, setGoplsReady] = useState(false);
  useEffect(() => {
    void fetch("/api/lsp/status")
      .then((r) => r.json())
      .then((s: { go?: { available?: boolean } }) => setGoplsReady(!!s.go?.available))
      .catch(() => setGoplsReady(false));
  }, [state?.repo?.root]);
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
  /** A short-lived note with an undo — after hiding something. */
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
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
  const shownOverlays: Overlay[] = useMemo(
    () =>
      overlays
        .filter((o) => o.visible)
        .map((o) => ({ id: o.id, label: o.label, paths: o.paths, color: o.color, reasons: o.reasons, summary: o.summary, by: o.createdBy })),
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
    panels.current = { file: !!file, frame: !!frameId };
  }, [file, frameId]);
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
          // What you hid yourself stays hidden.
          return setFilter((f) => ({ ...EMPTY_FILTER, ...c.filter, hidden: f.hidden }));
        case "clear_filter":
          return setFilter((f) => ({ ...EMPTY_FILTER, hidden: f.hidden }));
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
        else if (tour !== null) setTour(null);
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
  }, [tour, pointer, frameId, file, emphasis, overview, voiceAvailable, voice, toOverview, back, filterOpen, groupsOpen, recenter, startVoice, hide, forward, panelFull]);

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
          onOpenImport={(from, line) => openFile(from, line)}
          onPickOverlay={(id) => {
            const g = overlays.find((o) => o.id === id);
            if (g) focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label);
          }}
          onHide={(t) => {
            if ("file" in t) return hide([t.file], t.file.split("/").pop()!);
            const under = graph.files.map((f) => f.path).filter((p) => p.startsWith(`${t.dir}/`) && (!visible || visible.has(p)));
            hide(under, `${t.dir}/ (${under.length} file${under.length === 1 ? "" : "s"})`);
          }}
          onPickDir={(d) => focus(graph.files.filter((f) => f.path.startsWith(`${d}/`)).map((f) => f.path), `${d}/`)}
          onBackground={() => setPointer(null)}
        />
      )}

      {showIntro && <Intro state={state} graph={graph} onTour={() => (setIntroDone(true), setTour(0))} onExplore={() => setIntroDone(true)} />}

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
        </div>
        {!showIntro && (
          <div className="pointer-events-auto flex flex-wrap gap-1.5 text-[13px]">
            <Btn onClick={recenter} hint="Space">Recenter</Btn>
            <Btn onClick={toOverview} hint="o">Overview</Btn>
            <Btn onClick={back} hint="[ or mouse back">Back</Btn>
            <Btn onClick={forward} hint="] or mouse forward">Forward</Btn>
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
                {visible.size.toLocaleString("en-US")} of {graph.files.length.toLocaleString("en-US")} files · {describe(filter)}
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

      {!minimal && focusLabel && emphasis.length > 0 && tour === null && (
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
          className={panelFull ? "pointer-events-none absolute inset-4 z-40" : "pointer-events-none absolute bottom-28 left-4 top-28 z-20"}
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
            onClose={() => setFile(null)}
            onNavigate={(p, l) => openFile(p, l)}
            onAsk={(r) => askNavigator(r)}
            onHide={() => hide([file.path], file.path.split("/").pop()!)}
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
      {activeFrame && (
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

      {!minimal && tuneOpen && (
        <div className="pointer-events-none absolute bottom-28 right-4 top-4 z-40 w-[min(360px,calc(100%-2rem))]">
          <TuningPanel tuning={tuning} onChange={setTuning} onRelayout={() => space.current?.relayout()} onClose={() => setTuneOpen(false)} />
        </div>
      )}

      {/* Bottom deck */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3 px-4 pb-4">
        {!minimal && tour !== null && modules[tour] && (
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
