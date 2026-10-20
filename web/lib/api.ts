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
      es.onmessage = (e) => setState(JSON.parse(e.data) as SessionState);
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
