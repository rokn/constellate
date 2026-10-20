import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api";

type MonacoModule = typeof import("../lib/monaco");

/**
 * A Go file in VS Code's editor, read-only, with gopls behind it: ⌘/Ctrl-click
 * for definition, ⇧F12 or right-click for references (peek), hover for types.
 * Jumps to other repo files go back through the app so the map flies along;
 * jumps into the standard library open here in place.
 */
export function GoEditor({
  path,
  line,
  endLine,
  onOpenRepoFile,
  onReferences,
  onSelection,
}: {
  path: string;
  line?: number;
  endLine?: number;
  onOpenRepoFile: (path: string, line: number) => void;
  onReferences: (name: string, paths: string[]) => void;
  onSelection: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mod = useRef<MonacoModule | null>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [ready, setReady] = useState(false);
  /** Set while browsing a standard-library file, so there's a way back. */
  const [external, setExternal] = useState<string | null>(null);
  const cb = useRef({ onOpenRepoFile, onReferences, onSelection });
  cb.current = { onOpenRepoFile, onReferences, onSelection };

  // Load Monaco once and create the editor.
  useEffect(() => {
    let disposed = false;
    void import("../lib/monaco").then((m) => {
      if (disposed || !host.current) return;
      mod.current = m;
      const ed = m.monaco.editor.create(host.current, {
        theme: "codeflight",
        readOnly: true,
        domReadOnly: true,
        // The classic hidden textarea rather than the newer EditContext, so
        // the input element can be told not to summon a keyboard (below).
        editContext: false,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 12.5,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        glyphMargin: false,
        folding: true,
        stickyScroll: { enabled: true },
        contextmenu: true,
        "semanticHighlighting.enabled": false,
        gotoLocation: { multipleDefinitions: "peek", multipleReferences: "peek", multipleImplementations: "peek" },
        padding: { top: 8 },
      });
      editor.current = ed;
      // Read-only: a touch device has nothing to type, so its on-screen
      // keyboard must not pop up when the code is tapped. inputmode="none"
      // keeps the hidden input focusable (shortcuts, selection, ⌘-click) while
      // telling the device not to show a keyboard for it.
      const quiet = () =>
        ed.getDomNode()?.querySelectorAll("textarea").forEach((t) => {
          t.setAttribute("inputmode", "none");
          t.setAttribute("readonly", "");
        });
      quiet();
      ed.onDidFocusEditorText(quiet);
      if (import.meta.env.DEV) (window as unknown as { __goEditor: unknown }).__goEditor = ed;
      decorations.current = ed.createDecorationsCollection();
      ed.onDidChangeCursorSelection(() => {
        const sel = ed.getSelection();
        const model = ed.getModel();
        cb.current.onSelection(sel && model && !sel.isEmpty() ? model.getValueInRange(sel).slice(0, 2000) : "");
      });
      setReady(true);
    });
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = null;
    };
  }, []);

  // The module-level hooks point at whichever editor is mounted.
  useEffect(() => {
    if (!ready || !mod.current) return;
    const m = mod.current;
    m.hooks.openRepoFile = (p, l) => cb.current.onOpenRepoFile(p, l);
    m.hooks.onReferences = (name, paths) => cb.current.onReferences(name, paths);
    m.hooks.openExternal = (abs, l) => {
      void m.modelFor(abs, true).then((model) => {
        if (!model || !editor.current) return;
        editor.current.setModel(model);
        editor.current.revealLineInCenter(l);
        editor.current.setPosition({ lineNumber: l, column: 1 });
        setExternal(abs);
      });
    };
    return () => {
      m.hooks.openRepoFile = m.hooks.onReferences = m.hooks.openExternal = undefined;
    };
  }, [ready]);

  // Show the requested file and line.
  useEffect(() => {
    if (!ready || !mod.current || !editor.current) return;
    let live = true;
    const m = mod.current;
    void m.modelFor(path).then((model) => {
      const ed = editor.current;
      if (!live || !model || !ed) return;
      if (ed.getModel() !== model) ed.setModel(model);
      setExternal(null);
      if (line) {
        const end = Math.max(line, endLine ?? line);
        ed.revealLinesInCenter(line, end);
        ed.setPosition({ lineNumber: line, column: 1 });
        decorations.current?.set([
          { range: new m.monaco.Range(line, 1, end, 1), options: { isWholeLine: true, className: "cf-line-range" } },
        ]);
      } else {
        decorations.current?.clear();
      }
    });
    return () => {
      live = false;
    };
  }, [ready, path, line, endLine]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {external && (
        <div className="flex items-center gap-2 border-b border-line bg-panel2/70 px-3 py-1.5 text-[12px]">
          <span className="text-muted">Outside the repo, read-only:</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={external}>
            {external.replace(/^.*?\/(?:libexec\/src|pkg\/mod)\//, "")}
          </span>
          <button
            onClick={() => {
              void mod.current?.modelFor(path).then((model) => {
                if (model && editor.current) {
                  editor.current.setModel(model);
                  setExternal(null);
                }
              });
            }}
            className="shrink-0 text-course hover:underline"
          >
            Back to {path.split("/").pop()}
          </button>
        </div>
      )}
      <div ref={host} className="min-h-0 flex-1" />
      {!ready && <p className="p-4 text-[13px] text-muted">Loading the editor…</p>}
      <p className="border-t border-line px-3 py-1 text-[11.5px] text-muted">
        ⌘/Ctrl-click: definition · ⇧F12 or right-click: references · hover for types · powered by gopls
      </p>
    </div>
  );
}
