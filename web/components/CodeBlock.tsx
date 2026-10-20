import { useEffect, useMemo, useRef, useState } from "react";
import { codeToTokens, type BundledLanguage, type ThemedToken } from "shiki";

/** Scanner language ids -> shiki grammar ids, where they differ. */
const GRAMMAR: Record<string, string> = {
  docker: "dockerfile",
  make: "makefile",
  "objective-c": "objective-c",
  proto: "proto",
  hcl: "hcl",
};

const LARGE = 4000;

function useTokens(code: string, lang: string): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    let live = true;
    setTokens(null);
    // Very large files are shown plain; tokenizing them stalls the frame the
    // reader is trying to fly in.
    if (code.split("\n").length > LARGE) return;
    const render = (l: string) =>
      codeToTokens(code, { lang: l as BundledLanguage, theme: "tokyo-night" }).then((r) => live && setTokens(r.tokens));
    render(GRAMMAR[lang] ?? lang).catch(() => render("text").catch(() => {}));
    return () => {
      live = false;
    };
  }, [code, lang]);
  return tokens;
}

export function CodeBlock({
  code,
  lang,
  startLine = 1,
  highlight = [],
  pointed = [],
  annotations = [],
  scrollTo,
  maxHeight,
  onLineClick,
}: {
  code: string;
  lang: string;
  startLine?: number;
  /** File line numbers the author spotlit. */
  highlight?: number[];
  /** File line numbers the voice is pointing at right now. */
  pointed?: number[];
  annotations?: { line: number; text: string }[];
  /** Scroll this file line into view when it changes. */
  scrollTo?: number;
  maxHeight?: string;
  onLineClick?: (line: number) => void;
}) {
  const tokens = useTokens(code, lang);
  const lines = useMemo(() => code.split("\n"), [code]);
  const hot = useMemo(() => new Set(highlight), [highlight]);
  const point = useMemo(() => new Set(pointed), [pointed]);
  const notes = useMemo(() => new Map(annotations.map((a) => [a.line, a.text])), [annotations]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = pointed[0] ?? scrollTo;
    if (!target || !box.current) return;
    const row = box.current.querySelector<HTMLElement>(`[data-line="${target}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollTo, pointed, tokens]);

  const gutter = String(startLine + lines.length).length;

  return (
    <div ref={box} className="overflow-auto font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
      <div className="min-w-max py-2">
        {lines.map((line, i) => {
          const n = startLine + i;
          const isPoint = point.has(n);
          const isHot = hot.has(n);
          const note = notes.get(n);
          return (
            <div key={n}>
              <div
                data-line={n}
                onClick={onLineClick ? () => onLineClick(n) : undefined}
                className={`flex pr-4 transition-colors duration-300 ${
                  isPoint ? "bg-course/20" : isHot ? "bg-static/[0.09]" : ""
                } ${onLineClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}
                style={{ boxShadow: isPoint ? "inset 3px 0 0 var(--course)" : isHot ? "inset 3px 0 0 var(--static)" : undefined }}
              >
                <span className="select-none px-3 text-right text-muted/50" style={{ minWidth: `${gutter + 2}ch` }}>
                  {n}
                </span>
                <span className="whitespace-pre">
                  {tokens?.[i]
                    ? tokens[i].map((t, j) => (
                        <span key={j} style={{ color: t.color }}>
                          {t.content}
                        </span>
                      ))
                    : line || " "}
                </span>
              </div>
              {note && (
                <div className="flex pr-4" style={{ paddingLeft: `${gutter + 2}ch` }}>
                  <span className="ml-3 my-0.5 rounded-sm border-l-2 border-runtime bg-runtime/10 px-2 py-0.5 font-sans text-[12.5px] text-runtime">
                    {note}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
