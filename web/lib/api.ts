import { useEffect, useState } from "react";
import type { RepoGraph, ScreenContext, SessionState, Symbol } from "../../shared/types";

export type FileData = {
  path: string;
  lang: string;
  text: string;
  symbols: Symbol[];
  externals: string[];
  imports: string[];
  importers: string[];
};

/**
 * Parts of the state that change rarely. The server pushes the whole state on
 * every change — dozens of times while the navigator works — and re-parsing
 * makes every part a new object. Anything downstream that compares by identity
 * (the 3D map rebuilds its graph when the overview "changes") would then redo
 * its work on every push, which is what made the map jump around.
 */
const STABLE_KEYS = ["repo", "overview", "lenses", "overlays", "view", "frames"] as const;

/** Keep the previous object for any part whose content didn't change. */
function share(prev: SessionState | null, next: SessionState): SessionState {
  if (!prev) return next;
  const out = { ...next } as Record<string, unknown>;
  for (const k of STABLE_KEYS) {
    const a = (prev as Record<string, unknown>)[k];
    const b = (next as Record<string, unknown>)[k];
    if (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)) out[k] = a;
  }
  return out as SessionState;
}

/** The session stream: the server pushes its whole state, coalesced, on every change. */
export function useSession() {
  const [state, setState] = useState<SessionState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => setState((prev) => share(prev, JSON.parse(e.data) as SessionState));
      es.onerror = () => {
        setConnected(false);
        es?.close();
        // The dev server restarts on every server edit; come back on our own.
        retry = setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  return { state, connected };
}

export function useGraph(version: number | undefined, ready: boolean) {
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    fetch("/api/graph")
      .then((r) => (r.ok ? (r.json() as Promise<RepoGraph>) : null))
      .then((g) => live && setGraph(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version, ready]);
  return graph;
}

const fileCache = new Map<string, Promise<FileData | null>>();

export function fetchFile(path: string): Promise<FileData | null> {
  if (!fileCache.has(path)) {
    fileCache.set(
      path,
      fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => (r.ok ? r.json() : null)),
    );
  }
  return fileCache.get(path)!;
}

export function clearFileCache() {
  fileCache.clear();
}

export async function ask(request: string, opts: { topicId?: string; screen?: ScreenContext } = {}) {
  await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, ...opts }),
  });
}

export const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function config(): Promise<{ voice: boolean; model: string }> {
  return fetch("/api/config").then((r) => r.json());
}
