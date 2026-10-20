import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/go/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * VS Code's editor (Monaco) for Go files, wired to gopls through the server.
 * Loaded lazily — only when a Go file is opened — so the map doesn't pay for
 * it. Monaco supplies the editor experience (⌘-click, peek, hover, find,
 * folding); gopls supplies the answers; this module joins them and hands
 * cross-file jumps back to the app so the map flies with you.
 */

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };

/** Repo files live at codeflight:/<path>; stdlib and module-cache files at codeflight-ext:<abs path>. */
export const repoUri = (path: string) => monaco.Uri.from({ scheme: "codeflight", path: `/${path}` });
export const extUri = (abs: string) => monaco.Uri.from({ scheme: "codeflight-ext", path: abs });
export const pathOf = (uri: monaco.Uri) => (uri.scheme === "codeflight" ? uri.path.slice(1) : uri.path);

type Loc = { path: string; external: boolean; line: number; column: number; endLine: number; endColumn: number };

/** The app's side of the wiring: set by the mounted editor. */
export const hooks: {
  /** A jump to another repo file: open it in the panel and fly there. */
  openRepoFile?: (path: string, line: number) => void;
  /** A jump into the standard library or module cache: show it in place. */
  openExternal?: (abs: string, line: number) => void;
  /** References were found: light their files on the map. */
  onReferences?: (name: string, paths: string[]) => void;
} = {};

monaco.editor.defineTheme("codeflight", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "bb9af7" },
    { token: "type", foreground: "2ac3de" },
    { token: "string", foreground: "9ece6a" },
    { token: "number", foreground: "ff9e64" },
    { token: "comment", foreground: "565f89", fontStyle: "italic" },
    { token: "identifier", foreground: "c0caf5" },
    { token: "delimiter", foreground: "89ddff" },
    { token: "operator", foreground: "89ddff" },
  ],
  colors: {
    "editor.background": "#0c1426",
    "editor.lineHighlightBackground": "#111b31",
    "editorLineNumber.foreground": "#3b4766",
    "editorLineNumber.activeForeground": "#7d89a1",
    "editor.selectionBackground": "#ff4fd84d",
    "editorWidget.background": "#0c1426",
    "editorWidget.border": "#1d2a45",
    "editorHoverWidget.background": "#0c1426",
    "editorHoverWidget.border": "#1d2a45",
    "peekView.border": "#ff4fd8",
    "peekViewEditor.background": "#0a1120",
    "peekViewResult.background": "#0c1426",
    "peekViewTitle.background": "#111b31",
    "peekViewEditor.matchHighlightBackground": "#ff4fd833",
    "peekViewResult.matchHighlightBackground": "#ff4fd833",
    "editor.wordHighlightBackground": "#5bd6ff22",
    "editor.wordHighlightStrongBackground": "#5bd6ff33",
    "scrollbarSlider.background": "#1d2a4580",
  },
});

/** Text for a model the peek view or a jump needs. Fetched once, then kept. */
async function ensureModel(loc: Pick<Loc, "path" | "external">): Promise<monaco.editor.ITextModel | null> {
  const uri = loc.external ? extUri(loc.path) : repoUri(loc.path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  const res = loc.external
    ? await fetch(`/api/lsp/external?path=${encodeURIComponent(loc.path)}`)
    : await fetch(`/api/file?path=${encodeURIComponent(loc.path)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { text: string };
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(body.text, "go", uri);
}

export async function modelFor(path: string, external = false) {
  return ensureModel({ path, external });
}

async function ask(method: string, model: monaco.editor.ITextModel, position: monaco.Position) {
  // Intelligence is for repo files; the standard library is read-only text here.
  if (model.uri.scheme !== "codeflight") return null;
  const res = await fetch("/api/lsp/go", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path: pathOf(model.uri), line: position.lineNumber, column: position.column }),
  });
  if (!res.ok) return null;
  return (await res.json()) as { locations?: Loc[]; hover?: string };
}

async function toLocations(locs: Loc[] | undefined): Promise<monaco.languages.Location[]> {
  if (!locs?.length) return [];
  // The peek view renders other files from their models, so they must exist.
  await Promise.all(locs.slice(0, 80).map((l) => ensureModel(l)));
  return locs.map((l) => ({
    uri: l.external ? extUri(l.path) : repoUri(l.path),
    range: new monaco.Range(l.line, l.column, l.endLine, l.endColumn),
  }));
}

monaco.languages.registerDefinitionProvider("go", {
  async provideDefinition(model, position) {
    return toLocations((await ask("definition", model, position))?.locations);
  },
});

monaco.languages.registerImplementationProvider("go", {
  async provideImplementation(model, position) {
    return toLocations((await ask("implementation", model, position))?.locations);
  },
});

monaco.languages.registerReferenceProvider("go", {
  async provideReferences(model, position) {
    const locs = (await ask("references", model, position))?.locations ?? [];
    const word = model.getWordAtPosition(position)?.word ?? "symbol";
    const files = [...new Set(locs.filter((l) => !l.external).map((l) => l.path))];
    if (files.length) hooks.onReferences?.(word, files);
    return toLocations(locs);
  },
});

monaco.languages.registerHoverProvider("go", {
  async provideHover(model, position) {
    const r = await ask("hover", model, position);
    if (!r?.hover) return null;
    const word = model.getWordAtPosition(position);
    return {
      contents: [{ value: r.hover }],
      range: word ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) : undefined,
    };
  },
});

// Monaco asks us to open any file other than the one on screen — ⌘-click into
// another file, "Open" in the peek view. Repo files go through the app (panel
// + flight); external files are swapped into the editor in place.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    const line =
      selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? selectionOrPosition.startLineNumber
        : selectionOrPosition && "lineNumber" in selectionOrPosition
          ? selectionOrPosition.lineNumber
          : 1;
    if (resource.scheme === "codeflight" && hooks.openRepoFile) {
      hooks.openRepoFile(pathOf(resource), line);
      return true;
    }
    if (resource.scheme === "codeflight-ext" && hooks.openExternal) {
      hooks.openExternal(resource.path, line);
      return true;
    }
    return false;
  },
});
