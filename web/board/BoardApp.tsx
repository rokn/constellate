import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARCH_KINDS,
  COLORS,
  STATUSES,
  colorOf,
  defaultsFor,
  newId,
  type Board,
  type BoardScreen,
  type BoardSummary,
  type Item,
  type ItemKind,
  type Vec3,
} from "../../shared/board";
import { useVoice } from "../lib/useVoice";
import { BoardClient } from "./client";
import type { Ctl, Tool } from "./ctl";
import { attachDesktop, dropPoint } from "./desktop";
import { LOOK, STATUS_COLOR } from "./look";
import { BoardScene, type Mode } from "./scene";
import type { XRInput } from "./xr";
import "./board.css";
import { TunePanel } from "./TunePanel";
import { applyPreset, num, on, onTune, setTune, tuneChanged } from "./tune";
import { BUILT_IN_PRESETS, type BoardPreset } from "../../shared/boardTune";

/**
 * The workshop page: /board, or /board/<id>. The scene fills the window; the
 * desktop's controls float over it. In the headset the scene carries its own
 * panels (see xr.ts), so everything here hides while you're in.
 */

const ASSISTANT = "Jarvis";
const KIND_NAME: Partial<Record<ItemKind, string>> = { function: "Lambda", holo: "Hologram" };
const kindName = (k: ItemKind) => KIND_NAME[k] ?? k[0].toUpperCase() + k.slice(1);
const INK_COLORS = ["cyan", "amber", "magenta", "green", "white"];

const EXAMPLES = [
  "Design the architecture of a food delivery app: mobile clients, an API gateway, order, payment and courier services, Postgres, a Kafka bus",
  "Build a hologram of a quadcopter drone I can pull apart",
  "Lay out a three-phase roadmap for launching a developer SDK, with risks as notes",
  "Sketch an event-driven pipeline that ingests IoT telemetry into a data lake",
];

function idFromPath() {
  const m = location.pathname.match(/^\/board\/([\w-]+)/);
  return m?.[1] ?? null;
}

export function BoardApp() {
  const [boardId, setBoardId] = useState<string | null>(idFromPath());
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadBoards = useCallback(async () => {
    const r = await fetch("/api/boards");
    const list = (await r.json()) as BoardSummary[];
    setBoards(list);
    return list;
  }, []);

  // No board in the address: the last one you had open, or a fresh one.
  useEffect(() => {
    void loadBoards().then(async (list) => {
      if (boardId) return;
      const pick = list[0]?.id ?? ((await (await fetch("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "First board" }) })).json()) as Board).id;
      history.replaceState(null, "", `/board/${pick}`);
      setBoardId(pick);
    }).catch((e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id: string) => {
    history.pushState(null, "", `/board/${id}`);
    setBoardId(id);
  };
  useEffect(() => {
    const pop = () => setBoardId(idFromPath());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  if (error) return <div className="grid h-full place-items-center text-red-300">{error}</div>;
  if (!boardId) return <div className="ws-root grid h-full place-items-center text-[#7fa6bd]">Powering up…</div>;
  return <Workshop key={boardId} boardId={boardId} boards={boards} open={open} reloadBoards={loadBoards} />;
}

function Workshop({ boardId, boards, open, reloadBoards }: { boardId: string; boards: BoardSummary[]; open: (id: string) => void; reloadBoards: () => Promise<BoardSummary[]> }) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BoardScene | null>(null);
  const xrRef = useRef<XRInput | null>(null);
  const client = useMemo(() => new BoardClient(boardId), [boardId]);
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

  const selRef = useRef(selected);
  selRef.current = selected;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const inkRef = useRef(inkColor);
  inkRef.current = inkColor;

  const setSelected = useCallback((ids: string[]) => {
    setSelectedState(ids);
    sceneRef.current?.setSelected(ids);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tuned = useMemo(() => tuneChanged(), [tuneKey]);
  const screen: BoardScreen = useMemo(() => ({ boardId, selected, tool, mode, focus, tune: tuned }), [boardId, selected, tool, mode, focus, tuned]);
  const voiceSettings = useMemo(() => ({ voiceSpeed: num("voiceSpeed"), eagerness: num("eagerness"), interrupt: on("interrupt") }), [tuneKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const voice = useVoice({
    screen,
    onCommand: () => {},
    path: "/api/board/voice",
    volume: num("voiceVolume") * (mode === "flat" ? 1 : 1.6),
    idleMinutes: num("idleMinutes"),
    settings: voiceSettings,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const sendAsk = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      const s = sceneRef.current;
      void fetch("/api/board/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: boardId, request: t, screen: { ...screen, focus: s?.focusPoint() ?? focus } }),
      });
    },
    [boardId, screen, focus],
  );
  const sendAskRef = useRef(sendAsk);
  sendAskRef.current = sendAsk;

  /** Everything the desktop and the headset do to the board. */
  const ctl: Ctl = useMemo(
    () => ({
      client,
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
        client.apply([{ op: "add", items: [item] }]);
        return id;
      },
      remove: (ids) => {
        for (const id of ids) {
          const v = sceneRef.current?.views.get(id);
          if (v) v.dying = 1;
        }
        client.apply([{ op: "remove", ids }]);
        setSelected(selRef.current.filter((x) => !ids.includes(x)));
      },
      link: (from, to) => client.apply([{ op: "link", links: [{ id: newId("l"), from, to, style: "sync" }] }]),
      edit: (id) => setEditing(id),
      toggleVoice: () => {
        const v = voiceRef.current;
        if (v.state === "idle" || v.state === "error") void v.start();
        else v.stop();
      },
      voiceState: () => voiceRef.current.state,
      caption: () => voiceRef.current.caption || voiceRef.current.heard,
      ask: (t) => sendAskRef.current(t),
      inkColor: () => colorOf(inkRef.current),
    }),
    [client, setSelected],
  );

  // The scene, the desktop's mouse, and (once a headset is found) the headset's hands.
  useEffect(() => {
    const s = new BoardScene(host.current!);
    sceneRef.current = s;
    s.isHeld = (id) => client.isHeld(id);
    (window as unknown as { __board: unknown }).__board = s;
    const offDesk = attachDesktop(s, ctl);
    const offClient = client.open();
    let raf = 0;
    const offBoard = client.subscribe((b) => {
      s.setBoard(b);
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
    });
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
      cancelAnimationFrame(raf);
      offDesk();
      offClient();
      offBoard();
      offCmd();
      xrRef.current?.dispose();
      xrRef.current = null;
      s.dispose();
      sceneRef.current = null;
    };
  }, [client, ctl, setSelected, loadPresets]);

  // A headset? Then the buttons, and its hands, ready before you press.
  useEffect(() => {
    const x = navigator.xr;
    if (!x) return;
    void Promise.all([x.isSessionSupported("immersive-vr").catch(() => false), x.isSessionSupported("immersive-ar").catch(() => false)]).then(([vr, ar]) => {
      setXr({ vr, ar });
      if ((vr || ar) && sceneRef.current && !xrRef.current) {
        void import("./xr").then(({ XRInput }) => {
          if (sceneRef.current && !xrRef.current) xrRef.current = new XRInput(sceneRef.current, ctl, () => client.board?.activity, xrExtras());
        });
      }
    });
  }, [ctl, client]);

  /** What the headset's palette and Tune panel offer beyond the components. */
  function xrExtras() {
    return {
      extras: () => ({ library: [], templates: [] }),
      presets: () => [...BUILT_IN_PRESETS, ...presetsRef.current],
      onPreset: (p: BoardPreset) => applyPreset(p.values),
    };
  }

  const enter = async (m: "vr" | "ar") => {
    setXrError(null);
    try {
      if (!xrRef.current && sceneRef.current) {
        const { XRInput } = await import("./xr");
        xrRef.current = new XRInput(sceneRef.current, ctl, () => client.board?.activity, xrExtras());
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
      } else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === ",") setTuneOpen((o) => !o);
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        ctl.toggleVoice();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ctl]);

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
              <a href="/" className="ws-chip" title="Back to the code map">
                ←
              </a>
              <div className="ws-brand">WORKSHOP</div>
              <div className="relative">
                <button className="ws-chip min-w-[12rem] justify-between" onClick={() => setBoardsOpen((o) => !o)}>
                  <span className="truncate">{board?.name ?? "…"}</span>
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
              {!client.connected && board === null && <span className="text-xs text-[#7fa6bd]">connecting…</span>}
            </div>
            <div className="pointer-events-auto flex items-center gap-2">
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
          <div className="ws-panel absolute left-4 top-20 w-44 p-3">
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
                {(["select", "connect", "ink"] as Tool[]).map((t) => (
                  <button key={t} className={`ws-tool ${tool === t ? "ws-tool-on" : ""}`} onClick={() => setToolState(t)} title={`${t} (${t === "select" ? "V" : t === "connect" ? "C" : "D"})`}>
                    {t === "select" ? "⌖" : t === "connect" ? "⟿" : "✎"}
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
                {tool === "connect" ? "Drag from one item to another." : tool === "ink" ? "Draw on the table." : "Drag to move · Shift-drag to lift · double-click to edit"}
              </div>
            </Section>
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
          {sel && <Inspector item={sel} client={client} onEdit={() => setEditing(sel.id)} onDelete={() => ctl.remove([sel.id])} onFocus={() => sceneRef.current?.focus([sel.id])} />}
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
            <StatusLine activity={activity} caption={voice.caption} heard={voice.heard} voiceError={voice.error} />
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

function Inspector({ item, client, onEdit, onDelete, onFocus }: { item: Item; client: BoardClient; onEdit: () => void; onDelete: () => void; onFocus: () => void }) {
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
      <button className="ws-btn mt-3 w-full !text-red-300" onClick={onDelete}>
        Delete (⌫)
      </button>
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

function StatusLine({ activity, caption, heard, voiceError }: { activity: Board["activity"]; caption: string; heard: string; voiceError: string | null }) {
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
    ["V · C · D", "Select · connect · ink"],
    ["Drag", "Move an item across the table"],
    ["Shift-drag", "Lift or lower it"],
    ["Double-click / ↵", "Edit its words"],
    ["⌫", "Delete the selection"],
    ["⌘D", "Duplicate"],
    ["R · [ ]", "Turn 15° · smaller / bigger"],
    ["E", "Pull a hologram apart"],
    ["F · O", "Frame the selection · the whole table"],
    ["⌘Z · ⇧⌘Z", "Undo · redo"],
    [",", "Tune"],
  ];
  const xr: [string, string][] = [
    ["Point + pinch / trigger", "Select; hold to drag along the ray"],
    ["Grip, or pinch right on it", "Carry it in your hand; throw it to delete"],
    ["Both hands on one", "Stretch it — or pull a hologram apart"],
    ["Grab empty air", "Move the table; both hands turn and scale it"],
    ["A · B · X · Y", "Palette · undo · voice · tune"],
    ["Left palm toward you", "Wrist dock: tools, voice, panels"],
    ["Pinch a panel's title", "Carry it; it stays where you let go"],
    ["Left / right middle pinch", "Voice · undo"],
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

