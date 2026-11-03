import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useVoice, type VoiceAudio } from "../lib/useVoice";
import type { ScreenContext, UiCommand } from "../../shared/types";
import type { BoardScreen } from "../../shared/board";

/**
 * One voice for the whole app. It lives in the shell, above the views, so
 * switching from a board to the Code view (or back) doesn't hang up: the
 * conversation carries on, and the server always knows which view is on
 * screen. Each view hands over what it would have given useVoice — its
 * screen, how to carry out commands, its audio settings — with
 * useSharedVoice, and gets the same voice object back.
 */

export type ViewKind = "code" | "board";
export type VoiceApi = ReturnType<typeof useVoice>;

type ViewVoice = {
  screen: ScreenContext | BoardScreen;
  onCommand: (cmd: UiCommand) => void;
  onDictated?: (text: string) => void;
  volume?: number;
  idleMinutes?: number;
  settings?: Record<string, unknown>;
  interrupt?: boolean;
  audioOptions?: VoiceAudio;
  /** The view can carry out commands now (the code map has its graph): queued ones go then. */
  ready?: boolean;
};

const bus = {
  active: null as ViewKind | null,
  views: {} as Partial<Record<ViewKind, ViewVoice>>,
  projectId: undefined as string | undefined,
  /** Map commands that arrived while the Code view was still on its way. */
  queued: [] as UiCommand[],
  voice: null as VoiceApi | null,
  engine: new Set<() => void>(),
  watchers: new Set<() => void>(),
  /** Switching views: the shell's, set by it. */
  onView: (_cmd: Extract<UiCommand, { cmd: "view" }>) => {},
};

const bumpEngine = () => bus.engine.forEach((f) => f());

export function setVoiceProject(pid: string | undefined) {
  if (bus.projectId === pid) return;
  bus.projectId = pid;
  bumpEngine();
}

export function setViewSwitcher(f: (cmd: Extract<UiCommand, { cmd: "view" }>) => void) {
  bus.onView = f;
}

function flushQueued() {
  const v = bus.views.code;
  if (bus.active !== "code" || !v?.ready || !bus.queued.length) return;
  const q = bus.queued.splice(0);
  // After the map's own arrival animation, so a fly_to isn't undone by it.
  setTimeout(() => q.forEach((c) => bus.views.code?.onCommand(c)), 1200);
}

function dispatch(cmd: UiCommand) {
  if (cmd.cmd === "view") return bus.onView(cmd);
  const v = bus.active ? bus.views[bus.active] : undefined;
  // The voice switched to the Code view and is already flying: hold it until the map is there.
  if (bus.active !== "code" || !v?.ready) {
    bus.queued.push(cmd);
    if (bus.queued.length > 20) bus.queued.shift();
    return;
  }
  v.onCommand(cmd);
}

/** The voice, for a view: hand over what's on screen, get the shared voice back. */
export function useSharedVoice(view: ViewKind, o: ViewVoice): VoiceApi {
  const mine = useRef(o);
  mine.current = o;
  // Only once mounted: a view on its way in renders before the one leaving lets go.
  if (bus.active === view) bus.views[view] = o;
  const key = JSON.stringify([o.screen, o.volume, o.idleMinutes, o.settings, o.interrupt, o.audioOptions, !!o.ready]);
  useLayoutEffect(() => {
    bus.active = view;
    bus.views[view] = mine.current;
    bumpEngine();
    return () => {
      if (bus.views[view] !== mine.current) return;
      if (bus.active === view) bus.active = null;
      delete bus.views[view];
    };
  }, [view]);
  useEffect(() => {
    bumpEngine();
    flushQueued();
  }, [key]);
  const voice = useSyncExternalStore(
    (f) => (bus.watchers.add(f), () => bus.watchers.delete(f)),
    () => bus.voice,
  );
  return voice ?? FALLBACK;
}

const noop = () => {};
const FALLBACK: VoiceApi = { state: "idle", error: null, caption: "", heard: "", turns: [], log: [], clearLog: noop, start: async () => {}, stop: noop, send: noop } as unknown as VoiceApi;

/** The voice itself: rendered once by the shell, beside the views. */
export function VoiceEngine() {
  useSyncExternalStore(
    (f) => (bus.engine.add(f), () => bus.engine.delete(f)),
    () => `${bus.active}|${bus.projectId}|${JSON.stringify(bus.active ? [bus.views[bus.active]?.screen, bus.views[bus.active]?.volume, bus.views[bus.active]?.settings, bus.views[bus.active]?.interrupt, bus.views[bus.active]?.audioOptions, bus.views[bus.active]?.idleMinutes] : null)}`,
  );
  const v = bus.active ? bus.views[bus.active] : undefined;
  const screen = { ...(v?.screen ?? {}), view: bus.active ?? "code", ...(bus.projectId ? { projectId: bus.projectId } : {}) } as unknown as ScreenContext;
  const voice = useVoice({
    screen,
    onCommand: dispatch,
    onDictated: (t) => (bus.active ? bus.views[bus.active]?.onDictated?.(t) : undefined),
    volume: v?.volume ?? 1,
    idleMinutes: v?.idleMinutes,
    settings: v?.settings,
    interrupt: v?.interrupt ?? true,
    audioOptions: v?.audioOptions,
  });
  const last = useRef<VoiceApi | null>(null);
  useEffect(() => {
    if (last.current === voice) return;
    last.current = voice;
    bus.voice = voice;
    bus.watchers.forEach((f) => f());
  });
  return null;
}
