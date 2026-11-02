import { applyOps, type Board, type BoardCommand, type ItemPatch, type Op } from "../../shared/board";
import { runScript } from "./holo";

/**
 * This screen's copy of a board. The server's board, streamed, with what
 * this screen did since laid over it until the server has it too:
 *
 *  - `pending`: ops sent and not yet seen back (an add shows at once);
 *  - `held`: items in a hand or under the mouse right now, moving every
 *    frame — sent to the server a few times a second, so other screens see
 *    them move, and for good when they're let go.
 *
 * Kept outside React: the scene reads it every frame.
 */

type Listener = (b: Board) => void;
const HOLD_SEND_MS = 110;

export class BoardClient {
  server: Board | null = null;
  private pending: { ops: Op[]; ack: number | null }[] = [];
  private held = new Map<string, ItemPatch>();
  private holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();
  private cmdListeners = new Set<(c: BoardCommand) => void>();
  private shown: Board | null = null;
  private building = new Set<string>();
  connected = false;

  constructor(readonly id: string) {}

  open() {
    const es = new EventSource(`/api/board/events?id=${encodeURIComponent(this.id)}`);
    this.es = es;
    es.addEventListener("board", (e) => {
      this.connected = true;
      const b = JSON.parse((e as MessageEvent).data) as Board;
      this.server = b;
      this.pending = this.pending.filter((p) => p.ack === null || p.ack > b.rev);
      this.emit();
      this.buildScripts(b);
    });
    es.addEventListener("command", (e) => {
      const c = JSON.parse((e as MessageEvent).data) as BoardCommand;
      for (const f of this.cmdListeners) f(c);
    });
    es.onerror = () => {
      this.connected = false;
    };
    return () => this.close();
  }

  close() {
    this.es?.close();
    this.es = null;
    for (const t of this.holdTimers.values()) clearTimeout(t);
  }

  subscribe(f: Listener) {
    this.listeners.add(f);
    if (this.shown) f(this.shown);
    return () => this.listeners.delete(f);
  }

  onCommand(f: (c: BoardCommand) => void) {
    this.cmdListeners.add(f);
    return () => this.cmdListeners.delete(f);
  }

  /** The board as this screen should show it. */
  get board(): Board | null {
    return this.shown;
  }

  private emit() {
    const s = this.server;
    if (!s) return;
    let b: Board = s;
    if (this.pending.length || this.held.size) {
      b = { ...s, items: [...s.items], links: s.links.map((l) => ({ ...l })) };
      for (const p of this.pending) applyOps(b, p.ops);
      if (this.held.size) b.items = b.items.map((i) => (this.held.has(i.id) ? { ...i, ...this.held.get(i.id)! } : i));
    }
    this.shown = b;
    for (const f of this.listeners) f(b);
  }

  /** Change the board: shown at once, sent, and kept over the server's until it comes back. */
  apply(ops: Op[], merge?: string) {
    const entry = { ops, ack: null as number | null };
    this.pending.push(entry);
    this.emit();
    void fetch("/api/board/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.id, ops, merge }) })
      .then((r) => r.json())
      .then((j: { rev?: number }) => {
        entry.ack = j.rev ?? 0;
        if (this.server && this.server.rev >= entry.ack) {
          this.pending = this.pending.filter((p) => p !== entry);
          this.emit();
        }
      })
      .catch(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        this.emit();
      });
  }

  /** An item in a hand: shown where it is every frame; sent now and then. */
  hold(id: string, patch: ItemPatch) {
    this.held.set(id, { ...this.held.get(id), ...patch });
    this.emit();
    if (!this.holdTimers.has(id)) {
      this.holdTimers.set(
        id,
        setTimeout(() => {
          this.holdTimers.delete(id);
          const p = this.held.get(id);
          if (p) this.send([{ op: "update", id, patch: p }], `hold:${id}`);
        }, HOLD_SEND_MS),
      );
    }
  }

  /** Let go: the last place it was held is where it stays (one step to undo, however long it was carried). */
  release(id: string, extra: ItemPatch = {}) {
    clearTimeout(this.holdTimers.get(id));
    this.holdTimers.delete(id);
    const p = { ...this.held.get(id), ...extra };
    this.held.delete(id);
    if (Object.keys(p).length) this.apply([{ op: "update", id, patch: p }], `hold:${id}`);
    else this.emit();
  }

  isHeld(id: string) {
    return this.held.has(id);
  }

  /** Sent without being shown first: it's already shown (a held item). */
  private send(ops: Op[], merge?: string) {
    void fetch("/api/board/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.id, ops, merge }) }).catch(() => {});
  }

  undo() {
    void fetch("/api/board/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.id }) });
  }

  redo() {
    void fetch("/api/board/redo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.id }) });
  }

  /**
   * Holograms made by a script: built here, in the sandbox, the first time
   * this screen sees one that hasn't been built, and sent back to be kept.
   */
  private buildScripts(b: Board) {
    for (const it of b.items) {
      const s = it.holo?.script;
      if (!s || it.holo?.builtFrom === s) continue;
      const key = `${it.id}:${s.length}:${hash(s)}`;
      if (this.building.has(key)) continue;
      this.building.add(key);
      void runScript(s).then((r) =>
        fetch("/api/board/holo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: this.id, itemId: it.id, script: s, parts: r.ok ? r.parts : undefined, error: r.ok ? undefined : r.error }),
        }).catch(() => this.building.delete(key)),
      );
    }
  }
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
