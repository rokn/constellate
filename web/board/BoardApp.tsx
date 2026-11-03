import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARCH_KINDS,
  COLORS,
  STATUSES,
  colorOf,
  defaultsFor,
  nameOf,
  newId,
  type Board,
  type BoardCommand,
  type BoardScreen,
  type BoardSummary,
  type Item,
  type ItemKind,
  type Snap,
  type Vec3,
} from "../../shared/board";
import { useSharedVoice } from "../shell/voice";
import { ProjectBar } from "../shell/ProjectBar";
import { goBoard, goCode, navigate, reloadProject } from "../shell/nav";
import { boardUrl } from "../../shared/project";
import { BoardClient } from "./client";
import type { Ctl, Tool } from "./ctl";
import { attachDesktop, dropPoint } from "./desktop";
import { LOOK, STATUS_COLOR } from "./look";
import { BoardScene, type Mode } from "./scene";
import type { XRInput, XRPlugin } from "./xr";
import { RoomXR } from "./room";
import { ScrubXR } from "./scrub";
import { SnapsXR } from "./snaps";
import { GesturesXR } from "./gestures";
import { GuideXR } from "./guide";
import { inside } from "./items";
import { TranscriptXR } from "./transcript";
import { TranscriptLog, useTranscriptOpen } from "../components/TranscriptLog";
import { TypeXR } from "./typing";
import { ShelfXR } from "./shelf";
import "./board.css";
import { TunePanel } from "./TunePanel";
import { fromClip, toClip, toMarkdown } from "../../shared/exchange";
import { cameraPhoto, pictureOf, sketchPicture, type Picture } from "./imports";
import { Breadcrumbs, ExchangeDialog, FindPalette, HistoryPanel, LayersPopover, LibraryList, LinkInspector, PlayerBar, PreviewBar, TemplateList } from "./panels";
import type { Layers } from "./fx";
import { LIBRARY, findPrefab } from "../../shared/holoLibrary";
import { TEMPLATE_NAMES, layTemplate } from "../../shared/templates";
import * as THREE from "three";
import { applyPreset, num, on, onTune, setTune, tuneChanged } from "./tune";
import { BUILT_IN_PRESETS, type BoardPreset } from "../../shared/boardTune";

/**
 * The workshop page: /board, or /board/<id>. The scene fills the window; the
 * desktop's controls float over it. In the headset the scene carries its own
 * panels (see xr.ts), so everything here hides while you're in.
 */

const ASSISTANT = "Jarvis";
const LIBRARY_NAMES = LIBRARY.map((p) => p.name);
const TEMPLATE_LIST = TEMPLATE_NAMES;
const KIND_NAME: Partial<Record<ItemKind, string>> = { function: "Lambda", holo: "Hologram" };
const kindName = (k: ItemKind) => KIND_NAME[k] ?? k[0].toUpperCase() + k.slice(1);
const INK_COLORS = ["cyan", "amber", "magenta", "green", "white"];

const EXAMPLES = [
  "Design the architecture of a food delivery app: mobile clients, an API gateway, order, payment and courier services, Postgres, a Kafka bus",
  "Build a hologram of a quadcopter drone I can pull apart",
  "Lay out a three-phase roadmap for launching a developer SDK, with risks as notes",
  "Sketch an event-driven pipeline that ingests IoT telemetry into a data lake",
];

/**
 * A project's boards. The shell says which board (the address); this keeps
 * the project's list of boards for the shelf, the markers and switching.
 */
export function BoardApp({ projectId, boardId }: { projectId: string; boardId: string }) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const loadBoards = useCallback(async () => {
    const r = await fetch(`/api/boards?project=${encodeURIComponent(projectId)}`);
    const list = (await r.json()) as BoardSummary[];
    setBoards(list);
    void reloadProject();
    return list;
  }, [projectId]);
  useEffect(() => void loadBoards().catch(() => {}), [loadBoards]);
  const open = useCallback((id: string) => navigate(boardUrl(projectId, id)), [projectId]);
  // One workshop for every board: switching boards keeps the scene (and a headset session) alive.
  return <Workshop projectId={projectId} boardId={boardId} boards={boards} open={open} reloadBoards={loadBoards} />;
}

function Workshop({ projectId, boardId, boards, open, reloadBoards }: { projectId: string; boardId: string; boards: BoardSummary[]; open: (id: string) => void; reloadBoards: () => Promise<BoardSummary[]> }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BoardScene | null>(null);
  const xrRef = useRef<XRInput | null>(null);
  const client = useMemo(() => new BoardClient(boardId), [boardId]);
  const clientRef = useRef(client);
  clientRef.current = client;
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const [board, setBoard] = useState<Board | null>(null);
  const [selected, setSelectedState] = useState<string[]>([]);
  const [tool, setToolState] = useState<Tool>("select");
  const [inkColor, setInkColor] = useState("cyan");
  const [mode, setMode] = useState<Mode>("flat");
  const [xr, setXr] = useState({ vr: false, ar: false });
  const [xrError, setXrError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [focus, setFocus] = useState<Vec3>([0, 0, 0]);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [presets, setPresets] = useState<BoardPreset[]>([]);
  const presetsRef = useRef(presets);
  presetsRef.current = presets;
  const [tuneKey, setTuneKey] = useState(0);
  useEffect(() => onTune(() => setTuneKey((n) => n + 1)), []);
  const loadPresets = useCallback(() => {
    void fetch("/api/board/presets")
      .then((r) => r.json())
      .then((p: BoardPreset[]) => {
        setPresets(p);
        xrRef.current?.setPresets([...BUILT_IN_PRESETS, ...p]);
      })
      .catch(() => {});
  }, []);
  useEffect(loadPresets, [loadPresets]);
  const askRef = useRef<HTMLInputElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [layers, setLayers] = useState<Layers>({ hide: [], isolate: null });
  const [preview, setPreview] = useState<{ id: string; label: string; board: Board } | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [selLink, setSelLink] = useState<string | null>(null);
  const [playCaption, setPlayCaption] = useState<{ text: string; title?: string; step: number; of: number } | null>(null);
  const [palTab, setPalTab] = useState<"blocks" | "holo" | "plans">("blocks");
  const [tiersOn, setTiersOn] = useState(false);
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const selRef = useRef(selected);
  selRef.current = selected;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const inkRef = useRef(inkColor);
  inkRef.current = inkColor;

  const setSelected = useCallback((ids: string[]) => {
    setSelectedState(ids);
    if (ids.length) setSelLink(null);
    sceneRef.current?.setSelected(ids);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tuned = useMemo(() => tuneChanged(), [tuneKey]);
  const screen: BoardScreen = useMemo(() => ({ boardId, selected, tool, mode, focus, tune: tuned }), [boardId, selected, tool, mode, focus, tuned]);
  const voiceSettings = useMemo(() => ({ voiceSpeed: num("voiceSpeed"), eagerness: num("eagerness"), interrupt: on("interrupt") }), [tuneKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The project's one voice (it carries on into the Code view): this view hands it the board's screen.
  const voice = useSharedVoice("board", {
    screen,
    onCommand: () => {},
    onDictated: (text) => dictatedRef.current(text),
    interrupt: on("interrupt"),
    ready: true,
    audioOptions: { loopback: on("echoLoopback"), echoGuard: on("echoGuard"), talkOverDb: num("talkOverDb"), confirmMs: num("bargeConfirmMs"), prebufferMs: num("voicePrebufferMs") },
    volume: num("voiceVolume") * (mode === "flat" ? 1 : 1.6),
    idleMinutes: num("idleMinutes"),
    settings: voiceSettings,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [logOpen, setLogOpen] = useTranscriptOpen("workshop.log");

  const sendAsk = useCallback(
    (text: string, images?: Picture[]) => {
      const t = text.trim();
      if (!t) return;
      const s = sceneRef.current;
      void fetch("/api/board/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: boardId, request: t, screen: { ...screen, focus: s?.focusPoint() ?? focus }, images }),
      });
    },
    [boardId, screen, focus],
  );
  const sendAskRef = useRef(sendAsk);
  sendAskRef.current = sendAsk;
  const insideRef = useRef<(id: string) => void>(() => {});
  const runRef = useRef<(a: string, from?: string) => void>(() => {});
  const previewFnRef = useRef<(v: { id: string; label: string; board: Board } | null) => void>(() => {});
  const reloadRef = useRef(reloadBoards);
  reloadRef.current = reloadBoards;
  // Arrived from the code map (/board/<id>?item=<item>): that item, selected and in view.
  const wantItem = useRef(new URLSearchParams(location.search).get("item"));
  useEffect(() => {
    wantItem.current = new URLSearchParams(location.search).get("item");
  }, [boardId]);
  useEffect(() => {
    const id = wantItem.current;
    if (!id || !board || board.id !== boardId || !board.items.some((i) => i.id === id)) return;
    wantItem.current = null;
    setSelected([id]);
    setTimeout(() => sceneRef.current?.focus([id]), 300);
    history.replaceState(history.state, "", location.pathname);
  }, [board, boardId, setSelected]);

  // The markers on items with a board inside say how much is in there: counts from the board list,
  // fetched again on every switch (coming back up, what was made inside shows).
  inside.count = (id) => boardsRef.current.find((b) => b.id === id)?.items;
  useEffect(() => {
    void reloadRef.current();
  }, [boardId]);
  useEffect(() => {
    sceneRef.current?.refreshInside();
  }, [boards]);
  /** More of the headset (history scrubbing, snapshots, gestures), plugged in when the hands are made. */
  const xrPluginMakers = useRef<((x: XRInput) => XRPlugin)[]>([]);
  /** Actions the later parts of the page add (sketches, photos, snapshots, …). */
  const extraActionsRef = useRef<(a: string, from?: string) => void>(() => {});
  const dictateRef = useRef<(id: string | null) => void>(() => {});
  const dictatedRef = useRef<(text: string) => void>(() => {});
  /** Commands the page itself handles beyond the scene's (actions, dictation, sketches…). */
  const commandRef = useRef<(c: BoardCommand) => void>(() => {});
  const openRef = useRef(open);
  openRef.current = open;

  /** Everything the desktop and the headset do to the board. */
  const ctl: Ctl = useMemo(
    () => ({
      get client() {
        return clientRef.current;
      },
      selected: () => selRef.current,
      select: (ids, additive) => {
        const cur = selRef.current;
        if (!additive) return setSelected(ids);
        const next = new Set(cur);
        for (const id of ids) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        setSelected([...next]);
      },
      tool: () => toolRef.current,
      setTool: (t) => setToolState(t),
      add: (kind, pos, extra) => {
        const id = newId();
        const item = { ...defaultsFor(kind), ...extra, id, kind, pos } as Item;
        clientRef.current.apply([{ op: "add", items: [item] }]);
        return id;
      },
      remove: (ids) => {
        for (const id of ids) {
          const v = sceneRef.current?.views.get(id);
          if (v) v.dying = 1;
        }
        clientRef.current.apply([{ op: "remove", ids }]);
        setSelected(selRef.current.filter((x) => !ids.includes(x)));
      },
      link: (from, to, extra) => clientRef.current.apply([{ op: "link", links: [{ id: newId("l"), from, to, style: "sync", ...extra }] }]),
      edit: (id) => setEditing(id),
      toggleVoice: () => {
        const v = voiceRef.current;
        if (v.state === "idle" || v.state === "error") void v.start();
        else v.stop();
      },
      voiceState: () => voiceRef.current.state,
      caption: () => {
        const c = sceneRef.current?.fx.caption;
        return c ? `${c.step}/${c.of} · ${c.text}` : voiceRef.current.caption || voiceRef.current.heard;
      },
      inside: (id) => insideRef.current(id),
      up: () => {
        const p = clientRef.current.board?.parent;
        if (!p) return;
        if (p.itemId) sceneRef.current?.dive("out", p.itemId);
        openRef.current(p.boardId);
      },
      open: (id) => openRef.current(id),
      boards: () => boardsRef.current,
      selectLink: (id) => {
        setSelLink(id);
        if (id) setSelected([]);
      },
      ask: (t) => sendAskRef.current(t),
      run: (a, from) => runRef.current(a, from),
      preview: (b, label) => previewFnRef.current(b ? { id: "scrub", label: label ?? "History", board: b } : null),
      inkColor: () => colorOf(inkRef.current),
    }),
    [setSelected],
  );

  // The scene and the desktop's mouse: made once, kept across boards.
  useEffect(() => {
    const s = new BoardScene(host.current!);
    sceneRef.current = s;
    s.isHeld = (id) => clientRef.current.isHeld(id);
    (window as unknown as { __board: unknown }).__board = s;
    const offDesk = attachDesktop(s, ctl);
    s.fx.onCaption = () => setPlayCaption(s.fx.caption ? { ...s.fx.caption } : null);
    // Where this screen is, for the others: the camera on a desktop, the head and hands in a headset.
    let lastSent = "";
    const pres = setInterval(() => {
      const r3 = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];
      const client = clientRef.current;
      let p: Parameters<typeof client.sendPresence>[0];
      if (s.mode === "flat") p = { mode: "flat", head: r3(s.camera.position), look: r3(s.controls.target) };
      else {
        const cam = s.renderer.xr.getCamera();
        const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
        const look = head.clone().add(new THREE.Vector3(0, 0, -0.5).transformDirection(cam.matrixWorld));
        p = { mode: s.mode, head: r3(s.toBoard(head)), look: r3(s.toBoard(look)), hands: xrRef.current?.presenceHands().map((h) => ({ at: r3(s.toBoard(h.at)), to: h.to ? r3(s.toBoard(h.to)) : undefined })) };
      }
      const key = `${client.id}|${JSON.stringify(p)}`;
      if (key === lastSent) return;
      lastSent = key;
      client.sendPresence(p);
    }, 150);
    s.onMode = (m) => {
      setMode(m);
      if (m === "flat") xrRef.current?.left();
      else xrRef.current?.entered();
    };
    // Where they're looking, now and then, for the voice and the builder.
    const t = setInterval(() => {
      const f = s.focusPoint();
      setFocus((old) => (Math.hypot(old[0] - f[0], old[2] - f[2]) > 0.05 ? f : old));
    }, 1000);
    return () => {
      clearInterval(t);
      clearInterval(pres);
      offDesk();
      xrRef.current?.dispose();
      xrRef.current = null;
      s.dispose();
      sceneRef.current = null;
    };
  }, [ctl]); // eslint-disable-line react-hooks/exhaustive-deps

  // This board: streamed in, its commands and the others on it. A new board prints in where the last one stood.
  useEffect(() => {
    const s = sceneRef.current!;
    const offClient = client.open();
    let raf = 0;
    let booted = false;
    setSelected([]);
    setSelLink(null);
    setEditing(null);
    setPreview(null);
    previewRef.current = null;
    s.fx.stop();
    s.fx.setLayers({ hide: [], isolate: null }, null);
    setLayers({ hide: [], isolate: null });
    const offBoard = client.subscribe((b) => {
      if (!booted) {
        booted = true;
        if (!s.hasBoard()) s.fx.startBoot(b.name);
        else s.switching();
      }
      // While an old version is shown, the live board waits.
      if (!previewRef.current) s.setBoard(b);
      // The page re-renders at most once a frame, however fast the board changes.
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setBoard(client.board);
        });
    });
    const offCmd = client.onCommand((c) => {
      if (c.cmd === "select") setSelected(c.ids);
      else if (c.cmd === "focus") s.focus(c.ids);
      else if (c.cmd === "overview") s.overview();
      else if (c.cmd === "tool") setToolState(c.tool);
      else if (c.cmd === "tune") setTune(c.values);
      else if (c.cmd === "presets") loadPresets();
      else if (c.cmd === "open") open(c.boardId);
      else if (c.cmd === "code") goCode({ ...c.link, from: { boardId: clientRef.current.board?.id ?? boardId, itemId: c.link.itemId } });
      else if (c.cmd === "play") s.fx.start(c.kind, c.steps, c.title);
      else if (c.cmd === "stopPlay") s.fx.stop();
      else if (c.cmd === "layers") {
        s.fx.setLayers({ hide: c.hide, isolate: c.isolate }, client.board);
        setLayers({ ...s.fx.layers });
      } else commandRef.current(c);
    });
    const offPresence = client.onPresence((p) => s.fx.presence(p));
    return () => {
      offPresence();
      cancelAnimationFrame(raf);
      offClient();
      offBoard();
      offCmd();
    };
  }, [client, setSelected, loadPresets]); // eslint-disable-line react-hooks/exhaustive-deps

  // A headset? Then the buttons, and its hands, ready before you press.
  useEffect(() => {
    const x = navigator.xr;
    if (!x) return;
    void Promise.all([x.isSessionSupported("immersive-vr").catch(() => false), x.isSessionSupported("immersive-ar").catch(() => false)]).then(([vr, ar]) => {
      setXr({ vr, ar });
      if ((vr || ar) && sceneRef.current && !xrRef.current) {
        void import("./xr").then(({ XRInput }) => {
          if (sceneRef.current && !xrRef.current) xrRef.current = makeXR(XRInput, sceneRef.current);
        });
      }
    });
  }, [ctl]);

  /** The headset's hands, and what plugs into them: the room, the shelf, … */
  function makeXR(XRInput: typeof import("./xr").XRInput, s: BoardScene) {
    const x = new XRInput(s, ctl, () => clientRef.current.board?.activity, xrExtras());
    const room = new RoomXR(x, {
      boardOf: () => clientRef.current.board,
      open: (id) => openRef.current(id),
      inside: (id) => insideRef.current(id),
      up: () => ctl.up?.(),
      boards: () => boardsRef.current,
    });
    const shelf = new ShelfXR(x, room, {
      boards: () => boardsRef.current,
      current: () => clientRef.current.id,
      open: (id) => openRef.current(id),
      create: async () => {
        const r = await fetch("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Untitled board", project: projectId }) });
        if (!r.ok) return null;
        const b = (await r.json()) as Board;
        await reloadRef.current();
        return b.id;
      },
    });
    x.plugins.push(room, shelf);
    for (const f of xrPluginMakers.current) x.plugins.push(f(x));
    return x;
  }

  /** What the headset's palette and Tune panel offer beyond the components. */
  function xrExtras() {
    return {
      extras: () => ({
        library: LIBRARY_NAMES.map((name) => ({ name, make: () => liveRef.current.placePrefab(name) })),
        templates: TEMPLATE_LIST.map((t) => ({ name: t.name, make: () => void liveRef.current.placeTemplate(t.name) })),
      }),
      presets: () => [...BUILT_IN_PRESETS, ...presetsRef.current],
      onPreset: (p: BoardPreset) => applyPreset(p.values),
    };
  }

  const enter = async (m: "vr" | "ar") => {
    setXrError(null);
    try {
      if (!xrRef.current && sceneRef.current) {
        const { XRInput } = await import("./xr");
        xrRef.current = makeXR(XRInput, sceneRef.current);
      }
      // Audio starts on the press that took you in, while it still counts as one.
      const { sfx } = await import("../xr/sound");
      sfx.start();
      await sceneRef.current?.enter(m);
    } catch (e) {
      setXrError(e instanceof Error ? e.message : String(e));
    }
  };

  // "/" to ask, from anywhere but a text field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        askRef.current?.focus();
      } else if (e.key === "f" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.metaKey || e.ctrlKey || e.altKey) return;
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === ",") setTuneOpen((o) => !o);
      else if (e.key === "k") runRef.current("snapshot");
      else if (e.key === "t") (runRef.current("tiers"), setTiersOn(!!sceneRef.current?.tiersOn));
      else if (e.key === "h") setHistoryOpen((o) => !o);
      else if (e.key === "L") setTune({ lockItems: !on("lockItems") });
      else if (e.key === "r" && on("transcriptLog")) setLogOpen((o) => !o);
      else if (e.key === "l") setLayersOpen((o) => !o);
      else if (e.key === "i" && selRef.current.length === 1) insideRef.current(selRef.current[0]);
      else if (e.key === "E") runRef.current("code");
      else if (e.key === "u" && clientRef.current.board?.parent) ctl.up?.();
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        ctl.toggleVoice();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ctl]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAtFocus = (kind: ItemKind) => {
    const s = sceneRef.current;
    if (!s || !board) return;
    const f = s.focusPoint();
    // Not on top of something already there.
    let pos: Vec3 = [f[0], 0, f[2]];
    for (let k = 1; k < 120 && board.items.some((i) => i.kind !== "frame" && Math.hypot(i.pos[0] - pos[0], i.pos[2] - pos[2]) < 0.22); k++) {
      const r = 0.22 * Math.sqrt(k);
      pos = [round(f[0] + Math.cos(k * 2.4) * r), 0, round(f[2] + Math.sin(k * 2.4) * r)];
    }
    const id = ctl.add(kind, pos);
    setSelected([id]);
  };

  /** A hologram from the library, where they're looking. */
  function placePrefab(name: string) {
    const p = findPrefab(name);
    const s = sceneRef.current;
    if (!p || !s) return;
    const f = s.focusPoint();
    const id = ctl.add("holo", [f[0], 0, f[2]], { label: p.name, color: p.color, spin: true, holo: { parts: p.parts } });
    setSelected([id]);
  }

  /** A template, laid out where they're looking (with a version kept first, to go back to). */
  async function placeTemplate(name: string) {
    const s = sceneRef.current;
    const t = layTemplate(name, s?.focusPoint() ?? [0, 0, 0]);
    if (!t) return;
    await fetch("/api/board/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, label: `Before template ${name}` }) }).catch(() => {});
    client.apply([{ op: "add", items: t.items, links: t.links }]);
    s?.overview();
  }

  /** Into the selected item's own board (made the first time). */
  const goInside = async (itemId: string) => {
    const r = await fetch("/api/board/inside", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, itemId }) });
    if (!r.ok) return;
    // The inside grows out of the item.
    sceneRef.current?.dive("in", itemId);
    void import("../xr/sound").then(({ sfx }) => sfx.play("dive"));
    open(((await r.json()) as { boardId: string }).boardId);
  };

  insideRef.current = (id) => void goInside(id);
  /** What the headset's panels call: always this render's, so always this board's. */
  const liveRef = useRef({ placePrefab, placeTemplate });
  liveRef.current = { placePrefab, placeTemplate };

  const showPreview = (v: { id: string; label: string; board: Board } | null) => {
    setPreview(v);
    previewRef.current = v;
    const s = sceneRef.current;
    if (!s) return;
    if (v) s.setBoard(v.board);
    else if (client.board) s.setBoard(client.board);
  };

  previewFnRef.current = showPreview;

  /* -------------------------------- views ------------------------------- */

  const [viewsOpen, setViewsOpen] = useState(false);
  /** Keep the desktop's view as a card. */
  const keepView = () => {
    const s = sceneRef.current;
    if (!s || s.mode !== "flat") return;
    let thumb: string | undefined;
    if (on("snapshotThumbs")) {
      // Drawn fresh, then read in the same breath, before the browser clears it.
      s.capture();
      const c = document.createElement("canvas");
      c.width = 240;
      c.height = 150;
      const ctx = c.getContext("2d")!;
      const r = s.renderer.domElement;
      const k = Math.max(240 / r.width, 150 / r.height);
      ctx.drawImage(r, (240 - r.width * k) / 2, (150 - r.height * k) / 2, r.width * k, r.height * k);
      thumb = c.toDataURL("image/jpeg", 0.62);
    }
    const n = (client.board?.snaps?.length ?? 0) + 1;
    const v = (x: THREE.Vector3): Vec3 => [round(x.x), round(x.y), round(x.z)];
    client.apply([{ op: "snap", snap: { id: newId("s"), label: `View ${n}`, at: Date.now(), head: v(s.camera.position), look: v(s.controls.target), selected: selRef.current, thumb } }]);
  };
  const goView = (sn: Snap) => {
    sceneRef.current?.flyView(new THREE.Vector3(...sn.head), new THREE.Vector3(...sn.look));
    if (sn.selected?.length) setSelected(sn.selected);
  };
  /** Tell them something: by the hand in the headset, on the status line at the desk. */
  const notify = (text: string) => {
    if (sceneRef.current?.mode !== "flat") xrRef.current?.say(text);
    else setNotice({ text, at: Date.now() });
  };
  const structureSketch = () => {
    const b = client.board;
    if (!b) return;
    const inkSel = selRef.current.filter((id) => b.items.find((i) => i.id === id)?.kind === "ink");
    const sk = sketchPicture(b, inkSel.length ? inkSel : undefined);
    if (!sk) return notify("No ink to read: draw a sketch first");
    notify("Reading your sketch");
    sendAsk(`Turn my sketch into the real thing: blocks for the boxes (kind from what's written in them), links for the arrows, notes for loose words, frames for grouped areas — each where its strokes are. Then remove the ink you replaced. ${sk.note}`, [sk.picture]);
  };
  const photoToBoard = async (pic?: Picture) => {
    try {
      const p =
        pic ??
        (await cameraPhoto((n) => notify(n ? `Photo in ${n}…` : "Got it")).catch((e) => {
          throw new Error(e instanceof DOMException && e.name === "NotAllowedError" ? "Camera access was refused" : "No camera here");
        }));
      notify("Reading the picture");
      sendAsk("This is a photo of a whiteboard (or a sketch, or a diagram). Build it on the board for real: read every box, label and arrow; blocks for components, links for arrows with their labels, notes for loose text, frames for groups, laid out as in the picture, near where I'm looking.", [p]);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };
  const repoToBoard = () => {
    notify("Reading the repo");
    sendAsk("Read the repo open in Constellate (use the repo tool) and build its real architecture on this board: its services, apps, datastores, queues and external APIs as blocks; links named for what flows, with their protocols; frames for deployment boundaries. Give every block drawn from code its code link (the module id from the brief, and its main folders), so it opens in the code map. Lay it out with flow.");
  };
  const exportDoc = () => {
    const b = client.board;
    if (!b) return;
    if (sceneRef.current?.mode !== "flat") return notify("Export from the desktop");
    const blob = new Blob([toMarkdown(b)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${b.name.replace(/[^\w.-]+/g, "-")}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  extraActionsRef.current = (a) => {
    if (a === "snapshot") keepView();
    else if (a === "snapshots") setViewsOpen((o) => !o);
    else if (a === "structure-sketch") structureSketch();
    else if (a === "photo-import") void photoToBoard();
    else if (a === "repo-board") repoToBoard();
    else if (a === "export") exportDoc();
  };
  const photoInput = useRef<HTMLInputElement>(null);

  /* ------------------------------ dictation ------------------------------ */

  const dictating = useRef<{ id: string | null } | null>(null);
  dictateRef.current = (id) => {
    dictating.current = { id };
    const v = voiceRef.current;
    if (v.state === "idle" || v.state === "error") void v.start();
    else v.send({ type: "proxy.dictate", on: true });
    const it = id ? client.board?.items.find((i) => i.id === id) : null;
    notify(it ? `Say ${it.kind === "note" || it.kind === "text" ? "its text" : "its name"}…` : "Say the note…");
  };
  // Started the voice to dictate: once it listens, tell it to take the words down.
  useEffect(() => {
    if (voice.state === "listening" && dictating.current) voice.send({ type: "proxy.dictate", on: true });
  }, [voice.state]); // eslint-disable-line react-hooks/exhaustive-deps
  dictatedRef.current = (text) => {
    const d = dictating.current;
    dictating.current = null;
    if (!text.trim()) return;
    const b = client.board;
    const it = d?.id ? b?.items.find((i) => i.id === d.id) : null;
    if (it) client.apply([{ op: "update", id: it.id, patch: it.kind === "note" || it.kind === "text" ? { body: text } : { label: text.replace(/[.!?]+$/, "") } }]);
    else {
      const f = sceneRef.current?.focusPoint() ?? [0, 0, 0];
      setSelected([ctl.add("note", [f[0], 0, f[2]], { body: text })]);
    }
    notify(`“${text.slice(0, 40)}”`);
  };
  commandRef.current = (c) => {
    if (c.cmd === "action") runAction(c.id, "voice");
    else if (c.cmd === "dictate") dictateRef.current(c.id ?? selRef.current[0] ?? null);
  };
  xrPluginMakers.current = [
    (x) =>
      new ScrubXR(x, {
        boardId: () => clientRef.current.id,
        board: () => clientRef.current.board,
        preview: (b, label) => ctl.preview?.(b, label),
      }),
    (x) =>
      new SnapsXR(x, {
        board: () => clientRef.current.board,
        apply: (snap) => clientRef.current.apply([{ op: "snap", snap }]),
        remove: (id) => clientRef.current.apply([{ op: "unsnap", ids: [id] }]),
        select: (ids) => setSelected(ids),
      }),
    (x) => new GesturesXR(x),
    (x) => new TypeXR(x),
    (x) => new GuideXR(x),
    (x) =>
      new TranscriptXR(
        x,
        () => ({ log: voiceRef.current.log, heard: voiceRef.current.heard, caption: voiceRef.current.caption }),
        () => voiceRef.current.clearLog(),
      ),
  ];

  const rename = (name: string) => client.apply([{ op: "rename", name }]);
  const newBoard = async () => {
    const r = await fetch("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Untitled board" }) });
    const b = (await r.json()) as Board;
    await reloadBoards();
    open(b.id);
  };
  const deleteBoard = async (id: string) => {
    if (!confirm("Delete this board? This can't be undone.")) return;
    await fetch(`/api/boards?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const list = await reloadBoards();
    if (id === boardId) {
      if (list[0]) open(list[0].id);
      else void newBoard();
    }
  };

  /** One action, by id (shared/boardActions.ts): the headset's own first, then the page's. */
  function runAction(a: string, from?: string) {
    if (xrRef.current && sceneRef.current?.mode !== "flat" && xrRef.current.handle(a)) return;
    const s = sceneRef.current;
    const b = client.board;
    const sel = selRef.current;
    const items = b?.items.filter((i) => sel.includes(i.id)) ?? [];
    const patchSel = (patch: Partial<Item>) => items.length && client.apply(items.map((i) => ({ op: "update" as const, id: i.id, patch })));
    const removeKind = (kinds: string[]) => {
      const ids = b?.items.filter((i) => kinds.includes(i.kind)).map((i) => i.id) ?? [];
      if (ids.length) ctl.remove(ids);
    };
    const cycleBoards = (d: number) => {
      const list = [...boardsRef.current].sort((x, y) => x.name.localeCompare(y.name));
      if (list.length < 2) return;
      const i = list.findIndex((x) => x.id === boardId);
      open(list[(i + d + list.length) % list.length].id);
    };
    switch (a) {
      case "voice":
        return ctl.toggleVoice();
      case "ask-selection": {
        const v = voiceRef.current;
        if (v.state === "idle" || v.state === "error") void v.start();
        return;
      }
      case "dictate":
        return dictateRef.current(sel[0] ?? null);
      case "undo":
        return client.undo();
      case "redo":
        return client.redo();
      case "save-version":
        void fetch("/api/board/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, label: "Saved" }) });
        return;
      case "tool-select":
      case "tool-connect":
      case "tool-ink":
      case "tool-lasso":
      case "tool-erase":
        return setToolState(a.slice(5) as Tool);
      case "tool-cycle": {
        const order: Tool[] = ["select", "connect", "ink", "lasso", "erase"];
        return setToolState(order[(order.indexOf(toolRef.current) + 1) % order.length]);
      }
      case "delete-selection":
        if (sel.length) ctl.remove(sel);
        return;
      case "deselect":
        return setSelected([]);
      case "duplicate": {
        if (!b || !sel.length) return;
        const c = items.reduce((acc, i) => [acc[0] + i.pos[0] / items.length, 0, acc[2] + i.pos[2] / items.length] as Vec3, [0, 0, 0] as Vec3);
        const out = fromClip(toClip(b, sel), [c[0] + 0.28, 0, c[2] + 0.12]);
        if (!out) return;
        client.apply([{ op: "add", items: out.items, links: out.links }]);
        return setSelected(out.items.map((i) => i.id));
      }
      case "explode-toggle":
        return void patchSel({ explode: (items[0]?.explode ?? 0) > 0.5 ? 0 : 1 });
      case "code":
        // The selected item, expanded into the Code view (or the board's whole repo).
        if (b) expandIntoCode(b, items[0]);
        return;
      case "spin-toggle":
        return void patchSel({ spin: !items[0]?.spin });
      case "mark-done":
        return void patchSel({ status: "done" });
      case "inside":
        if (sel.length === 1) insideRef.current(sel[0]);
        return;
      case "up":
        return ctl.up?.();
      case "clear-ink":
        return removeKind(["ink"]);
      case "clear-notes":
        return removeKind(["note"]);
      case "clear-flags": {
        const ids = b?.items.filter((i) => i.flags?.length).map((i) => i.id) ?? [];
        if (ids.length) client.apply(ids.map((id) => ({ op: "update" as const, id, patch: { flags: null as never } })));
        return;
      }
      case "next-board":
        return cycleBoards(1);
      case "prev-board":
        return cycleBoards(-1);
      case "labels-toggle":
        return setTune({ labels: !on("labels") });
      case "layers-reset":
        s?.fx.setLayers({ hide: [], isolate: null }, b);
        return setLayers({ hide: [], isolate: null });
      case "tune":
        return setTuneOpen((o) => !o);
      case "lock":
        return setTune({ lockItems: !on("lockItems") });
      case "transcript":
        return setLogOpen((o) => !o);
      case "guide":
      case "keymap":
        return setHelp(true);
      case "recenter":
        return s?.overview();
      case "tiers":
        if (s) s.tiersOn = !s.tiersOn;
        return;
      case "review":
        return sendAsk("Review this design: flag the real issues (single points of failure, missing auth, hot paths, cost traps), then tell me the top one or two.");
      default:
        extraActionsRef.current(a, from);
    }
  }
  runRef.current = runAction;

  const sel = selected.length === 1 ? board?.items.find((i) => i.id === selected[0]) ?? null : null;
  const activity = board?.activity;
  const inXR = mode !== "flat";

  return (
    <div className="ws-root relative h-full w-full overflow-hidden" onDragOver={(e) => e.preventDefault()}>
      <div
        ref={host}
        className="absolute inset-0"
        onDrop={(e) => {
          e.preventDefault();
          const img = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
          if (img) return void pictureOf(img).then((p) => photoToBoard(p));
          const kind = e.dataTransfer.getData("text/x-kind") as ItemKind;
          const s = sceneRef.current;
          if (!kind || !s) return;
          const id = ctl.add(kind, dropPoint(s, e.clientX, e.clientY));
          setSelected([id]);
        }}
      />
      {!inXR && (
        <>
          {/* Top bar: the board, and the way into the headset. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4">
            <div className="pointer-events-auto flex items-center gap-3">
              <ProjectBar view="board" boardId={boardId} />
              <div className="relative">
                <button className="ws-chip min-w-[10rem] justify-between" onClick={() => setBoardsOpen((o) => !o)} title="This board: rename it, or switch to another">
                  <span className="truncate">{board?.name.split("›").pop()?.trim() ?? "…"}</span>
                  <span className="opacity-60">▾</span>
                </button>
                {boardsOpen && (
                  <div className="ws-panel absolute left-0 top-11 z-20 w-80 p-2" onMouseLeave={() => setBoardsOpen(false)}>
                    <input
                      className="ws-input mb-2 w-full"
                      defaultValue={board?.name}
                      placeholder="Board name"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          rename((e.target as HTMLInputElement).value);
                          setBoardsOpen(false);
                        }
                      }}
                      onBlur={(e) => e.target.value !== board?.name && rename(e.target.value)}
                    />
                    <div className="max-h-72 overflow-auto">
                      {boards.map((b) => (
                        <div key={b.id} className={`group flex items-center justify-between rounded px-2 py-1.5 hover:bg-cyan-400/10 ${b.id === boardId ? "text-[#ffb547]" : ""}`}>
                          <button className="flex-1 truncate text-left" onClick={() => (setBoardsOpen(false), open(b.id))}>
                            {b.name} <span className="text-xs opacity-50">· {b.items}</span>
                          </button>
                          <button className="ml-2 text-xs opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-red-300" onClick={() => void deleteBoard(b.id)}>
                            delete
                          </button>
                        </div>
                      ))}
                    </div>
                    <button className="ws-btn mt-2 w-full" onClick={() => void newBoard()}>
                      + New board
                    </button>
                  </div>
                )}
              </div>
              {board?.parent && (
                <button className="ws-chip" onClick={() => ctl.up?.()} title="Back up to the board this is inside (U)">
                  ↑ Up
                </button>
              )}
              {board && <Breadcrumbs board={board} open={open} />}
              {board?.repo && (
                <button className="ws-chip" onClick={() => goCode({ root: board.repo!.root }, { transition: board.repo!.name })} title={`Drawn from ${board.repo.root}: Jarvis can read it. Open it in the Code view.`}>
                  ⌥ {board.repo.name}
                </button>
              )}
              {!client.connected && board === null && <span className="text-xs text-[#7fa6bd]">connecting…</span>}
            </div>
            <div className="pointer-events-auto flex items-center gap-2">
              <button className="ws-chip" onClick={() => setFindOpen(true)} title="Find (⌘F)">
                Find
              </button>
              <button className={`ws-chip ${layersOpen || layers.hide.length || layers.isolate ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setLayersOpen((o) => !o)} title="Layers (L)">
                Layers
              </button>
              <button className={`ws-chip ${historyOpen ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setHistoryOpen((o) => !o)} title="History: versions to go back to (H)">
                History
              </button>
              <button className={`ws-chip ${viewsOpen ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setViewsOpen((o) => !o)} title="Views: snapshot cards of where you looked (K keeps this one)">
                Views{board?.snaps?.length ? ` · ${board.snaps.length}` : ""}
              </button>
              {on("transcriptLog") && (
                <button className={`ws-chip ${logOpen ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setLogOpen((o) => !o)} title="Transcript: everything said, and what happened (R)">
                  Log
                </button>
              )}
              <button className={`ws-chip ${on("lockItems") ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setTune({ lockItems: !on("lockItems") })} title="Lock items: nothing moves, you only turn the view (Shift-L)">
                {on("lockItems") ? "Locked" : "Lock"}
              </button>
              <button className={`ws-chip ${tiersOn ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => (runAction("tiers"), setTiersOn(!!sceneRef.current?.tiersOn))} title="Depth tiers: frames float as layers (T)">
                Tiers
              </button>
              <button className="ws-chip" onClick={() => setExchangeOpen(true)} title="Export and import">
                Export
              </button>
              <button className={`ws-chip ${tuneOpen ? "!border-[#ffb547] !text-[#ffb547]" : ""}`} onClick={() => setTuneOpen((o) => !o)} title="Tune: how everything looks and behaves (,)">
                Tune
              </button>
              <button className="ws-chip" onClick={() => setHelp((h) => !h)} title="Shortcuts (?)">
                ?
              </button>
              {xr.ar && (
                <button className="ws-btn ws-btn-accent" onClick={() => void enter("ar")}>
                  Passthrough
                </button>
              )}
              {xr.vr && (
                <button className="ws-btn" onClick={() => void enter("vr")}>
                  VR
                </button>
              )}
            </div>
          </div>
          {xrError && <div className="absolute right-4 top-16 max-w-sm rounded bg-red-900/70 px-3 py-2 text-sm text-red-100">{xrError}</div>}

          {/* The palette. */}
          <div className="ws-panel absolute bottom-24 left-4 top-20 flex w-56 flex-col p-3">
            <div className="mb-3 flex gap-1">
              {(
                [
                  ["blocks", "Build"],
                  ["holo", "Holo"],
                  ["plans", "Plans"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={`ws-tool !h-7 !text-[11px] uppercase tracking-widest ${palTab === id ? "ws-tool-on" : ""}`} onClick={() => setPalTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
            {palTab === "holo" && (
              <Section title="Hologram library">
                <LibraryList onPick={placePrefab} />
                <div className="mt-2 text-[11px] leading-tight text-[#7fa6bd]">Or ask {ASSISTANT} for any object: “a hologram of a jet engine”.</div>
              </Section>
            )}
            {palTab === "plans" && (
              <>
                <Section title="Bring in">
                  <div className="flex flex-col gap-1.5">
                    <button className="ws-chip !justify-start text-sm" onClick={repoToBoard} title="The repo open in Constellate, as an architecture">
                      ⌥ Repo → board
                    </button>
                    <button className="ws-chip !justify-start text-sm" onClick={() => photoInput.current?.click()} title="A photo of a whiteboard or a sketch (or paste / drop one)">
                      ▣ Photo → board
                    </button>
                    <button className="ws-chip !justify-start text-sm" onClick={structureSketch} title="Your ink strokes, read and rebuilt as real blocks and links">
                      ✎ Sketch → structure
                    </button>
                  </div>
                  <input
                    ref={photoInput}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void photoToBoard(await pictureOf(f));
                    }}
                  />
                </Section>
                <Section title="Templates">
                  <TemplateList onPick={(n) => void placeTemplate(n)} />
                </Section>
              </>
            )}
            {palTab === "blocks" && (<>
            <Section title="Architecture">
              <div className="grid grid-cols-2 gap-1.5">
                {ARCH_KINDS.map((k) => (
                  <PaletteItem key={k} kind={k} onAdd={() => addAtFocus(k)} />
                ))}
              </div>
            </Section>
            <Section title="Board">
              <div className="grid grid-cols-2 gap-1.5">
                {(["note", "text", "frame", "holo"] as ItemKind[]).map((k) => (
                  <PaletteItem key={k} kind={k} onAdd={() => addAtFocus(k)} />
                ))}
              </div>
            </Section>
            <Section title="Tools">
              <div className="flex gap-1.5">
                {(["select", "connect", "ink", "lasso", "erase"] as Tool[]).map((t) => (
                  <button key={t} className={`ws-tool ${tool === t ? "ws-tool-on" : ""}`} onClick={() => setToolState(t)} title={`${t} (${({ select: "V", connect: "C", ink: "D", lasso: "S", erase: "X" } as Record<Tool, string>)[t]})`}>
                    {({ select: "⌖", connect: "⟿", ink: "✎", lasso: "◌", erase: "⌫" } as Record<Tool, string>)[t]}
                  </button>
                ))}
              </div>
              {tool === "ink" && (
                <div className="mt-2 flex gap-1.5">
                  {INK_COLORS.map((c) => (
                    <button key={c} onClick={() => setInkColor(c)} className="h-5 w-5 rounded-full" style={{ background: COLORS[c], boxShadow: inkColor === c ? `0 0 0 2px #02060d, 0 0 0 3px ${COLORS[c]}` : undefined }} />
                  ))}
                </div>
              )}
              <div className="mt-2 text-[11px] leading-tight text-[#7fa6bd]">
                {tool === "connect" ? "Drag from one item to another." : tool === "ink" ? "Draw on the table." : tool === "lasso" ? "Drag across items to select them all." : tool === "erase" ? "Drag across items to delete them all (⌘Z brings them back)." : "Drag to move · Shift-drag on an item to lift it, on the table to box-select · double-click to edit"}
              </div>
            </Section>
            </>)}
            </div>
            <div className="mt-2 flex gap-1.5">
              <button className="ws-btn flex-1" onClick={() => client.undo()} title="Undo (⌘Z)">
                Undo
              </button>
              <button className="ws-btn flex-1" onClick={() => client.redo()} title="Redo (⇧⌘Z)">
                Redo
              </button>
            </div>
            <button className="ws-btn mt-1.5 w-full" onClick={() => void fetch("/api/board/arrange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, ids: selected.length > 1 ? selected : undefined, how: "flow" }) })}>
              Tidy {selected.length > 1 ? "selection" : "board"}
            </button>
          </div>

          {/* The inspector. */}
          {sel && !tuneOpen && !historyOpen && (
            <Inspector item={sel} board={board!} client={client} onEdit={() => setEditing(sel.id)} onDelete={() => ctl.remove([sel.id])} onFocus={() => sceneRef.current?.focus([sel.id])} onInside={() => void goInside(sel.id)} />
          )}
          {selLink && board?.links.find((l) => l.id === selLink) && !tuneOpen && !historyOpen && (
            <LinkInspector link={board.links.find((l) => l.id === selLink)!} board={board} client={client} onClose={() => setSelLink(null)} />
          )}
          {historyOpen && <HistoryPanel boardId={boardId} previewing={preview?.id ?? null} onPreview={showPreview} onClose={() => (setHistoryOpen(false), showPreview(null))} />}
          {preview && (
            <PreviewBar
              label={preview.label}
              onExit={() => showPreview(null)}
              onRestore={() => {
                void fetch("/api/board/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, restore: preview.id }) }).then(() => showPreview(null));
              }}
            />
          )}
          {viewsOpen && board && (
            <div className="ws-panel absolute right-4 top-20 z-20 w-[22rem] p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="ws-title">Views</div>
                <div className="flex gap-2 text-xs">
                  <button className="ws-btn !py-0.5" onClick={keepView}>
                    + Keep this view (K)
                  </button>
                  <button className="text-[#7fa6bd] hover:text-white" onClick={() => setViewsOpen(false)}>
                    ✕
                  </button>
                </div>
              </div>
              <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-auto">
                {[...(board.snaps ?? [])].reverse().map((sn) => (
                  <div key={sn.id} className="group relative">
                    <button className="block w-full overflow-hidden rounded border border-cyan-300/20 hover:border-[#ffb547]" onClick={() => goView(sn)}>
                      {sn.thumb ? <img src={sn.thumb} className="aspect-[1.6] w-full object-cover" /> : <div className="grid aspect-[1.6] place-items-center text-xs text-[#4f7286]">no picture</div>}
                    </button>
                    <div className="mt-0.5 flex items-center justify-between text-[11px] text-[#9fc3d6]">
                      <span className="truncate">{sn.label}</span>
                      <button className="opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:text-red-300" onClick={() => client.apply([{ op: "unsnap", ids: [sn.id] }])}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
                {!board.snaps?.length && <div className="col-span-2 text-xs text-[#7fa6bd]">No views kept. In the headset: hold Y, or the wheel.</div>}
              </div>
            </div>
          )}
          {layersOpen && (
            <LayersPopover
              layers={layers}
              selected={selected}
              onClose={() => setLayersOpen(false)}
              onChange={(l) => {
                sceneRef.current?.fx.setLayers(l, client.board);
                setLayers({ ...sceneRef.current!.fx.layers });
              }}
            />
          )}
          {findOpen && board && (
            <FindPalette
              board={board}
              onClose={() => setFindOpen(false)}
              onPick={(id) => {
                setSelected([id]);
                sceneRef.current?.focus([id]);
              }}
            />
          )}
          {exchangeOpen && board && <ExchangeDialog board={board} client={client} capture={() => sceneRef.current!.capture()} focus={() => sceneRef.current!.focusPoint()} onClose={() => setExchangeOpen(false)} />}
          {playCaption && <PlayerBar caption={playCaption} onStop={() => sceneRef.current?.fx.stop()} />}
          {selected.length > 1 && (
            <div className="ws-panel absolute right-4 top-20 w-64 p-3">
              <div className="ws-title">{selected.length} selected</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(COLORS).map(([n, c]) => (
                  <button key={n} title={n} className="h-5 w-5 rounded-full" style={{ background: c }} onClick={() => client.apply(selected.map((id) => ({ op: "update" as const, id, patch: { color: n } })))} />
                ))}
              </div>
              <div className="mt-3 flex gap-1.5">
                <button className="ws-btn flex-1" onClick={() => void fetch("/api/board/arrange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, ids: selected, how: "row" }) })}>
                  Row
                </button>
                <button className="ws-btn flex-1" onClick={() => void fetch("/api/board/arrange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, ids: selected, how: "grid" }) })}>
                  Grid
                </button>
                <button className="ws-btn flex-1" onClick={() => void fetch("/api/board/arrange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId, ids: selected, how: "ring" }) })}>
                  Ring
                </button>
              </div>
              <button className="ws-btn mt-1.5 w-full !text-red-300" onClick={() => ctl.remove(selected)}>
                Delete all
              </button>
            </div>
          )}

          {/* Empty board: what to try. */}
          {board && board.items.length === 0 && !activity?.busy && (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center">
              <div className="pointer-events-auto max-w-xl text-center">
                <div className="ws-brand mb-2 text-2xl">Blank table.</div>
                <div className="mb-4 text-sm text-[#7fa6bd]">Drag a component on, or tell {ASSISTANT} what you're building.</div>
                <div className="flex flex-col gap-2">
                  {EXAMPLES.map((x) => (
                    <button key={x} className="ws-chip !justify-start text-left text-sm" onClick={() => sendAsk(x)}>
                      “{x}”
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Ask, the voice, and what's happening. */}
          <div className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-2 px-4">
            <StatusLine activity={activity} caption={voice.caption} heard={voice.heard} voiceError={voice.error} notice={notice} />
            <form
              className="ws-panel flex w-full max-w-2xl items-center gap-2 p-1.5 pl-4"
              onSubmit={(e) => {
                e.preventDefault();
                sendAsk(ask);
                setAsk("");
                askRef.current?.blur();
              }}
            >
              <span className="ws-brand text-sm">{ASSISTANT.toUpperCase()}</span>
              <input
                ref={askRef}
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && askRef.current?.blur()}
                onPaste={(e) => {
                  const img = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
                  if (!img) return;
                  e.preventDefault();
                  void pictureOf(img).then((p) => (ask.trim() ? (sendAsk(ask, [p]), setAsk("")) : photoToBoard(p)));
                }}
                placeholder={selected.length ? "Ask about or change what's selected…  ( / )" : "Design, build, arrange anything…  ( / )"}
                className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-[#dff6ff] outline-none placeholder:text-[#4f7286]"
              />
              {activity?.busy && (
                <button type="button" className="ws-btn" onClick={() => void fetch("/api/board/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: boardId }) })}>
                  Stop
                </button>
              )}
              <VoiceButton state={voice.state} onClick={ctl.toggleVoice} />
            </form>
          </div>

          {help && <Help onClose={() => setHelp(false)} />}
          {logOpen && on("transcriptLog") && (
            <TranscriptLog log={voice.log} heard={voice.heard} caption={voice.caption} onClear={voice.clearLog} onClose={() => setLogOpen(false)} storageKey="workshop.log" />
          )}
          {tuneOpen && <TunePanel presets={presets} onPresets={setPresets} onClose={() => setTuneOpen(false)} />}
        </>
      )}

      {editing && board && (
        <Editor
          item={board.items.find((i) => i.id === editing) ?? null}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            client.apply([{ op: "update", id: editing, patch }]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="ws-title mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function PaletteItem({ kind, onAdd }: { kind: ItemKind; onAdd: () => void }) {
  const c = colorOf(defaultsFor(kind).color);
  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-kind", kind);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onAdd}
      className="ws-pal"
      style={{ ["--c" as string]: c }}
      title={`Add a ${kindName(kind).toLowerCase()} (or drag it onto the table)`}
    >
      <span className="ws-pal-dot" />
      {kindName(kind)}
    </button>
  );
}

/**
 * A board item, expanded into the Code view: its module and paths, the map
 * filtered to just that code and named for the item. An item with no code
 * link has the navigator find it. Without an item, the board's repo.
 */
export function expandIntoCode(board: Board, item?: Item | null) {
  const root = board.repo?.root;
  if (!item) return goCode(root ? { root } : {}, { transition: board.repo?.name ?? "Code" });
  const from = { boardId: board.id, itemId: item.id };
  const label = nameOf(item);
  if (item.code?.module || item.code?.paths?.length) return goCode({ root, module: item.code.module, paths: item.code.paths, only: true, label, from });
  goCode({ root, label, from, ask: `Show me the code for "${label}"${item.body ? ` (${item.body.slice(0, 200)})` : ""}${item.tags?.length ? ` [${item.tags.join(", ")}]` : ""} from the board "${board.name}": find where it lives, filter the map to just that code, and say briefly what it is.` });
}

function Inspector({ item, board, client, onEdit, onDelete, onFocus, onInside }: { item: Item; board: Board; client: BoardClient; onEdit: () => void; onDelete: () => void; onFocus: () => void; onInside: () => void }) {
  const patch = (p: Partial<Item>, merge?: string) => client.apply([{ op: "update", id: item.id, patch: p }], merge);
  const [label, setLabel] = useState(item.label ?? "");
  const [tags, setTags] = useState((item.tags ?? []).join(", "));
  useEffect(() => setLabel(item.label ?? ""), [item.id, item.label]);
  useEffect(() => setTags((item.tags ?? []).join(", ")), [item.id, item.tags]);
  const words = item.kind === "note" || item.kind === "text";
  return (
    <div className="ws-panel absolute right-4 top-20 w-72 p-3">
      <div className="flex items-center justify-between">
        <div className="ws-title">{kindName(item.kind)}</div>
        <button className="text-xs text-[#7fa6bd] hover:text-white" onClick={onFocus}>
          frame (F)
        </button>
      </div>
      {item.kind !== "ink" && (
        <input
          className="ws-input mt-2 w-full"
          value={label}
          placeholder={words ? "Title (optional)" : "Name"}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== (item.label ?? "") && patch({ label: label || (null as never) })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      )}
      {words && (
        <button className="ws-chip mt-2 w-full !justify-start text-left text-sm" onClick={onEdit}>
          <span className="line-clamp-3 whitespace-pre-wrap">{item.body || "Write…"}</span>
        </button>
      )}
      <div className="ws-title mb-1 mt-3">Colour</div>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(COLORS).map(([n, c]) => (
          <button
            key={n}
            title={n}
            className="h-5 w-5 rounded-full"
            style={{ background: c, boxShadow: colorOf(item.color) === c ? `0 0 0 2px #02060d, 0 0 0 3px ${c}` : undefined }}
            onClick={() => patch({ color: n })}
          />
        ))}
      </div>
      {item.kind !== "ink" && item.kind !== "frame" && (
        <>
          <div className="ws-title mb-1 mt-3">Status</div>
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={`rounded px-2 py-0.5 text-xs capitalize ${item.status === s ? "text-[#02060d]" : "text-[#9fc3d6] hover:bg-white/5"}`}
                style={item.status === s ? { background: STATUS_COLOR[s] } : { border: `1px solid ${STATUS_COLOR[s]}55` }}
                onClick={() => patch({ status: (item.status === s ? null : s) as never })}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ws-title mb-1 mt-3">Tags</div>
          <input
            className="ws-input w-full text-sm"
            value={tags}
            placeholder="Go, Postgres, gRPC"
            onChange={(e) => setTags(e.target.value)}
            onBlur={() =>
              patch({
                tags: tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </>
      )}
      <div className="ws-title mb-1 mt-3">Size · turn</div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0.2}
          max={4}
          step={0.05}
          value={item.scale ?? 1}
          onChange={(e) => client.hold(item.id, { scale: Number(e.target.value) })}
          onPointerUp={() => client.release(item.id)}
          className="ws-range flex-1"
        />
        <button className="ws-btn" onClick={() => patch({ rotY: ((item.rotY ?? 0) + 45) % 360 }, `rot:${item.id}`)} title="Turn 45° (R)">
          ⟳
        </button>
      </div>
      {item.kind === "holo" && (
        <>
          <div className="ws-title mb-1 mt-3">Pull apart</div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={item.explode ?? 0}
              onChange={(e) => client.hold(item.id, { explode: Number(e.target.value) })}
              onPointerUp={() => client.release(item.id)}
              className="ws-range flex-1"
            />
            <button className={`ws-btn ${item.spin ? "ws-btn-accent" : ""}`} onClick={() => patch({ spin: !item.spin })}>
              Spin
            </button>
          </div>
          {item.holo?.error && <div className="mt-2 rounded bg-red-900/40 p-2 font-mono text-[11px] text-red-200">{item.holo.error}</div>}
          <div className="mt-1 text-[11px] text-[#7fa6bd]">{item.holo?.parts?.length ?? 0} parts{item.holo?.script ? " · scripted" : ""}</div>
        </>
      )}
      {item.flags?.length ? (
        <>
          <div className="ws-title mb-1 mt-3">Review</div>
          {item.flags.map((f, k) => (
            <div key={k} className="mb-1 flex items-start gap-1.5 text-xs" style={{ color: f.level === "risk" ? LOOK.danger : f.level === "warn" ? LOOK.accent : LOOK.cyan }}>
              <span className="mt-1 h-1.5 w-1.5 flex-none rotate-45" style={{ background: "currentColor" }} />
              <span className="flex-1 text-[#cfeaf6]">{f.text}</span>
            </div>
          ))}
          <button className="text-[11px] text-[#7fa6bd] hover:text-white" onClick={() => patch({ flags: null as never })}>
            clear findings
          </button>
        </>
      ) : null}
      {item.metrics?.length ? (
        <>
          <div className="ws-title mb-1 mt-3">Metrics</div>
          {item.metrics.map((m, k) => (
            <div key={k} className="flex justify-between text-xs text-[#cfeaf6]">
              <span>{m.label}</span>
              <span className="font-mono text-[#7dff9a]">
                {m.value}
                {m.unit ?? ""}
                {m.max ? <span className="text-[#4f7286]"> / {m.max}</span> : null}
              </span>
            </div>
          ))}
        </>
      ) : null}
      {item.attach && (
        <div className="mt-3 flex items-center justify-between text-xs text-[#7fa6bd]">
          <span>
            Pinned to <span className="text-[#dff6ff]">{(() => { const p = board.items.find((i) => i.id === item.attach); return p ? nameOf(p) : "?"; })()}</span>
          </span>
          <button className="hover:text-white" onClick={() => patch({ attach: null as never })}>
            unpin
          </button>
        </div>
      )}
      {(item.code || board.repo) && item.kind !== "ink" && (
        <div className="mt-3 rounded border border-cyan-300/15 bg-cyan-300/5 px-2 py-1.5 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="font-cond text-[11px] uppercase tracking-[0.16em] text-[#7fa6bd]">Code</span>
            <span className="min-w-0 flex-1 truncate text-[#dff6ff]" title={item.code?.paths?.join("\n")}>
              {item.code ? [item.code.module, item.code.paths?.slice(0, 2).join(", ")].filter(Boolean).join(" · ") : "not linked"}
            </span>
            <button className="ws-btn !px-2 !py-0.5 text-[12px]" onClick={() => expandIntoCode(board, item)} title={item.code ? "Expand into the Code view, filtered to this code (Shift-E)" : "Have the navigator find its code, and show it (Shift-E)"}>
              {item.code ? "Expand into code ⤢" : "Find its code ⤢"}
            </button>
          </div>
          <input
            className="mt-1.5 w-full rounded border border-cyan-300/15 bg-transparent px-1.5 py-1 text-[12px] text-[#dff6ff] outline-none placeholder:text-[#4f7286]"
            placeholder="Paths in the repo, comma-separated"
            defaultValue={item.code?.paths?.join(", ") ?? ""}
            key={`${item.id}:${item.code?.paths?.join()}`}
            onBlur={(e) => {
              const paths = e.currentTarget.value.split(",").map((p) => p.trim()).filter(Boolean);
              if (paths.join() !== (item.code?.paths ?? []).join()) patch({ code: paths.length || item.code?.module ? { ...item.code, paths } : (null as never) });
            }}
          />
        </div>
      )}
      <div className="mt-3 flex gap-1.5">
        {item.kind !== "frame" && item.kind !== "ink" && item.kind !== "text" && (
          <button className="ws-btn flex-1" onClick={onInside} title="Its own board, for what it's made of (I)">
            {item.sub ? "Go inside ↘" : "Open inside ↘"}
          </button>
        )}
        <button className="ws-btn flex-1 !text-red-300" onClick={onDelete}>
          Delete (⌫)
        </button>
      </div>
    </div>
  );
}

function Editor({ item, onClose, onSave }: { item: Item | null; onClose: () => void; onSave: (p: Partial<Item>) => void }) {
  const words = item?.kind === "note" || item?.kind === "text";
  const [text, setText] = useState(words ? item?.body ?? "" : item?.label ?? "");
  if (!item) return null;
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div className="ws-panel w-[28rem] p-4" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ws-title mb-2">{words ? `${kindName(item.kind)} text` : `Name this ${kindName(item.kind).toLowerCase()}`}</div>
        <textarea
          autoFocus
          rows={words ? 6 : 1}
          className="ws-input w-full resize-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !words)) {
              e.preventDefault();
              onSave(words ? { body: text } : { label: text });
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-2 text-sm">
          <span className="mr-auto self-center text-xs text-[#7fa6bd]">{words ? "⌘↵ to save" : "↵ to save"}</span>
          <button className="ws-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="ws-btn ws-btn-accent" onClick={() => onSave(words ? { body: text } : { label: text })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ activity, caption, heard, voiceError, notice }: { activity: Board["activity"]; caption: string; heard: string; voiceError: string | null; notice: { text: string; at: number } | null }) {
  const [shownAnswer, setShownAnswer] = useState<string | null>(null);
  // Only answers that land while the page is open: not the last one again on every load.
  const [openedAt] = useState(() => Date.now());
  useEffect(() => {
    if (!activity?.answer || activity.busy || activity.at < openedAt) return;
    setShownAnswer(activity.answer);
    const t = setTimeout(() => setShownAnswer(null), 12_000);
    return () => clearTimeout(t);
  }, [activity?.answer, activity?.busy, activity?.at]);
  const line = activity?.busy
    ? { text: `${activity.line ?? "Thinking"}…`, color: LOOK.accent, pulse: true }
    : activity?.error
      ? { text: activity.error, color: LOOK.danger, pulse: false }
      : heard
        ? { text: heard, color: "#9fc3d6", pulse: false }
        : caption
          ? { text: caption, color: LOOK.text, pulse: false }
          : voiceError
            ? { text: voiceError, color: LOOK.danger, pulse: false }
            : notice && Date.now() - notice.at < 5000
              ? { text: notice.text, color: LOOK.accent, pulse: false }
            : shownAnswer
              ? { text: shownAnswer, color: LOOK.text, pulse: false }
              : null;
  if (!line) return null;
  return (
    <div className="ws-panel max-w-2xl px-4 py-2 text-sm" style={{ color: line.color }}>
      {line.pulse && <span className="ws-pulse mr-2 inline-block h-2 w-2 rounded-full" style={{ background: line.color }} />}
      {line.text}
    </div>
  );
}

function VoiceButton({ state, onClick }: { state: string; onClick: () => void }) {
  const on = state === "listening" || state === "speaking";
  return (
    <button type="button" onClick={onClick} title="Voice (Space)" className={`ws-voice ${on ? "ws-voice-on" : ""} ${state === "speaking" ? "ws-voice-speaking" : ""} ${state === "connecting" ? "opacity-60" : ""}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["/ or ⌘K", `Ask ${ASSISTANT}`],
    ["Space", "Voice on / off"],
    ["V · C · D · S · X", "Select · connect · ink · lasso · eraser"],
    ["Drag", "Move an item across the table"],
    ["Shift-drag", "Lift or lower it"],
    ["Double-click / ↵", "Edit its words"],
    ["⌫", "Delete the selection"],
    ["⌘D", "Duplicate"],
    ["R · [ ]", "Turn 15° · smaller / bigger"],
    ["E", "Pull a hologram apart"],
    ["F · O", "Frame the selection · the whole table"],
    ["⌘Z · ⇧⌘Z", "Undo · redo"],
    ["⌘C · ⌘X · ⌘V", "Copy · cut · paste (also a Mermaid diagram)"],
    ["Shift-drag on the table", "Box-select"],
    ["⌘F", "Find"],
    ["I · U", "Go inside the selection · back up"],
    ["H · L", "History · layers"],
    ["T · K", "Depth tiers · keep this view"],
    [",", "Tune"],
    ["Paste / drop an image", "Photo → board"],
  ];
  const xr: [string, string][] = [
    ["Point + pinch / trigger", "Select; hold to drag (stick: push, pull, turn)"],
    ["Hold still on an item", "Select it and talk about it"],
    ["Grip, or pinch right on it", "Carry it; throw to delete; fist (or trigger) crumples"],
    ["Both hands on one", "Scale · pull apart · spread wide to go inside (other hand swaps)"],
    ["Grab empty air", "Move the table; both hands turn and scale it — past 2× over an item dives in"],
    ["A · B · X · Y (and held)", "Palette / shelf · undo / redo · voice / dictate · tune / snapshot"],
    ["Hold right stick in", "Command wheel: tilt to a slice, let go"],
    ["Right palm up", "The wheel blooms from it: poke a slice"],
    ["Left palm toward you", "Wrist dock: tools, voice, panels"],
    ["Fingertip on a panel", "Press it"],
    ["Look at a controller", "What its buttons do"],
    ["Pinch a panel's title", "Carry it; throw it at a wall to stick it there"],
    ["Left / right middle pinch", "Voice · undo (both in Tune)"],
    ["Everything", "Every button, slice and gesture is a Tune knob"],
  ];
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/40" onClick={onClose}>
      <div className="ws-panel grid w-[44rem] grid-cols-2 gap-6 p-5 text-sm" onClick={(e) => e.stopPropagation()}>
        {[
          ["Desktop", rows],
          ["Headset", xr],
        ].map(([title, list]) => (
          <div key={title as string}>
            <div className="ws-title mb-2">{title as string}</div>
            {(list as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-cyan-300/10 py-1">
                <span className="font-mono text-xs text-[#ffb547]">{k}</span>
                <span className="text-right text-[#b9d8e6]">{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

