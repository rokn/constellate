import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Commit, Frame, Isolated, Layer, LogicalModule, MapFilter, Note, NoteTarget, RepoGraph, SavedFilter, ScreenContext, TimeRange, Topic, UiCommand, ViewSettings } from "../shared/types";
import { commitsIn, couplingsOf, describeRange, heatOf, mapAcross, relevantPaths, resolveSpan, useGraphsAt, useHistory, type HeatEntry, type Span } from "./lib/history";
import { CommitList } from "./components/CommitList";
import { NoteEditor, NotesPanel, describeTarget } from "./components/Notes";
import { ChartChanges } from "./components/ChartChanges";
import { RemoteBanner } from "./components/RemoteBanner";
import { AnswersPanel } from "./components/AnswersPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { EMPTY_FILTER, applyFilter, describe, isActive } from "../shared/filter";
import { renameInFilter, renamer } from "../shared/renames";
import { ask, clearFileCache, config, post, useGraph, useSession } from "./lib/api";
import { useVoice } from "./lib/useVoice";
import { territoryColors } from "./lib/colors";
import { Space, type Grouping, type Overlay, type SpaceHandle, type TouchHit, type TouchGesture } from "./components/Space";
import { FilterPanel, GroupsPanel, Legend, OTHER, OrganizeBar } from "./components/MapControls";
import { TuningPanel } from "./components/TuningPanel";
import { DEFAULT_TUNING, loadTuning, saveTuning, type Tuning } from "./lib/tuning";
import { loadXR, saveXR, sound, type XRSettings } from "./lib/xrSettings";
import { Dossier, type Pointer } from "./components/Dossier";
import { FilePanel } from "./components/FilePanel";
import { CommandBar, type Jump } from "./components/CommandBar";
import { ActivityTicker, Destinations, Intro, Landing, TourCaption, VoiceDock, rememberRepo } from "./components/Overlays";
import { StoryPlayer, type StoryControl } from "./components/StoryPlayer";
import { Shelf } from "./components/Shelf";
import { TouchRing, type RingItem } from "./components/TouchRing";
import { EdgeScrub } from "./components/EdgeScrub";
import { buzz, touchFirst } from "./lib/haptics";
import { StoriesPanel } from "./components/StoriesPanel";
import { BranchDiff, BranchMapBar, type BranchSummary } from "./components/BranchDiff";
import { useXR, type XR, type XRFeed } from "./xr/useXR";
import { XRButtons } from "./xr/XRButtons";
import type { MapHit, MapInput, MapStyle } from "./xr/map";

const DEFAULT_LAYERS: Record<Layer, boolean> = { imports: false, logical: true, labels: true, folders: true, beacons: true, notes: true };

/** A place you've been, so "back" retraces the flight. */
type Stop =
  | { kind: "overview" }
  | { kind: "file"; path: string; line?: number; endLine?: number }
  | { kind: "focus"; paths: string[]; label?: string }
  | { kind: "frame"; frameId: string };

const TOUR_STEP_MS = 7000;
const NO_ACTIVITY: never[] = [];

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

  /**
   * The camera. Every flight goes to the desktop map and, while you're in a
   * headset, to the headset's map too, so both are always looking at the same
   * thing and taking the headset off lands you where you were.
   */
  const desk = useRef<SpaceHandle>(null);
  const xrRef = useRef<XR | null>(null);
  const space = useMemo(
    () => ({
      get current(): SpaceHandle | null {
        const d = desk.current;
        const cam = xrRef.current?.camera;
        if (!d || !cam) return d;
        return {
          ...d,
          flyTo: (p, shift) => (d.flyTo(p, shift), void cam.flyTo(p)),
          focus: (ps, shift) => (d.focus(ps, shift), void cam.focus(ps)),
          overview: () => (d.overview(), void cam.overview()),
          pulse: (p) => (d.pulse(p), void cam.pulse(p)),
        };
      },
    }),
    [],
  );
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
  const [shelfOpen, setShelfOpen] = useState(false);
  /** A finger held on the map: the ring of actions on what it's on. */
  const [held, setHeld] = useState<{ hit: TouchHit; x: number; y: number; pointerId: number } | null>(null);
  const [tilting, setTilting] = useState(false);
  // The first touch on the map shows what touch can do, once.
  const [touchHint, setTouchHint] = useState(false);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      window.removeEventListener("pointerdown", onDown);
      try {
        if (localStorage.getItem("constellate.touchHint")) return;
        localStorage.setItem("constellate.touchHint", "1");
      } catch {
        /* private mode: show it anyway */
      }
      setTouchHint(true);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);
  // Another repo opened, from this page or another device: start the page
  // over on it rather than carry this one's panels, history and camera across.
  const openRoot = useRef<string | undefined>(undefined);
  const repoRoot = state?.repo?.root;
  const connected = !!state;
  useEffect(() => {
    if (!connected) return;
    if (openRoot.current !== undefined && repoRoot !== openRoot.current) window.location.reload();
    openRoot.current = repoRoot;
  }, [connected, repoRoot]);
  const [tour, setTour] = useState<number | null>(null);
  const [selection, setSelection] = useState("");
  /** A short-lived note with an undo — after hiding something. */
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
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
  // The headset's own knobs (and the voice volume), kept per browser.
  const [xrSettings, setXRSettings] = useState<XRSettings>(loadXR);
  useEffect(() => {
    saveXR(xrSettings);
    sound.volume = xrSettings.voiceVolume;
  }, [xrSettings]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [storiesOpen, setStoriesOpen] = useState(false);
  const [answersOpen, setAnswersOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  /** The story playing, the playlist it's in, and whether to start on its own. */
  const [story, setStory] = useState<{ id: string; queue: string[]; autoplay: boolean; startAt?: { beat: number; ms: number } } | null>(null);
  // Questions about a story: where the open one is, one paused to make way
  // for an answer (with a way back to it), and the last one watched.
  const [storyAt, setStoryAt] = useState({ beat: 0, playing: false });
  const [parked, setParked] = useState<{ id: string; queue: string[]; beat: number; ms: number } | null>(null);
  const [lastStory, setLastStory] = useState<{ id: string; beat: number } | null>(null);
  const storyCtl = useRef<StoryControl | null>(null);
  /** A branch's code diff against its base, open over everything. */
  const [branchDiff, setBranchDiff] = useState<{ branch: string; base?: string; agent?: string } | null>(null);
  /**
   * A branch on the map, the way History shows a commit: the map is the code
   * at the branch's tip, lit against where it forked. A link opens it:
   * /?diff=<branch>&base=<base>. An agent's branch is lit against the commit
   * it started on instead, with what it hasn't committed yet: &agent=<id>.
   */
  const [branchMap, setBranchMap] = useState<{ branch: string; base?: string; agent?: string } | null>(() => {
    const q = new URLSearchParams(location.search);
    const branch = q.get("diff");
    return branch ? { branch, base: q.get("base") || undefined, agent: q.get("agent") || undefined } : null;
  });
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
  const openPanel = (which: "filter" | "groups" | "notes" | "stories" | "answers" | "agents" | null) => {
    setAgentsOpen(which === "agents");
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
  /** Hide, show or delete every marker one answer made; a delete can be undone. */
  const markersOf = useCallback(
    (frameId: string, action: "hide" | "show" | "delete") => {
      const made = overlays.filter((o) => o.frameId === frameId);
      if (!made.length) return;
      void post("/api/overlays", { action: action === "delete" ? "delete" : "update", frameId, visible: action === "show" });
      if (action === "show") return;
      const n = `${made.length} marker${made.length === 1 ? "" : "s"}`;
      setToast({
        text: action === "delete" ? `Deleted ${n} from that answer` : `Hid ${n} from that answer — they're still in Markers`,
        undo: () =>
          void (action === "delete"
            ? post("/api/overlays", { action: "restore", markers: made })
            : Promise.all(made.filter((o) => o.visible).map((o) => post("/api/overlays", { action: "update", id: o.id, visible: true })))),
      });
    },
    [overlays],
  );
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

  /* ------------------------------ a branch, mapped ------------------------------ */

  // The same machinery as a span of history: the map at the branch's tip,
  // compared with the map at the merge base — what the branch did since it
  // forked. The branch needn't be checked out; both maps come from git.
  const [branchSum, setBranchSum] = useState<BranchSummary | null>(null);
  const [branchError, setBranchError] = useState("");
  // An agent still at work is read again as it goes: each step it takes (the
  // edit before has landed by then), and when it stops and commits.
  const watched = branchMap?.agent ? state?.agents.find((a) => a.id === branchMap.agent) : undefined;
  const agentStep = watched ? `${watched.status}|${watched.commits}|${watched.files.join(",")}|${watched.status === "working" ? watched.activity ?? "" : ""}` : "";
  useEffect(() => {
    setBranchSum(null);
    setBranchError("");
  }, [branchMap]);
  useEffect(() => {
    if (!branchMap || status === "idle" || status === "scanning") return;
    let live = true;
    const q = new URLSearchParams(
      branchMap.agent ? { agent: branchMap.agent } : { branch: branchMap.branch, ...(branchMap.base ? { base: branchMap.base } : {}) },
    );
    void fetch(`/api/branch-diff?${q}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        if (live) {
          setBranchSum(b as BranchSummary);
          setBranchError("");
        }
      })
      .catch((e) => live && setBranchError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [branchMap, status, state?.graphVersion, agentStep]);
  const branchMaps = useGraphsAt(branchSum ? [branchSum.head, branchSum.mergeBase] : []);
  const branchTime = useMemo(() => {
    if (!branchSum) return null;
    const after = branchMaps.get(branchSum.head);
    const before = branchMaps.get(branchSum.mergeBase);
    return after && before ? mapAcross(after, before) : null;
  }, [branchSum, branchMaps]);
  // While an agent's newer work is mapped, its last map stays up.
  const lastBranchTime = useRef<{ of: string; time: NonNullable<typeof branchTime> } | null>(null);
  const branchKey = branchMap ? `${branchMap.branch}|${branchMap.agent ?? ""}` : "";
  if (branchTime && branchSum) lastBranchTime.current = { of: `${branchSum.branch}|${branchSum.agent?.id ?? ""}`, time: branchTime };
  const branchShown = branchTime ?? (lastBranchTime.current?.of === branchKey ? lastBranchTime.current.time : null);
  /** The branch's churn, per file, in the shape History's heat takes. */
  const branchHeat = useMemo(
    () =>
      branchSum
        ? new Map<string, HeatEntry>(
            branchSum.files.map((f) => [f.path, { add: f.add, del: f.del, commits: 1, status: f.status === "A" ? "A" : f.status === "D" ? "D" : "M", authors: new Set<string>() }]),
          )
        : null,
    [branchSum],
  );

  const shownTime = branchMap ? branchShown : range ? (timeMap ?? lastTimeMap.current) : null;
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
  // stays listed for adding. It's the map on screen: a branch's or a moment
  // in history's files, when one is shown.
  const unisolated = useMemo(() => (mapGraph ? applyFilter(mapGraph.files, { ...filter, isolate: undefined }) : null), [mapGraph, filter]);
  const legend = useMemo(() => {
    if (!mapGraph) return null;
    if (!grouping) {
      // By folder: the top-level folders, in the map's own colours.
      const counts = new Map<string, number>();
      for (const f of mapGraph.files) if (!unisolated || unisolated.has(f.path)) counts.set(f.top, (counts.get(f.top) ?? 0) + 1);
      const groups: LogicalModule[] = [...counts.keys()]
        .sort((a, b) => counts.get(b)! - counts.get(a)!)
        .map((t) => ({ id: t, label: t === "." ? "files at the root" : `${t}/`, summary: "", paths: [] }));
      const memberOf = new Map(mapGraph.files.map((f) => [f.path, f.top]));
      return { kind: "dir" as const, groups, counts, memberOf, colors: territoryColors(mapGraph.files.map((f) => f.top)) };
    }
    const groupOf = new Map<string, string>();
    for (const g of grouping.groups) for (const p of g.paths) if (!groupOf.has(p)) groupOf.set(p, g.id);
    const counts = new Map<string, number>();
    const others: string[] = [];
    for (const f of mapGraph.files) {
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
    const memberOf = new Map(mapGraph.files.map((f) => [f.path, groupOf.get(f.path) ?? OTHER]));
    return { kind: "module" as const, groups, counts, memberOf, colors: undefined };
  }, [grouping, mapGraph, unisolated]);

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

  /** `above`: from straight overhead (the tablet laid flat). Anything else, like a click event, is the usual view. */
  const toOverview = useCallback((above?: unknown) => {
    setTour(null);
    setFile(null);
    setFrameId(null);
    setEmphasis([]);
    setFocusLabel(undefined);
    setPointer(null);
    space.current?.overview(above === true);
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

  // The browser's back and forward (the mouse's side buttons, a swipe, ⌘[)
  // move through what you've opened instead of leaving the page, which behind
  // a login means landing on its redirect. The page keeps three entries and
  // sits on the middle one: stepping onto either side is a step through the
  // history, and the page puts itself back in the middle. They're added on the
  // first click or key, since Chrome's back button skips entries added before
  // the page has been used.
  const travelRef = useRef(travel);
  travelRef.current = travel;
  useEffect(() => {
    const at = (s: unknown) => (s as { constellate?: string } | null)?.constellate;
    const arm = () => {
      if (at(window.history.state) === "here") return;
      window.history.replaceState({ constellate: "back" }, "");
      window.history.pushState({ constellate: "here" }, "");
      window.history.pushState({ constellate: "forward" }, "");
      window.history.back();
    };
    const onPop = (e: PopStateEvent) => {
      const where = at(e.state);
      if (where === "back") {
        window.history.forward();
        travelRef.current(-1);
      } else if (where === "forward") {
        window.history.back();
        travelRef.current(1);
      }
    };
    window.addEventListener("pointerdown", arm, { capture: true, once: true });
    window.addEventListener("keydown", arm, { capture: true, once: true });
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("pointerdown", arm, true);
      window.removeEventListener("keydown", arm, true);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

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
      branch: branchMap ? { name: branchMap.branch, base: branchMap.base, agent: branchMap.agent } : undefined,
      range: branchMap
        ? branchSum?.agent
          ? `what the agent "${branchSum.agent.title}" changed on ${branchSum.branch} since it started: ${branchSum.commits.length} commits, ${branchSum.files.length} files changed${branchSum.agent.live ? ", some not committed yet" : ""}`
          : branchSum
            ? `the branch ${branchSum.branch} compared with ${branchSum.base} (since they forked): ${branchSum.commits.length} commits, ${branchSum.files.length} files changed`
            : `the branch ${branchMap.branch}`
        : range
          ? describeRange(range, rangeCommits)
          : undefined,
      filter: isActive(filter) ? describe(filter) : undefined,
      visibleFiles: visible?.size,
      story: story
        ? { id: story.id, beat: storyAt.beat, playing: storyAt.playing }
        : parked
          ? { id: parked.id, beat: parked.beat, playing: false, parked: true }
          : lastStory
            ? { id: lastStory.id, beat: lastStory.beat, playing: false, closed: true }
            : undefined,
    }),
    [file, frameId, focusLabel, selection, tour, lensTitle, lensId, filter, visible, range, rangeCommits, branchMap, branchSum, story, storyAt, parked, lastStory],
  );

  /** Pause the open story and set it aside, so an answer can take the stage; Resume brings it back. */
  const parkStory = useCallback(() => {
    if (!story) return null;
    const at = storyCtl.current?.where() ?? { beat: storyAt.beat, ms: 0 };
    storyCtl.current?.pause();
    setParked({ id: story.id, queue: story.queue, ...at });
    setStory(null);
    return at;
  }, [story, storyAt.beat]);

  const askNavigator = useCallback(
    (request: string, topicId?: string) => {
      setIntroDone(true);
      setTour(null);
      // Asked mid-story: it's a question about the story, which waits for the answer.
      const at = parkStory();
      const asked = at && story ? { ...screen, story: { id: story.id, beat: at.beat, playing: false, parked: true } } : screen;
      void ask(request, { topicId, screen: asked });
    },
    [screen, parkStory, story],
  );

  /**
   * Show a span of history. `fly` takes the camera to what changed — for a
   * picked commit or a named span; a drag on the timeline only relights the
   * map, so scrubbing doesn't yank the view around.
   */
  const showRange = useCallback((r: TimeRange | null) => {
    setRange(r);
    // One span of change on the map at a time: a commit replaces a branch.
    if (r) setBranchMap(null);
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

  // A branch's map arriving flies to what the branch changed, as Follow does for a commit.
  // An agent's, read again as it works, moves the camera only the first time.
  const flownTo = useRef("");
  useEffect(() => {
    if (!branchTime || !branchSum) return;
    if (branchSum.agent && flownTo.current === branchKey) return;
    flownTo.current = branchKey;
    const ends = [...branchTime.delta.addedEdges, ...branchTime.delta.removedEdges].flatMap((k) => k.split(">"));
    const changed = [...new Set([...branchSum.files.map((f) => f.path), ...ends])].filter((p) => (visible ?? onMap).has(p));
    if (changed.length) focus(changed, branchSum.agent ? `Agent: ${branchSum.agent.title}` : `${branchSum.branch} vs ${branchSum.base}`);
    // Only the branch's map arriving moves the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchTime]);

  /** Put a branch on the map (History steps aside: one span of change at a time). */
  const showBranch = useCallback((branch: string, base?: string, agent?: string) => {
    setIntroDone(true);
    setHistoryOpen(false);
    setRange(null);
    setPlaying(false);
    flownTo.current = "";
    setBranchMap({ branch, base, agent });
  }, []);
  const closeBranch = useCallback(() => {
    setBranchMap(null);
    setEmphasis([]);
    setFocusLabel(undefined);
    if (new URLSearchParams(location.search).has("diff")) window.history.replaceState(window.history.state, "", location.pathname);
  }, []);

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

  /**
   * The thumb strip along the bottom: oldest on the left, now on the right.
   * Maps load for each commit picked, so a fast slide picks a few a second
   * and always lands on the last one.
   */
  const scrubbed = useRef<{ at: number; timer?: ReturnType<typeof setTimeout> }>({ at: 0 });
  const commitAt = (f: number) => listed[Math.round((1 - f) * (listed.length - 1))];
  const scrubHistory = useCallback(
    (f: number) => {
      const c = listed[Math.round((1 - f) * (listed.length - 1))];
      if (!c || c.sha === cursor.current) return;
      cursor.current = c.sha;
      setPlaying(false);
      const s = scrubbed.current;
      clearTimeout(s.timer);
      const wait = 150 - (performance.now() - s.at);
      const go = () => {
        s.at = performance.now();
        selectCommit(c);
      };
      if (wait <= 0) go();
      else s.timer = setTimeout(go, wait);
    },
    [listed, selectCommit],
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
    setParked(null);
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

  // A link to a story (/?story=<id>, as the branch-story API hands out) opens it.
  const linked = useRef(new URLSearchParams(location.search).get("story"));
  useEffect(() => {
    const id = linked.current;
    if (!id || !stories.some((s) => s.id === id)) return;
    linked.current = null;
    window.history.replaceState(window.history.state, "", location.pathname);
    playStory(id);
  }, [stories, playStory]);

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
    // Asked mid-story (a spoken question comes this way): the story steps aside for it.
    parkStory();
    setFrameId(f.id);
    panels.current.frame = true;
    setPointer(null);
    record({ kind: "frame", frameId: f.id });
  }, [frames, parkStory]);

  /* ------------------------------- commands ------------------------------- */

  /** The navigator's flights land with a tap you can feel, as the camera arrives. */
  const landing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const feelLanding = useCallback(() => {
    clearTimeout(landing.current);
    landing.current = setTimeout(() => buzz([14, 60, 14]), tuning.flySeconds * 1000);
  }, [tuning.flySeconds]);
  const run = useCallback(
    (c: UiCommand) => {
      switch (c.cmd) {
        case "fly_to":
          feelLanding();
          return openFile(c.path);
        case "open_file":
          return openFile(c.path, c.line, c.endLine, false);
        case "focus":
          feelLanding();
          return focus(c.paths, c.label);
        case "focus_module":
          feelLanding();
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
        case "show_branch":
          return showBranch(c.branch, c.base, c.agent);
        case "renamed": {
          // The server moved everything it keeps; this is what the page keeps.
          const to = renamer(c.renames);
          setFilter((f) => renameInFilter(f, to));
          setSavedFilters((fs) => fs.map((v) => ({ ...v, filter: renameInFilter(v.filter, to) })));
          setFile((f) => (f && to(f.path) !== f.path ? { ...f, path: to(f.path) } : f));
          return setEmphasis((ps) => (ps.some((p) => to(p) !== p) ? [...new Set(ps.map(to))] : ps));
        }
      }
    },
    [openFile, focus, focusModule, toOverview, back, showFrame, showRange, showSpan, startPlay, feelLanding, showBranch],
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

  const voice = useVoice({ screen, onCommand: (c) => runRef.current(c), volume: xrSettings.voiceVolume });

  // Talking over a story pauses it, so you and the voice can hear each other.
  useEffect(() => {
    if (story && (voice.heard || voice.state === "speaking")) storyCtl.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.heard, voice.state]);
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
        else if (branchMap) closeBranch();
        else if (range) showRange(null);
        else if (emphasis.length) {
          setEmphasis([]);
          setFocusLabel(undefined);
        }
        // Nothing else on screen: the last step back undoes "show only" — but
        // what you hid by hand stays hidden; that's a choice, not a view.
        else if (filter.isolate?.some((i) => !i.exclude)) {
          setFilter((f) => {
            const kept = f.isolate?.filter((i) => i.exclude);
            return { ...f, isolate: kept?.length ? kept : undefined };
          });
        }
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
      else if (e.key === "m" || e.key === "g") openPanel(groupsOpen ? null : "groups");
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

  /* -------------------------------- headset -------------------------------- */

  // The headset draws this same state; see xr/useXR. These parts are kept as
  // stable objects so its panels repaint only when what they show changes.
  const xrLegend = useMemo((): XRFeed["model"]["legend"] => {
    if (!legend) return { kind: "dir", rows: [] };
    const colors = legend.colors ?? territoryColors((grouping?.groups ?? []).map((g) => g.id));
    return {
      kind: legend.kind,
      rows: legend.groups.map((g) => ({
        id: g.id,
        label: g.label,
        color: g.id === OTHER ? "#5d6a85" : colors.get(g.id),
        count: legend.counts.get(g.id) ?? 0,
        isolated: isolatedIds.get(g.id),
      })),
    };
  }, [legend, grouping, isolatedIds]);
  const xrVoice = useMemo(
    () => ({ available: voiceAvailable, state: voice.state, caption: voice.caption, heard: voice.heard, error: voice.error }),
    [voiceAvailable, voice.state, voice.caption, voice.heard, voice.error],
  );
  const xrTour = useMemo(() => {
    const ms = overview?.modules ?? [];
    return tour !== null && ms[tour] ? { index: tour, total: ms.length, label: ms[tour].label, summary: ms[tour].summary } : null;
  }, [tour, overview]);
  const xrLenses = useMemo(() => lenses.map((l) => ({ id: l.id, title: l.title })), [lenses]);
  const xrFilter = useMemo(
    () => ({ active: isActive(filter), label: isActive(filter) ? describe(filter) : undefined, hideTests: filter.hideTests, hideDocs: filter.hideDocs }),
    [filter],
  );
  const xrMap = useMemo(
    (): MapInput | null => (mapGraph ? { graph: mapGraph, overview, grouping, visible, notes, overlays: shownOverlays, tuning } : null),
    [mapGraph, overview, grouping, visible, notes, shownOverlays, tuning],
  );
  const xrStyle = useMemo((): MapStyle => ({ emphasis, active: file?.path ?? null, layers }), [emphasis, file?.path, layers]);
  /** What's under a folder on the map. */
  const filesUnder = (dir: string) => (mapGraph?.files ?? []).map((f) => f.path).filter((p) => (dir === "." ? !p.includes("/") : p.startsWith(`${dir}/`)));
  /** The files and name behind something pointed at on the map in the headset. */
  const filesOfHit = (h: MapHit): { paths: string[]; label: string; module?: { id: string; label: string; paths: string[] } } => {
    if (h.kind === "file") return { paths: [h.id], label: h.id.split("/").pop()! };
    if (h.kind === "dir") return { paths: filesUnder(h.id), label: `${h.id}/` };
    if (h.kind === "module") {
      const m = (grouping?.groups ?? []).find((g) => g.id === h.id) ?? overview?.modules.find((g) => g.id === h.id);
      return { paths: m?.paths ?? [], label: h.label, module: m && { id: m.id, label: m.label, paths: m.paths } };
    }
    if (h.kind === "overlay") {
      const o = overlays.find((x) => x.id === h.id);
      return { paths: o?.paths ?? [], label: o?.label ?? "Marker" };
    }
    return { paths: [], label: "" };
  };
  const xrLangs = useMemo(() => Object.entries(graph?.languages ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l]) => l), [graph]);
  const xrTops = useMemo(() => {
    const count = new Map<string, number>();
    for (const f of graph?.files ?? []) count.set(f.top, (count.get(f.top) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([id, n]) => ({ id, count: n }));
  }, [graph]);
  /** An agent request from the headset; it answers in a toast, as there's no panel to show an error in. */
  const agentCall = async (body: Record<string, unknown>, ok: string) => {
    const r = await post("/api/agents", body);
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setToast({ text: r.ok ? ok : j.error ?? "That didn't work." });
  };
  const recenterRef = useRef(recenter);
  recenterRef.current = recenter;
  const xr = useXR({
    model: {
      status,
      error: state?.error,
      repoName: state?.repo?.name,
      headline: overview?.headline,
      library: !!state?.library,
      locked: !!state?.locked,
      busy: !!state?.busy,
      activity: state?.activity ?? NO_ACTIVITY,
      overview,
      frames,
      frameId,
      pointer,
      file,
      intro: !introDone,
      voice: xrVoice,
      tour: xrTour,
      toast,
      layers,
      lensId,
      lenses: xrLenses,
      legend: xrLegend,
      visibleCount: visible?.size ?? mapGraph?.files.length ?? 0,
      totalCount: mapGraph?.files.length ?? 0,
      filter: xrFilter,
      stories,
      agents: state?.agents ?? NO_ACTIVITY,
      agentsOn: !!state?.agentsOn,
      tuning,
      settings: xrSettings,
      mapFilter: filter,
      savedFilters,
      langs: xrLangs,
      tops: xrTops,
    },
    actions: {
      openFile: (p, l, e) => openFile(p, l, e),
      // A folder row is the files under it; a module row, the module.
      focusModule: (id) => (legend?.kind === "dir" ? focus(filesUnder(id), id === "." ? "files at the root" : `${id}/`) : focusModule(id)),
      isolate: (id, how) => {
        const row = xrLegend.rows.find((r) => r.id === id);
        const m = legend?.kind === "module" ? (grouping?.groups ?? overview?.modules ?? []).find((g) => g.id === id) : undefined;
        if (!row) return;
        const item: Isolated = m ? { kind: "module", id, label: m.label, paths: m.paths } : { kind: "dir", id, label: row.label };
        if (how === "solo") return soloIsolate(item);
        const wasHidden = filter.isolate?.some((i) => i.kind === item.kind && i.id === id && i.exclude);
        toggleIsolate(item, how === "exclude");
        if (how === "exclude" && !wasHidden) setToast({ text: `Hid ${item.label}`, undo: () => toggleIsolate(item, true) });
      },
      overview: toOverview,
      back,
      forward,
      frameSelection: recenter,
      showFrame,
      closeFrame: () => {
        setIntroDone(true);
        setFrameId(null);
        setPointer(null);
      },
      closeFile: () => setFile(null),
      ask: (t, topicId) => askNavigator(t, topicId),
      interrupt: () => void post("/api/interrupt"),
      toggleVoice: () => (voice.state === "idle" || voice.state === "error" ? startVoice() : voice.stop()),
      setLayer: (l, on) => setLayers((x) => ({ ...x, [l]: on })),
      setLens: (id) => {
        setTour(null);
        setLensId(id);
      },
      setFilter: (patch) => setFilter((f) => ({ ...f, ...patch })),
      clearFilter: () => setFilter((f) => ({ ...EMPTY_FILTER, hidden: f.hidden })),
      hide: (p) => hide([p], p.split("/").pop()!),
      startTour: () => {
        setIntroDone(true);
        setTour(0);
      },
      stopTour: () => setTour(null),
      playStory: (id) => playStory(id),
      storyToggle: () => storyCtl.current?.toggle(),
      storySeek: (beat) => storyCtl.current?.seek(beat),
      closeStory: () => {
        if (story) setLastStory({ id: story.id, beat: storyAt.beat });
        setStory(null);
      },
      writeStory: (request) => {
        void post("/api/stories", { action: "create", request });
        setToast({ text: "Writing the story — it plays when it's ready." });
      },
      openRepo: (id) => void post("/api/open", { github: id }),
      openPath: (t) => void post("/api/open", state?.library ? { github: t } : { path: t }),
      reanalyze: () => void post("/api/reanalyze"),
      startAgent: (task) =>
        void agentCall({ action: "start", task }, "The agent is on it. Its files light up as it works."),
      focusAgent: (id) => {
        const a = state?.agents.find((x) => x.id === id);
        const paths = a?.files.filter((p) => onMap.has(p)) ?? [];
        if (a && paths.length) focus(paths, a.title);
        else setToast({ text: "It hasn't changed anything on the map yet." });
      },
      agentAction: (id, action) => void agentCall({ action, id }, { pr: "Pull request opened.", merge: "Merged.", rebase: "Rebased onto its base.", stop: "Stopped." }[action]),
      addNote: (path, text) => void post("/api/notes", { action: "add", text, target: { kind: "file", path } }),
      isFile: (p) => onMap.has(p),
      setTuning: (patch) => setTuning((t) => ({ ...t, ...patch })),
      setXR: (patch) => setXRSettings((x) => ({ ...x, ...patch })),
      setMapFilter: (f) => setFilter(f),
      focusAround: (h, depth) => {
        const { paths, label } = filesOfHit(h);
        const shown = (p: string) => (visible ? visible.has(p) : onMap.has(p));
        const lit = new Set(paths.filter(shown));
        // Ring by ring out along the imports.
        let ring = [...lit];
        for (let d = 0; d < depth && ring.length; d++) {
          const next: string[] = [];
          for (const p of ring) for (const n of neighbours.get(p) ?? []) if (!lit.has(n) && shown(n)) lit.add(n), next.push(n);
          ring = next;
        }
        const more = ring.some((p) => [...(neighbours.get(p) ?? [])].some((n) => !lit.has(n) && shown(n)));
        const out = [...lit];
        // The links worth lighting reach in from the last ring, not across it.
        const outer = new Set(depth ? ring : []);
        const core = out.filter((p) => !outer.has(p));
        if (out.length) focus(out, depth ? `${label} + ${depth} ring${depth > 1 ? "s" : ""}` : label);
        return { label, count: out.length, more, paths: out, core };
      },
      focusPaths: (paths, label) => focus(paths, label),
      hideHit: (h) => {
        const { paths, label, module } = filesOfHit(h);
        if (module) {
          const item: Isolated = { kind: "module", ...module };
          // Flung away: the map stays framed where it is, not shrunk to what's left.
          soloAt.current = performance.now();
          toggleIsolate(item, true);
          setToast({
            text: `Hid ${item.label}`,
            undo: () => {
              soloAt.current = performance.now();
              toggleIsolate(item, true);
            },
          });
        } else if (paths.length) hide(paths, label);
      },
    },
    handlers: {
      onPick: (h) => {
        if (h.kind === "file") return openFile(h.id, undefined, undefined, false);
        if (h.kind === "module") return focusModule(h.id);
        if (h.kind === "dir") return focus(filesUnder(h.id), `${h.id}/`);
        if (h.kind === "overlay") {
          const g = overlays.find((o) => o.id === h.id);
          if (g) focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label);
          return;
        }
        const n = notes.find((x) => x.id === h.id);
        if (!n) return;
        if (n.target.kind === "file") return openFile(n.target.path);
        const t = n.target;
        openFile(t.from, mapGraph?.imports.find((e) => e.from === t.from && e.to === t.to)?.line);
      },
      describe: (h) => {
        if (h.kind === "file") {
          const f = mapGraph?.files.find((x) => x.path === h.id);
          return [
            { text: h.id.split("/").pop()!, bold: true },
            { text: h.id, mono: true },
            { text: `${f?.loc ?? 0} lines · ${f?.lang ?? ""} · ${neighbours.get(h.id)?.size ?? 0} connections` },
          ];
        }
        if (h.kind === "module") return [{ text: h.label, bold: true, color: "#ffb547" }, ...(h.summary ? [{ text: h.summary }] : []), { text: `${h.files ?? 0} files` }];
        if (h.kind === "dir") return [{ text: `${h.id}/`, bold: true }];
        if (h.kind === "overlay") {
          const o = overlays.find((x) => x.id === h.id);
          return [{ text: o?.label ?? "Marker", bold: true, color: o?.color }, ...(o?.summary ? [{ text: o.summary }] : [])];
        }
        const n = notes.find((x) => x.id === h.id);
        return [{ text: "Note", bold: true, color: "#ffd75e" }, { text: n?.text.split("\n")[0] ?? "" }];
      },
      onBackground: () => setPointer(null),
      onButton: (b) => {
        if (b === "back") return back();
        if (b === "forward") return forward();
        if (b === "overview") return toOverview();
        if (b === "frame") return recenter();
        if (voice.state === "idle" || voice.state === "error") startVoice();
        else voice.stop();
      },
    },
    map: xrMap,
    style: xrStyle,
    story: () => {
      const s = story && stories.find((x) => x.id === story.id);
      const at = storyCtl.current?.where();
      return s && at ? { story: s, ...at } : null;
    },
  });
  xrRef.current = xr;
  // While you're in the headset the desktop map doesn't draw, so it needn't
  // regroup either: a fling there would otherwise rebuild it underneath you.
  const deskVisible = useRef(visible);
  if (!xr.presenting) deskVisible.current = visible;
  // In the headset, the desktop map stops drawing. Coming back out, it frames
  // whatever you were on in there, so the desktop picks up where you were.
  const wasPresenting = useRef(false);
  useEffect(() => {
    desk.current?.setPaused(xr.presenting);
    if (wasPresenting.current && !xr.presenting) setTimeout(() => recenterRef.current(), 150);
    wasPresenting.current = xr.presenting;
  }, [xr.presenting]);

  if (!state) return <div className="h-full bg-night" />;

  if (status === "idle" || (!graph && status === "error")) {
    return (
      <div className="relative h-full bg-night">
        <Landing onOpen={(p) => void post("/api/open", { path: p })} error={state.error} library={state.library} />
      </div>
    );
  }

  const onJump = (j: Jump) => {
    if (j.kind === "file") openFile(j.path);
    else if (j.kind === "symbol") openFile(j.path, j.line);
    else if (j.kind === "module") focusModule(j.id);
    else if (j.kind === "branch") showBranch(j.name, j.base);
    else {
      const t = overview?.topics.find((x) => x.id === j.id);
      if (t) goTopic(t);
    }
  };

  /** A module's (or group's) beacon picked: fly there, or with `how`, isolate, take out or show only it. */
  const pickModule = (id: string, how?: "isolate" | "exclude" | "solo") => {
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
  };

  /** The ring's actions for what the finger is held on. */
  const ringFor = (hit: TouchHit): { title?: string; detail?: string; items: RingItem[] } => {
    if (hit.kind === "file") {
      const name = hit.path.split("/").pop()!;
      return {
        title: name,
        detail: hit.path,
        items: [
          { label: "Open", run: () => openFile(hit.path) },
          { label: "Ask about it", run: () => askNavigator(`What is ${hit.path} for, and how does it fit in?`) },
          { label: "Note", run: () => setNoteEdit({ target: { kind: "file", path: hit.path } }) },
          { label: "Hide", run: () => hide([hit.path], name) },
          { label: "Fly here", run: () => space.current?.flyTo(hit.path) },
        ],
      };
    }
    if (hit.kind === "module") {
      return {
        title: hit.label,
        detail: [hit.files ? `${hit.files} file${hit.files === 1 ? "" : "s"}` : "", hit.summary ?? ""].filter(Boolean).join(" · "),
        items: [
          { label: "Fly there", run: () => pickModule(hit.id) },
          { label: "Show only", run: () => pickModule(hit.id, "solo") },
          { label: "Ask about it", run: () => askNavigator(`Explain ${hit.label}: what it does and how it works.`) },
          { label: "Hide", run: () => pickModule(hit.id, "exclude") },
        ],
      };
    }
    const tilt = "DeviceOrientationEvent" in window;
    return {
      items: [
        { label: "Whole map", run: toOverview },
        { label: "Back", run: back },
        ...(tilt
          ? [
              {
                label: tilting ? "Stop tilting" : "Tilt to look",
                run: () =>
                  void space.current?.setTilt(!tilting).then((on) => {
                    setTilting(on);
                    if (!tilting && !on) setToast({ text: "This device didn't allow motion sensing" });
                  }),
              },
            ]
          : []),
        { label: minimal ? "Show controls" : "Hide controls", run: () => setMinimal((m) => !m) },
        { label: "Forward", run: forward },
      ],
    };
  };
  const onGesture = (g: TouchGesture) => {
    if (g === "back") back();
    else if (g === "forward") forward();
    else if (g === "overview") toOverview();
    else if (g === "flat") toOverview(true);
    else setMinimal((m) => !m);
  };
  /** Two fingers spread on a module's beacon show only it; pinched shut on one, everything again. */
  const onSpread = (id: string, way: "open" | "close") => {
    const ins = (filter.isolate ?? []).filter((i) => !i.exclude);
    if (way === "open") {
      if (ins.length === 1 && ins[0].kind === "module" && ins[0].id === id) return false;
      pickModule(id, "solo");
      return true;
    }
    if (!ins.length) return false;
    // As Esc's last step: what you hid by hand stays hidden.
    setFilter((f) => {
      const kept = f.isolate?.filter((i) => i.exclude);
      return { ...f, isolate: kept?.length ? kept : undefined };
    });
    return true;
  };

  const activeFrame = frames.find((f) => f.id === frameId);
  const showIntro = !minimal && !introDone && tour === null && !file && !frameId;
  const showDestinations = !minimal && introDone && tour === null && !file && !frameId && !emphasis.length && !!overview?.topics.length;

  return (
    <div className="relative h-full overflow-hidden bg-night">
      {graph && fontsReady && (
        <Space
          ref={desk}
          graph={mapGraph!}
          overview={overview}
          grouping={grouping}
          overlays={shownOverlays}
          heat={branchMap ? branchHeat : heat}
          delta={shownTime?.delta ?? null}
          pinned={!!range || !!branchMap}
          // The history panel (up to 380px, or 46% of the view) and the bar under it.
          insetBottom={historyOpen ? (Math.min(380, window.innerHeight * 0.46) + 90) / window.innerHeight : branchMap && !story ? 260 / window.innerHeight : 0}
          couplings={couplings}
          tuning={tuning}
          visible={deskVisible.current}
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
          onPickModule={pickModule}
          onOpenImport={(from, line) => openFile(from, line)}
          onHideOverlay={(id) => {
            const g = overlays.find((o) => o.id === id);
            void post("/api/overlays", { action: "update", id, visible: false });
            setToast({
              text: `Hid the marker ${g?.label ?? ""} — it's still in Markers`,
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
          onHold={(hit, x, y, pointerId) => setHeld({ hit, x, y, pointerId })}
          onGesture={onGesture}
          onSpread={onSpread}
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

      {touchFirst() && historyOpen && !story && listed.length > 1 && (() => {
        const i = listed.findIndex((c) => c.sha === (range ? (cursor.current ?? range.to) : null));
        return (
          <EdgeScrub
            value={i < 0 ? 1 : 1 - i / (listed.length - 1)}
            stepOf={(f) => Math.round((1 - f) * (listed.length - 1))}
            labelOf={(f) => {
              const c = commitAt(f);
              return c.worktree ? "Uncommitted changes" : `${c.short} · ${new Date(c.at).toLocaleDateString()} · ${c.subject}`;
            }}
            onScrub={scrubHistory}
          />
        );
      })()}

      {held && <TouchRing key={`${held.pointerId}-${held.x}-${held.y}`} x={held.x} y={held.y} pointerId={held.pointerId} {...ringFor(held.hit)} onClose={() => setHeld(null)} />}

      {touchHint && (
        <div className="glass rise absolute left-1/2 top-[18%] z-30 w-[min(420px,calc(100%-32px))] -translate-x-1/2 rounded-2xl p-4">
          <p className="font-cond text-[19px] font-semibold">Flying by touch</p>
          <ul className="mt-2 space-y-1.5 text-[14px] leading-snug text-text/90">
            <li>Two fingers pinch to zoom, drag to pan, or twist to spin the sky. Whatever they start doing, they keep doing.</li>
            <li>Spread two fingers on a module to open it up on its own. Pinch it shut for everything again.</li>
            <li>Press and hold on a file, a module or open sky for its actions. Slide to one and lift.</li>
            <li>Double-tap open sky to see the whole map, or lay the tablet flat to see it from above.</li>
            <li>Swipe with three fingers: sideways for back and forward, down for the whole map, up to hide the controls.</li>
          </ul>
          <button onClick={() => setTouchHint(false)} className="mt-3 rounded-lg bg-course px-4 py-1.5 font-cond text-[15px] font-semibold text-night">
            Got it
          </button>
        </div>
      )}

      {shelfOpen && (
        <div className="absolute inset-0 z-30 flex items-start justify-center bg-night/60 px-4 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && setShelfOpen(false)}>
          <div className="glass w-full max-w-[520px] rounded-2xl p-4" onKeyDown={(e) => e.key === "Escape" && setShelfOpen(false)}>
            <p className="mb-3 font-cond text-[20px] font-semibold">Open a GitHub repo</p>
            <Shelf autoFocus onOpened={() => setShelfOpen(false)} />
          </div>
        </div>
      )}

      {/* Instruments */}
      <div className={`${minimal ? "hidden " : ""}pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2`}>
        {/* The intro shows the name large; switching away stays possible while it charts. */}
        {showIntro && state.library && (
          <div className="pointer-events-auto">
            <button onClick={() => setShelfOpen((v) => !v)} className="text-[12px] text-muted hover:text-course" title="Open another GitHub repo">
              Switch repo
            </button>
          </div>
        )}
        {!showIntro && (
          <div className="pointer-events-auto">
            <button onClick={toOverview} className="text-left" title="Back to the whole map (o)">
              <span className="font-cond text-[24px] font-semibold leading-none">{state.repo?.name}</span>
              {state.repo?.branch && <span className="ml-2 font-mono text-[11.5px] text-muted">{state.repo.branch}</span>}
            </button>
            {state.library && (
              <button onClick={() => setShelfOpen((v) => !v)} className="ml-2 align-[3px] text-[12px] text-muted hover:text-course" title="Open another GitHub repo">
                Switch repo
              </button>
            )}
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
            {state.agentsOn && (
              <Btn onClick={() => openPanel(agentsOpen ? null : "agents")}>
                Agents{state.agents.length ? ` (${state.agents.filter((a) => a.status === "working" || a.status === "starting").length || state.agents.length})` : ""}
              </Btn>
            )}
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
              title="Mark files on the map without moving them (m)"
              className={`rounded-md px-2.5 py-0.5 text-[13px] ${groupsOpen ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
            >
              Markers{overlays.length ? ` (${overlays.length})` : ""}
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
        {agentsOpen && state && (
          <AgentsPanel
            agents={state.agents}
            onShow={(a) => {
              setAgentsOpen(false);
              showBranch(a.branch, a.base === "HEAD" ? a.baseSha : a.base, a.id);
            }}
            onClose={() => setAgentsOpen(false)}
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
            onDiff={(branch, base) => {
              setStoriesOpen(false);
              showBranch(branch, base);
            }}
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
            frames={frames}
            focusCount={emphasis.length}
            focusLabel={focusLabel}
            filterCount={visible?.size ?? null}
            busy={state.busy}
            onCreate={({ label, from, pattern }) =>
              void post("/api/overlays", {
                action: "add",
                label,
                // How the marker was made is why its files are in it.
                ...(from === "focus"
                  ? { paths: emphasis, why: `was in focus${focusLabel ? `: ${focusLabel}` : ""}` }
                  : from === "filter"
                    ? { paths: [...(visible ?? [])], why: `in the filter: ${describe(filter)}` }
                    : { include: pattern!.split(",").map((x) => x.trim()).filter(Boolean) }),
              })
            }
            onAskNavigator={(what) =>
              askNavigator(`Mark on the map, without reorganizing it: ${what}. Use add_markers, then tell me what you marked and why.`)
            }
            onToggle={(id, v) => void post("/api/overlays", { action: "update", id, visible: v })}
            onRemove={(id) => void post("/api/overlays", { action: "delete", id })}
            onAnswer={markersOf}
            onFly={(g) => focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label)}
            onClose={() => setGroupsOpen(false)}
          />
        )}
        {!showIntro && !filterOpen && !groupsOpen && !notesOpen && !storiesOpen && !answersOpen && !agentsOpen && legend && !file && (
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
        {state.remote && (state.remote.behind > 0 || state.remote.error) && <RemoteBanner remote={state.remote} />}
        {state.stale && (
          <div className={`glass pointer-events-auto rounded-md px-3 py-1.5 text-[12.5px] text-text/90 ${changesOpen ? "w-[min(440px,calc(100vw-2rem))]" : "max-w-[340px]"}`}>
            The code has changed since this map was charted. Your groupings, markers and answers are kept.{" "}
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
            title="Keep these files as a marker on the map"
          >
            Save as marker
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
            {toast.undo && (
              <button
                onClick={() => {
                  toast.undo?.();
                  setToast(null);
                }}
                className="text-course hover:underline"
              >
                Undo
              </button>
            )}
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
            markers={overlays.filter((o) => o.frameId === activeFrame.id)}
            onMarkers={(action) => markersOf(activeFrame.id, action)}
            onFlyMarker={(g) => focus(visible ? g.paths.filter((p) => visible.has(p)) : g.paths, g.label)}
          />
        </div>
      )}

      {story && (() => {
        const s = stories.find((x) => x.id === story.id);
        if (!s) return null;
        // Voiced with other settings (or not at all): the server is voicing it again, so wait for that.
        // (The key is server/tts.ts's voiceKey.)
        const ss = s.voice ?? state.storySettings;
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
            onDiff={s.branch ? () => showBranch(s.branch!.name, s.branch!.base) : undefined}
            onClose={() => {
              setLastStory({ id: story.id, beat: storyAt.beat });
              setStory(null);
            }}
            startAt={story.startAt}
            control={storyCtl}
            onBeat={(beat, playing) => setStoryAt({ beat, playing })}
          />
        );
      })()}

      {parked && !story && (() => {
        const s = stories.find((x) => x.id === parked.id);
        if (!s) return null;
        return (
          <div className="pointer-events-none absolute bottom-[92px] left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5">
            <button
              onClick={() => {
                panels.current.frame = true;
                setFrameId(null);
                setStory({ id: parked.id, queue: parked.queue, autoplay: true, startAt: { beat: parked.beat, ms: parked.ms } });
                setParked(null);
              }}
              className="glass pointer-events-auto rounded-full px-3.5 py-1 text-[13px]"
              title="Back to the story, where you paused it"
            >
              <span className="text-course">▶</span> Resume “{s.title}”{" "}
              <span className="ml-1 text-muted">
                beat {parked.beat + 1} of {s.beats.length}
              </span>
            </button>
            <button
              onClick={() => {
                setLastStory({ id: parked.id, beat: parked.beat });
                setParked(null);
              }}
              className="glass pointer-events-auto rounded-full px-2.5 py-1 text-[13px] text-muted hover:text-text"
              aria-label="Don't resume the story"
            >
              ✕
            </button>
          </div>
        );
      })()}

      {branchDiff && (
        <BranchDiff
          branch={branchDiff.branch}
          base={branchDiff.base}
          agent={branchDiff.agent}
          onLight={(paths, label) => {
            setBranchDiff(null);
            focus(paths, label);
          }}
          onExplain={(branch, base) => {
            setBranchDiff(null);
            // The new story opens itself as it's written (see the stories effect).
            void post("/api/stories/branch", { branch, base, settings: "mine" });
          }}
          onClose={() => {
            setBranchDiff(null);
            if (location.search) window.history.replaceState(window.history.state, "", location.pathname);
          }}
        />
      )}

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
        {branchMap && !story && (
          <BranchMapBar
            sum={branchSum}
            error={branchError}
            loading={!!branchSum && !branchTime}
            working={watched?.status === "working" || watched?.status === "starting"}
            onMapPaths={visible ?? onMap}
            onFly={(p) => focus([p], p.split("/").pop())}
            onCodeDiff={() => branchSum && setBranchDiff({ branch: branchSum.branch, base: branchSum.base, agent: branchSum.agent?.id })}
            onExplain={() => branchSum && void post("/api/stories/branch", { branch: branchSum.branch, base: branchSum.base, settings: "mine" })}
            onClose={closeBranch}
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
          <div className="flex min-w-0 flex-1 items-end justify-end gap-2">
            <XRButtons xr={xr} />
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

