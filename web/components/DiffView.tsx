import { useEffect, useMemo, useState } from "react";
import { codeToTokens, type BundledLanguage, type ThemedToken } from "shiki";

/**
 * A unified diff, rendered for reading: hunks with both line numbers, the
 * change itself in diff colours, and the code still syntax-highlighted. The
 * diff text is git's own; nothing here is generated.
 */

type Row =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; text: string; old?: number; neu?: number };

export function parseDiff(diff: string): { rows: Row[]; add: number; del: number; binary: boolean } {
  const rows: Row[] = [];
  let old = 0;
  let neu = 0;
  let add = 0;
  let del = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      old = Number(h[1]);
      neu = Number(h[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: h[3].trim() });
      continue;
    }
    if (!inHunk) continue; // file headers: diff --git, index, ---, +++
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), neu: neu++ });
      add++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), old: old++ });
      del++;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), old: old++, neu: neu++ });
    }
    // "\ No newline at end of file" and trailing blanks are skipped.
  }
  return { rows, add, del, binary: /^Binary files /m.test(diff) };
}

const GRAMMAR: Record<string, string> = { docker: "dockerfile", make: "makefile" };

export function DiffView({ diff, lang, maxHeight }: { diff: string; lang: string; maxHeight?: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const code = useMemo(() => parsed.rows.filter((r) => r.kind !== "hunk").map((r) => r.text), [parsed]);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  // Highlight all changed and context lines as one block: hunks are pieces of
  // the same file, so the grammar mostly stays in step, and one call is cheap.
  useEffect(() => {
    let live = true;
    setTokens(null);
    if (code.length > 5000) return;
    const render = (l: string) =>
      codeToTokens(code.join("\n"), { lang: l as BundledLanguage, theme: "tokyo-night" }).then((r) => live && setTokens(r.tokens));
    render(GRAMMAR[lang] ?? lang).catch(() => render("text").catch(() => {}));
    return () => {
      live = false;
    };
  }, [code, lang]);

  if (parsed.binary) return <p className="px-3 py-2 text-[13px] text-muted">Binary file changed.</p>;
  if (!parsed.rows.length) return <p className="px-3 py-2 text-[13px] text-muted">No changes in this range.</p>;

  let i = 0;
  return (
    <div className="overflow-auto font-mono text-[12.5px] leading-[1.6]" style={{ maxHeight }}>
      <div className="min-w-max py-1">
        {parsed.rows.map((r, n) => {
          if (r.kind === "hunk") {
            return (
              <div key={n} className="mt-1 border-y border-line/60 bg-panel2/70 px-3 py-0.5 text-[11.5px] text-muted first:mt-0">
                {r.text || "…"}
              </div>
            );
          }
          const line = tokens?.[i];
          const text = r.text;
          i++;
          const bg = r.kind === "add" ? "bg-good/[0.10]" : r.kind === "del" ? "bg-bad/[0.11]" : "";
          const bar = r.kind === "add" ? "inset 3px 0 0 var(--good)" : r.kind === "del" ? "inset 3px 0 0 var(--bad)" : undefined;
          return (
            <div key={n} className={`flex pr-4 ${bg}`} style={{ boxShadow: bar }}>
              <span className="w-[4.5ch] select-none pr-1 text-right text-muted/45">{r.old ?? ""}</span>
              <span className="w-[4.5ch] select-none pr-1 text-right text-muted/45">{r.neu ?? ""}</span>
              <span className={`w-[2ch] select-none text-center ${r.kind === "add" ? "text-good" : r.kind === "del" ? "text-bad" : "text-muted/40"}`}>
                {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
              </span>
              <span className={`whitespace-pre ${r.kind === "del" ? "opacity-75" : ""}`}>
                {line ? line.map((t, j) => <span key={j} style={{ color: t.color }}>{t.content}</span>) : text || " "}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono text-[11.5px] tabular-nums">
      <span className="text-good">+{add}</span> <span className="text-bad">−{del}</span>
    </span>
  );
}
