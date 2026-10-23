import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryRepo } from "../../shared/types";
import { fetchFile, type FileData } from "../lib/api";
import type { Mode } from "./engine";
import type { MapHit, MapInput, MapStyle } from "./map";
import { splitList } from "../../shared/filter";
import type { Actions, AppActions, AppModel, Model } from "./model";
import type { Room, StorySource } from "./room";
import { suggest } from "./suggest";

/**
 * The headset, as part of the desktop app. Finds out whether a headset is
 * there (a Quest's browser, or a PC with Link or SteamVR connected) and, only
 * then, loads the room. While you're in it, the room draws the desktop's own
 * state: the same open file, focus, answers and filter, so you can go in and
 * out without losing your place. The menu, keyboard and AR placement are the
 * headset's own; everything else calls back into the desktop app.
 */

export type TagLine = { text: string; color?: string; bold?: boolean; mono?: boolean };

export type AppHandlers = {
  onPick: (hit: MapHit) => void;
  describe: (hit: MapHit) => TagLine[];
  onBackground: () => void;
  onButton: (b: "back" | "forward" | "voice" | "overview" | "frame") => void;
};

export type XRFeed = {
  model: AppModel;
  actions: AppActions;
  handlers: AppHandlers;
  map: MapInput | null;
  style: MapStyle;
  story: StorySource;
};

export type XR = ReturnType<typeof useXR>;

/**
 * Reloaded from the headset's menu: the mode to go back into. Only where the
 * browser grants a session across the reload without a fresh press (the
 * Quest's can, for a same-site load); elsewhere you're on the flat page, a
 * press of VR or Passthrough away.
 */
const RESUME = "constellate.xrResume";
let resumeTo: "vr" | "ar" | null = null;
let granted = false;
let onGranted: (() => void) | null = null;
try {
  const m = sessionStorage.getItem(RESUME);
  sessionStorage.removeItem(RESUME);
  if (m === "vr" || m === "ar") resumeTo = m;
} catch {
  // No storage: nothing to resume.
}
// Listened for straight away: the grant can come before React has mounted.
if (resumeTo) navigator.xr?.addEventListener("sessiongranted", () => ((granted = true), onGranted?.()), { once: true });

/** The map's look, with the focus's inner rings marked so only links reaching in from it light. */
function styled(style: MapStyle, f: { paths: string[]; core: string[] } | null): MapStyle {
  return f && style.emphasis === f.paths ? { ...style, core: f.core } : style;
}

export function useXR(feed: XRFeed) {
  const [support, setSupport] = useState({ vr: false, ar: false });
  const [room, setRoom] = useState<Room | null>(null);
  const [mode, setMode] = useState<Mode>("flat");
  const [placing, setPlacing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [table, setTable] = useState(false);
  const [inputs, setInputs] = useState({ hands: false, controllers: false });
  /** A focus made with the right stick: what it's on, how wide, and the files it lit. */
  const [focusAt, setFocusAt] = useState<{ hit: MapHit; depth: number; label: string; count: number; more: boolean; paths: string[]; core: string[] } | null>(null);
  const focusRef = useRef(focusAt);
  focusRef.current = focusAt;
  const [keyboard, setKeyboard] = useState<Model["keyboard"]>(null);
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [repos, setRepos] = useState<LibraryRepo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const roomRef = useRef<Room | null>(null);
  const presenting = mode !== "flat";

  // Is there a headset? Asked again whenever one is plugged in or taken away.
  useEffect(() => {
    const xr = navigator.xr;
    if (!xr) return;
    let live = true;
    const check = () =>
      void Promise.all([xr.isSessionSupported("immersive-vr").catch(() => false), xr.isSessionSupported("immersive-ar").catch(() => false)]).then(
        ([vr, ar]) => live && setSupport({ vr, ar }),
      );
    check();
    xr.addEventListener("devicechange", check);
    return () => {
      live = false;
      xr.removeEventListener("devicechange", check);
    };
  }, []);
  // There is one: fetch the room now, so pressing the button goes straight in.
  useEffect(() => {
    if (support.vr || support.ar) void import("./room");
  }, [support.vr, support.ar]);

  /* ------------------------------- actions ------------------------------- */

  const menuRef = useRef(menuOpen);
  menuRef.current = menuOpen;
  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;

  const own = useRef<Partial<Actions>>({});
  own.current = {
    toggleMenu: () => setMenuOpen((o) => !o),
    openKeyboard: (m, target, initial) => {
      setMenuOpen(false);
      setKeyboard({ mode: m, target, initial });
    },
    closeKeyboard: () => setKeyboard(null),
    submitKeyboard: (text) => {
      const kb = keyboardRef.current;
      const a = feedRef.current.actions;
      setKeyboard(null);
      if (kb?.mode === "include" || kb?.mode === "exclude") {
        // Hand-edited, the navigator's name and file set no longer describe what's shown (as on the desktop).
        const f = feedRef.current.model.mapFilter;
        a.setMapFilter({ ...f, label: undefined, paths: undefined, [kb.mode]: splitList(text) });
      } else if (kb?.mode === "view") {
        // The current filter, under this name; the same name replaces it (as on the desktop).
        const { mapFilter, savedFilters } = feedRef.current.model;
        const name = text.trim();
        if (name) a.setSavedFilters([...savedFilters.filter((v) => v.name !== name), { name, filter: mapFilter }]);
      } else if (kb?.mode === "note" && kb.target) a.addNote(kb.target, text);
      else if (kb?.mode === "repo") a.openPath(text);
      else if (kb?.mode === "agent") a.startAgent(text);
      else if (text.startsWith("story:")) a.writeStory(text.slice(6));
      else a.ask(text);
    },
    suggest: (q) => suggest(feedRef.current.map?.graph ?? null, feedRef.current.model.overview, q),
    jump: (j) => {
      const a = feedRef.current.actions;
      setKeyboard(null);
      if (j.kind === "module" && j.id) a.focusModule(j.id);
      else if (j.path) a.openFile(j.path, j.line);
    },
    enter: (m) => void enter(m),
    exitXR: () => roomRef.current?.engine.exit(),
    reload: () => {
      const m = roomRef.current?.engine.mode;
      try {
        if (m === "vr" || m === "ar") sessionStorage.setItem(RESUME, m);
      } catch {
        // No storage: it reloads all the same, to the flat page.
      }
      location.reload();
    },
    placeMap: () => {
      setMenuOpen(false);
      setPlacing(true);
      roomRef.current?.engine.startPlacing();
    },
    recenterPanels: () => roomRef.current?.engine.recenterPanels(),
    toggleTune: () => {
      setMenuOpen(false);
      setTuneOpen((o) => !o);
    },
    toggleHints: () => {
      setHintsOpen((o) => !o);
      if (!feedRef.current.model.settings.hintsSeen) feedRef.current.actions.setXR({ hintsSeen: true });
    },
    relayout: () => roomRef.current?.engine.map.reheat(),
    toggleFilter: () => {
      setMenuOpen(false);
      setFilterOpen((o) => !o);
    },
    toggleViews: () => {
      setMenuOpen(false);
      setViewsOpen((o) => !o);
    },
    focusWider: () => {
      const f = focusRef.current;
      if (f?.more) focusOn(f.hit, f.depth + 1);
    },
    focusNarrower: () => {
      const f = focusRef.current;
      if (f && f.depth > 0) focusOn(f.hit, f.depth - 1);
    },
    focusOnly: () => {
      const f = focusRef.current;
      const { mapFilter } = feedRef.current.model;
      const { setMapFilter } = feedRef.current.actions;
      if (f && mapFilter.paths === f.paths) {
        const was = beforeOnly.current;
        setMapFilter({ ...mapFilter, paths: was?.paths, label: was?.label });
      } else if (f) {
        beforeOnly.current = mapFilter;
        setMapFilter({ ...mapFilter, paths: f.paths, label: f.label });
      }
    },
    // Going somewhere from the menu closes it, so you can see where you went.
    showFrame: (id) => {
      setMenuOpen(false);
      feedRef.current.actions.showFrame(id);
    },
    playStory: (id) => {
      setMenuOpen(false);
      feedRef.current.actions.playStory(id);
    },
    startTour: () => {
      setMenuOpen(false);
      feedRef.current.actions.startTour();
    },
  };
  /** The filter from before "Show only these", to go back to. */
  const beforeOnly = useRef<AppModel["mapFilter"] | null>(null);
  /** Focus on a body with `depth` rings of its connections. */
  const focusOn = (hit: MapHit, depth: number) => {
    const r = feedRef.current.actions.focusAround(hit, depth);
    setFocusAt(r.count ? { hit, depth, ...r } : null);
  };
  // Focused some other way since (a pick, the menu, back): the bar goes.
  const emphasis = feed.style.emphasis;
  useEffect(() => {
    if (focusAt && emphasis !== focusAt.paths) setFocusAt(null);
  }, [emphasis, focusAt]);

  /** Every action, current: the headset's own first, then the desktop's. */
  const actions = useMemo(
    () =>
      new Proxy({} as Actions, {
        get: (_t, k: string) => (...args: unknown[]) => {
          const f = (own.current[k as keyof Actions] ?? feedRef.current.actions[k as keyof AppActions]) as (...a: unknown[]) => unknown;
          return f(...args);
        },
      }),
    [],
  );

  /* ------------------------------- sessions ------------------------------- */

  const enter = useCallback(
    async (m: "vr" | "ar") => {
      setError(null);
      setEntering(true);
      try {
        let r = roomRef.current;
        if (!r) {
          const { Room } = await import("./room");
          r = new Room(
            {
              // A module: first its own files and the links between them;
              // pressed again, the files it talks to as well.
              onPick: (h) => {
                if (h.kind !== "module") return feedRef.current.handlers.onPick(h);
                const f = focusRef.current;
                const same = f && f.hit.kind === h.kind && f.hit.id === h.id;
                focusOn(h, same && f.depth === 0 && f.more ? 1 : 0);
              },
              describe: (h) => feedRef.current.handlers.describe(h),
              onBackground: () => (menuRef.current ? setMenuOpen(false) : feedRef.current.handlers.onBackground()),
              onButton: (b) => {
                if (b === "menu") return setMenuOpen((o) => !o);
                if (b === "ask") return setKeyboard((k) => (k ? null : { mode: "ask" }));
                feedRef.current.handlers.onButton(b);
              },
              onMode: (md) => {
                setMode(md);
                if (md === "flat") {
                  setMenuOpen(false);
                  setTuneOpen(false);
                  setHintsOpen(false);
                  setFilterOpen(false);
                  setViewsOpen(false);
                  setKeyboard(null);
                  setPlacing(false);
                } else if (!feedRef.current.model.settings.hintsSeen) setHintsOpen(true);
              },
              onPlaced: () => setPlacing(false),
              // The right stick on a body: focus on it; again on the same one, a ring wider.
              onFocus: (h) => {
                const f = focusRef.current;
                const same = f && f.hit.kind === h.kind && f.hit.id === h.id;
                if (same && !f.more) return;
                focusOn(h, same ? f.depth + 1 : 0);
              },
              onFlick: (h) => feedRef.current.actions.hideHit(h),
              onSelect: (paths, how) => feedRef.current.actions.focusPaths(paths, `${paths.length} file${paths.length > 1 ? "s" : ""} ${how === "lasso" ? "you looped" : "you framed"}`),
              onInputs: setInputs,
              onTable: setTable,
              // In you go: to what you were looking at on the desktop, or the whole map.
              onEntered: () => feedRef.current.actions.frameSelection(),
            },
            actions,
            () => feedRef.current.story(),
          );
          roomRef.current = r;
          setRoom(r);
          // For poking at the room from devtools, and for scripted checks: ?debug.
          if (import.meta.env.DEV || location.search.includes("debug")) (window as unknown as { __xr: unknown }).__xr = r.engine;
        }
        const f = feedRef.current;
        r.engine.setSettings(f.model.settings);
        r.setStyle(styled(f.style, focusRef.current));
        if (f.map) r.setMap(f.map);
        await r.engine.enter(m);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setEntering(false);
      }
    },
    [actions],
  );

  // Back in after a reload from the headset, once the browser grants it.
  useEffect(() => {
    if (!resumeTo) return;
    const go = () => {
      const m = resumeTo;
      resumeTo = onGranted = null;
      if (m) void enter(m);
    };
    if (granted) return go();
    onGranted = go;
    return () => {
      onGranted = null;
    };
  }, [enter]);

  /* ---------------------------- feeding the room ---------------------------- */

  // The map is only kept up to date while you're in the headset; going in sends it fresh.
  useEffect(() => {
    if (room && presenting && feed.map) room.setMap(feed.map);
  }, [room, presenting, feed.map]);
  useEffect(() => {
    if (room && presenting) room.setStyle(styled(feed.style, focusAt));
  }, [room, presenting, feed.style, focusAt]);
  useEffect(() => {
    room?.engine.setSettings(feed.model.settings);
  }, [room, feed.model.settings]);

  const path = feed.model.file?.path;
  useEffect(() => {
    if (!presenting || !path) return setFileData(null);
    let live = true;
    void fetchFile(path).then((d) => live && setFileData(d));
    return () => {
      live = false;
    };
  }, [presenting, path]);
  useEffect(() => {
    if (presenting && menuOpen && feed.model.library) void fetch("/api/repos").then((r) => (r.ok ? r.json() : [])).then(setRepos).catch(() => {});
  }, [presenting, menuOpen, feed.model.library]);

  useEffect(() => {
    if (!room || !presenting) return;
    room.update({ ...feed.model, fileData, story: null, repos, mode, canVR: support.vr, canAR: support.ar, placing, menuOpen, keyboard, tuneOpen, hintsOpen, filterOpen, viewsOpen, table, inputs, focus: focusAt && { label: focusAt.label, depth: focusAt.depth, count: focusAt.count, more: focusAt.more, only: feed.model.mapFilter.paths === focusAt.paths } });
  });

  /* --------------------------- the desktop's camera --------------------------- */

  /** Whether the headset is showing the map right now (read at call time, not render time). */
  const live = () => !!roomRef.current && roomRef.current.engine.mode !== "flat";
  const camera = useMemo(
    () => ({
      flyTo: (p: string) => live() && roomRef.current!.engine.flyTo(p),
      focus: (ps: string[]) => live() && roomRef.current!.engine.focus(ps),
      overview: () => live() && roomRef.current!.engine.overview(),
      pulse: (p: string) => live() && roomRef.current!.engine.map.pulse(p),
    }),
    [],
  );

  return { support, presenting, mode, entering, error, enter, camera };
}
