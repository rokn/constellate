import { useEffect, useMemo, useRef, useState } from "react";
import { COLORS, LINK_STYLES, PROTOCOLS, colorOf, nameOf, protocolOf, type Board, type Link } from "../../shared/board";
import { fromClip, fromMermaid, toClip, toMarkdown, toMermaid } from "../../shared/exchange";
import { LIBRARY } from "../../shared/holoLibrary";
import { TEMPLATE_NAMES } from "../../shared/templates";
import type { BoardClient } from "./client";
import type { Layers } from "./fx";

/**
 * The desktop's other panels: history (versions), export and import, find,
 * layers, the link inspector, the player's bar, and where you are (the
 * boards this one is inside).
 */

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function download(name: string, data: string, type: string) {
  const a = document.createElement("a");
  a.href = data.startsWith("data:") ? data : URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const fileName = (b: Board) => b.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board";

/* -------------------------------- history -------------------------------- */

type VersionSummary = { id: string; at: number; label: string; items: number; links: number };

export function HistoryPanel({ boardId, onPreview, previewing, onClose }: { boardId: string; onPreview: (v: { id: string; label: string; board: Board } | null) => void; previewing: string | null; onClose: () => void }) {
  const [list, setList] = useState<VersionSummary[]>([]);
  const [label, setLabel] = useState("");
  const load = () =>
    void fetch(`/api/board/versions?id=${boardId}`)
      .then((r) => r.json())
      .then(setList);
  useEffect(load, [boardId]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = async (v: VersionSummary) => {
    if (previewing === v.id) return onPreview(null);
    const full = (await (await fetch(`/api/board/version?id=${boardId}&v=${v.id}`)).json()) as { items: Board["items"]; links: Board["links"]; name: string };
    onPreview({ id: v.id, label: v.label, board: { id: boardId, name: full.name, items: full.items, links: full.links, createdAt: 0, updatedAt: v.at, rev: -1 } });
  };
  return (
    <div className="ws-panel absolute bottom-24 right-4 top-20 z-20 flex w-80 flex-col">
      <div className="flex items-center justify-between border-b border-cyan-300/10 px-3 py-2">
        <div className="ws-brand text-sm">HISTORY</div>
        <button className="text-xs text-[#7fa6bd] hover:text-white" onClick={onClose}>
          ✕
        </button>
      </div>
      <form
        className="flex gap-1.5 border-b border-cyan-300/10 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post("/api/board/versions", { id: boardId, label: label || "Saved" }).then(load);
          setLabel("");
        }}
      >
        <input className="ws-input min-w-0 flex-1 py-1 text-sm" placeholder="Name this version…" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="ws-btn">Save</button>
      </form>
      <div className="flex-1 overflow-auto p-2">
        {!list.length && <div className="p-2 text-sm text-[#7fa6bd]">No versions yet. One is kept before every request to Jarvis, and as you work.</div>}
        {list.map((v) => (
          <button key={v.id} className={`mb-1 block w-full rounded border px-2 py-1.5 text-left text-sm ${previewing === v.id ? "border-[#ffb547] bg-amber-300/10" : "border-transparent hover:border-cyan-300/25 hover:bg-cyan-300/5"}`} onClick={() => void preview(v)}>
            <div className="truncate text-[#dff6ff]">{v.label}</div>
            <div className="text-[11px] text-[#7fa6bd]">
              {new Date(v.at).toLocaleString()} · {v.items} items · {v.links} links
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Over the board while an old version is shown: what it is, and the way back (or forward to it). */
export function PreviewBar({ label, onRestore, onExit }: { label: string; onRestore: () => void; onExit: () => void }) {
  return (
    <div className="ws-panel absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-3 px-4 py-2 text-sm">
      <span className="text-[#ffb547]">◆ Viewing an earlier version:</span>
      <span className="max-w-xs truncate text-[#dff6ff]">{label}</span>
      <button className="ws-btn ws-btn-accent" onClick={onRestore}>
        Restore it
      </button>
      <button className="ws-btn" onClick={onExit}>
        Back to now
      </button>
    </div>
  );
}

/* ---------------------------- export / import ---------------------------- */

export function ExchangeDialog({ board, client, capture, focus, onClose }: { board: Board; client: BoardClient; capture: () => string; focus: () => [number, number, number]; onClose: () => void }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const copy = (what: string, s: string) => {
    void navigator.clipboard?.writeText(s).then(() => setCopied(what));
  };
  const importIt = () => {
    const t = text.trim();
    const got = fromClip(t, focus()) ?? (t ? fromMermaid(t, focus()) : null);
    if (!got?.items.length) return setErr("Nothing I can read: paste a Mermaid flowchart or a workshop JSON export.");
    client.apply([{ op: "add", items: got.items, links: got.links }]);
    onClose();
  };
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/40" onMouseDown={onClose}>
      <div className="ws-panel grid w-[46rem] grid-cols-2 gap-5 p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div>
          <div className="ws-title mb-2">Export “{board.name}”</div>
          <div className="flex flex-col gap-1.5">
            <button className="ws-btn !justify-between" onClick={() => download(`${fileName(board)}.md`, toMarkdown(board), "text/markdown")}>
              Design doc <span className="opacity-50">.md</span>
            </button>
            <button className="ws-btn !justify-between" onClick={() => copy("mermaid", toMermaid(board))}>
              {copied === "mermaid" ? "Copied ✓" : "Mermaid diagram"} <span className="opacity-50">copy</span>
            </button>
            <button className="ws-btn !justify-between" onClick={() => download(`${fileName(board)}.json`, toClip(board), "application/json")}>
              Workshop JSON <span className="opacity-50">.json</span>
            </button>
            <button className="ws-btn !justify-between" onClick={() => download(`${fileName(board)}.png`, capture(), "image/png")}>
              Snapshot of this view <span className="opacity-50">.png</span>
            </button>
          </div>
          <div className="mt-3 text-[11px] leading-snug text-[#7fa6bd]">The design doc has every component by group, the connections, the notes, the review findings, and the diagram in Mermaid.</div>
        </div>
        <div className="flex flex-col">
          <div className="ws-title mb-2">Import</div>
          <textarea
            className="ws-input h-40 resize-none font-mono text-xs"
            placeholder={"Paste a Mermaid flowchart…\n\nflowchart LR\n  web[/Web/] --> api{{API}}\n  api --> db[(Postgres)]\n\n…or a workshop JSON export."}
            value={text}
            onChange={(e) => (setText(e.target.value), setErr(null))}
          />
          <div className="mt-2 flex items-center gap-2">
            <label className="ws-btn cursor-pointer">
              Open file…
              <input type="file" accept=".json,.mmd,.md,.txt" className="hidden" onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
            </label>
            <button className="ws-btn ws-btn-accent ml-auto" onClick={importIt} disabled={!text.trim()}>
              Add to the board
            </button>
          </div>
          {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
          <div className="mt-2 text-[11px] text-[#7fa6bd]">Tip: ⌘V on the board pastes either straight in.</div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- find --------------------------------- */

export function FindPalette({ board, onPick, onClose }: { board: Board; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const hits = useMemo(() => {
    const n = q.trim().toLowerCase();
    const all = board.items.filter((it) => it.kind !== "ink");
    if (!n) return all.slice(0, 12);
    return all
      .map((it) => {
        const hay = `${nameOf(it)} ${it.body ?? ""} ${it.kind} ${(it.tags ?? []).join(" ")} ${it.status ?? ""}`.toLowerCase();
        const at = hay.indexOf(n);
        return { it, score: at < 0 ? -1 : nameOf(it).toLowerCase().startsWith(n) ? 3 : at < nameOf(it).length ? 2 : 1 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.it);
  }, [q, board.items]);
  return (
    <div className="absolute inset-0 z-30 flex justify-center bg-black/30 pt-[14vh]" onMouseDown={onClose}>
      <div className="ws-panel h-fit w-[30rem] p-2" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="ws-input w-full"
          placeholder="Find on the board…"
          value={q}
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(hits.length - 1, x + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            if (e.key === "Enter" && hits[i]) (onPick(hits[i].id), onClose());
          }}
        />
        <div className="mt-1 max-h-80 overflow-auto">
          {hits.map((it, k) => (
            <button key={it.id} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${k === i ? "bg-cyan-300/10" : ""}`} onMouseEnter={() => setI(k)} onClick={() => (onPick(it.id), onClose())}>
              <span className="h-2 w-2 rotate-45" style={{ background: colorOf(it.color) }} />
              <span className="flex-1 truncate text-[#dff6ff]">{nameOf(it)}</span>
              <span className="text-[11px] uppercase tracking-wider text-[#7fa6bd]">{it.kind}</span>
            </button>
          ))}
          {!hits.length && <div className="p-2 text-sm text-[#7fa6bd]">Nothing called that.</div>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- layers -------------------------------- */

const LAYERS = [
  ["architecture", "Architecture"],
  ["notes", "Notes & text"],
  ["frames", "Frames"],
  ["ink", "Ink"],
  ["holograms", "Holograms"],
  ["links", "Links"],
] as const;

export function LayersPopover({ layers, selected, onChange, onClose }: { layers: Layers; selected: string[]; onChange: (l: Partial<Layers>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener("mousedown", f), 0);
    return () => window.removeEventListener("mousedown", f);
  }, [onClose]);
  return (
    <div ref={ref} className="ws-panel absolute right-4 top-16 z-30 w-56 p-3 text-sm">
      <div className="ws-title mb-2">Layers</div>
      {LAYERS.map(([id, label]) => {
        const shown = !layers.hide.includes(id);
        return (
          <button key={id} className="flex w-full items-center justify-between py-1 text-[#cfeaf6]" onClick={() => onChange({ hide: shown ? [...layers.hide, id] : layers.hide.filter((h) => h !== id) })}>
            {label}
            <span className={`h-3 w-3 rotate-45 border ${shown ? "border-[#5fd4ff] bg-[#5fd4ff]" : "border-[#4f7286]"}`} />
          </button>
        );
      })}
      <div className="mt-2 border-t border-cyan-300/10 pt-2">
        {layers.isolate ? (
          <button className="ws-btn w-full" onClick={() => onChange({ isolate: null })}>
            Show everything again
          </button>
        ) : (
          <button className="ws-btn w-full" disabled={!selected.length} onClick={() => onChange({ isolate: selected })}>
            Isolate the selection
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- link inspector ---------------------------- */

export function LinkInspector({ link, board, client, onClose }: { link: Link; board: Board; client: BoardClient; onClose: () => void }) {
  const [label, setLabel] = useState(link.label ?? "");
  useEffect(() => setLabel(link.label ?? ""), [link.id, link.label]);
  const name = (id: string) => {
    const i = board.items.find((x) => x.id === id);
    return i ? nameOf(i) : "?";
  };
  const patch = (p: Partial<Link>) => client.apply([{ op: "updateLink", id: link.id, patch: p }]);
  return (
    <div className="ws-panel absolute right-4 top-20 w-72 p-3">
      <div className="flex items-center justify-between">
        <div className="ws-title">Link</div>
        <button className="text-xs text-[#7fa6bd] hover:text-white" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="mt-1 text-sm text-[#dff6ff]">
        {name(link.from)} <span className="text-[#ffb547]">{link.both ? "↔" : "→"}</span> {name(link.to)}
      </div>
      <input
        className="ws-input mt-2 w-full"
        placeholder="What flows: REST, order.created…"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label !== (link.label ?? "") && patch({ label: label || (null as never) })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <div className="ws-title mb-1 mt-3">Kind</div>
      <div className="flex gap-1">
        {LINK_STYLES.map((s) => (
          <button key={s} className={`flex-1 rounded border px-1 py-1 text-xs capitalize ${(link.style ?? "sync") === s ? "border-[#ffb547] text-[#ffb547]" : "border-cyan-300/20 text-[#9fc3d6]"}`} onClick={() => patch({ style: s })}>
            {s}
          </button>
        ))}
      </div>
      <div className="ws-title mb-1 mt-3">Protocol {!link.protocol && protocolOf(link) ? <span className="normal-case tracking-normal text-[#4f7286]">· guessed {protocolOf(link)}</span> : null}</div>
      <select className="ws-input w-full py-1 text-sm" value={link.protocol ?? ""} onChange={(e) => patch({ protocol: (e.target.value || null) as never })}>
        <option value="">From the label</option>
        {PROTOCOLS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <div className="ws-title mb-1 mt-3">Sample message</div>
      <textarea
        className="ws-input w-full resize-none font-mono text-[11px]"
        rows={3}
        placeholder={'{"orderId": 42, "total": 19.90}'}
        defaultValue={link.sample ?? ""}
        key={link.id}
        onBlur={(e) => e.target.value !== (link.sample ?? "") && patch({ sample: e.target.value || (null as never) })}
      />
      <div className="ws-title mb-1 mt-3">Colour</div>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(COLORS).map(([n, c]) => (
          <button key={n} className="h-5 w-5 rounded-full" style={{ background: c, boxShadow: link.color === n ? `0 0 0 2px #02060d, 0 0 0 3px ${c}` : undefined }} onClick={() => patch({ color: n })} />
        ))}
      </div>
      <div className="mt-3 flex gap-1.5">
        <button className={`ws-btn flex-1 ${link.both ? "ws-btn-accent" : ""}`} onClick={() => patch({ both: !link.both })}>
          Both ways
        </button>
        <button className="ws-btn flex-1" onClick={() => client.apply([{ op: "unlink", ids: [link.id] }, { op: "link", links: [{ ...link, id: `${link.id}r`, from: link.to, to: link.from }] }])}>
          Reverse
        </button>
      </div>
      <button className="ws-btn mt-1.5 w-full !text-red-300" onClick={() => (client.apply([{ op: "unlink", ids: [link.id] }]), onClose())}>
        Delete link
      </button>
    </div>
  );
}

/* --------------------------------- player -------------------------------- */

export function PlayerBar({ caption, onStop }: { caption: { text: string; title?: string; step: number; of: number }; onStop: () => void }) {
  return (
    <div className="ws-panel absolute left-1/2 top-16 z-20 w-[min(44rem,90vw)] -translate-x-1/2 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="ws-brand text-xs">{caption.title ?? "Playing"}</span>
        <div className="flex flex-1 gap-1">
          {Array.from({ length: caption.of }, (_, k) => (
            <span key={k} className={`h-1 flex-1 rounded ${k < caption.step ? "bg-[#ffb547]" : "bg-cyan-300/15"}`} />
          ))}
        </div>
        <button className="ws-btn" onClick={onStop}>
          Stop
        </button>
      </div>
      <div className="mt-2 text-[15px] text-[#dff6ff]">{caption.text}</div>
    </div>
  );
}

/* ------------------------------- palettes -------------------------------- */

export function LibraryList({ onPick }: { onPick: (name: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {LIBRARY.map((p) => (
        <button key={p.name} className="ws-pal" style={{ ["--c" as string]: colorOf(p.color) }} onClick={() => onPick(p.name)} title={`Place a ${p.name.toLowerCase()} hologram`}>
          <span className="ws-pal-dot" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

export function TemplateList({ onPick }: { onPick: (name: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {TEMPLATE_NAMES.map((t) => (
        <button key={t.name} className="ws-pal !items-start !py-1.5" style={{ ["--c" as string]: "#ffb547" }} onClick={() => onPick(t.name)} title={t.about}>
          <span className="ws-pal-dot mt-1" />
          <span>
            <span className="block">{t.name}</span>
            <span className="block text-[10.5px] leading-tight text-[#6f93a8]">{t.about}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------- where -------------------------------- */

/** The boards this one is inside, back up to the top. */
/** How deep a board is, in C4's words: the system in its context, its containers, their components, the code. */
export const C4_LEVELS = ["Context", "Containers", "Components", "Code", "Detail"];

export function Breadcrumbs({ board, open }: { board: Board; open: (id: string) => void }) {
  const [chain, setChain] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: { id: string; name: string }[] = [];
      let p = board.parent;
      while (p && out.length < 8) {
        out.unshift({ id: p.boardId, name: p.name });
        const r = await fetch(`/api/board?id=${p.boardId}`);
        if (!r.ok) break;
        p = ((await r.json()) as Board).parent;
      }
      if (live) setChain(out);
    })();
    return () => {
      live = false;
    };
  }, [board.id, board.parent]);
  const level = C4_LEVELS[Math.min(C4_LEVELS.length - 1, chain.length)];
  if (!board.parent)
    return board.items.length ? (
      <span className="text-[10px] uppercase tracking-[0.25em] text-[#4f7286]" title="C4 level: zoom into an item (or press I) to go a level down">
        {C4_LEVELS[0]}
      </span>
    ) : null;
  return (
    <div className="flex items-center gap-1 text-xs text-[#7fa6bd]">
      <span className="mr-1 text-[10px] uppercase tracking-[0.25em] text-[#4f7286]">{level}</span>
      {chain.map((c) => (
        <span key={c.id} className="flex items-center gap-1">
          <button className="hover:text-white" onClick={() => open(c.id)}>
            {c.name.split(" › ").pop()}
          </button>
          <span>›</span>
        </span>
      ))}
      <span className="text-[#ffb547]">inside</span>
    </div>
  );
}
