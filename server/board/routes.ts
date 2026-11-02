import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardScreen, Op, Part } from "../../shared/board";
import { ARRANGEMENTS, arrange, type Arrangement } from "../../shared/boardLayout";
import { askBoard, stopBoardAgent } from "./agent";
import { reportBuild } from "./holo";
import { change, createBoard, deleteBoard, getBoard, listBoards, onCommand, redo, undo, watch } from "./store";

/** The workshop's API, under /api/board(s). Returns false for anything else. */
export async function boardApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  h: { json: (res: ServerResponse, status: number, body: unknown) => void; body: <T>(req: IncomingMessage) => Promise<T> },
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/board")) return false;
  const route = `${req.method} ${url.pathname}`;
  const { json, body } = h;
  switch (route) {
    case "GET /api/boards":
      json(res, 200, await listBoards());
      return true;
    case "POST /api/boards": {
      const b = await body<{ name?: string }>(req);
      json(res, 200, await createBoard(b.name ?? ""));
      return true;
    }
    case "DELETE /api/boards": {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "Which board?" }), true;
      await deleteBoard(id);
      json(res, 200, { ok: true });
      return true;
    }
    case "GET /api/board": {
      const l = await getBoard(url.searchParams.get("id") ?? "");
      if (!l) return json(res, 404, { error: "No such board." }), true;
      json(res, 200, l.board);
      return true;
    }
    case "GET /api/board/events": {
      const id = url.searchParams.get("id") ?? "";
      const l = await getBoard(id);
      if (!l) return json(res, 404, { error: "No such board." }), true;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      // Coalesced: a drag or the agent can change it many times a second.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let latest = l.board;
      const flush = () => {
        timer = undefined;
        res.write(`event: board\ndata: ${JSON.stringify(latest)}\n\n`);
      };
      flush();
      const off = watch(id, (b) => {
        latest = b;
        timer ??= setTimeout(flush, 33);
      });
      const offCmd = onCommand(id, (c) => res.write(`event: command\ndata: ${JSON.stringify(c)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        off();
        offCmd();
        clearTimeout(timer);
        clearInterval(ping);
      });
      return true;
    }
    case "POST /api/board/ops": {
      const b = await body<{ id?: string; ops?: Op[]; merge?: string }>(req);
      if (!b.id || !Array.isArray(b.ops)) return json(res, 400, { error: "Need id and ops." }), true;
      const board = await change(b.id, b.ops, b.merge);
      if (!board) return json(res, 404, { error: "No such board." }), true;
      json(res, 200, { ok: true, rev: board.rev });
      return true;
    }
    case "POST /api/board/undo":
    case "POST /api/board/redo": {
      const b = await body<{ id?: string }>(req);
      const done = b.id ? await (route.endsWith("undo") ? undo(b.id) : redo(b.id)) : false;
      json(res, 200, { ok: done });
      return true;
    }
    case "POST /api/board/arrange": {
      const b = await body<{ id?: string; ids?: string[]; how?: Arrangement }>(req);
      const l = b.id ? await getBoard(b.id) : null;
      if (!l || !b.how || !ARRANGEMENTS.includes(b.how)) return json(res, 400, { error: "Need a board and an arrangement." }), true;
      const ids = b.ids?.length ? b.ids : l.board.items.filter((i) => i.kind !== "frame" && i.kind !== "ink").map((i) => i.id);
      const center = b.ids?.length ? centroid(l.board.items.filter((i) => ids.includes(i.id)).map((i) => i.pos)) : undefined;
      const at = arrange(l.board, ids, b.how, { center });
      await change(b.id!, [...at].map(([id, pos]) => ({ op: "update" as const, id, patch: { pos } })));
      json(res, 200, { ok: true });
      return true;
    }
    case "POST /api/board/ask": {
      const b = await body<{ id?: string; request?: string; screen?: BoardScreen }>(req);
      if (!b.id || !b.request?.trim()) return json(res, 400, { error: "Need a board and a request." }), true;
      // Answered at once; the board (and its activity line) shows the work as it happens.
      void askBoard(b.id, b.request.trim(), { ...b.screen, boardId: b.id });
      json(res, 200, { ok: true });
      return true;
    }
    case "POST /api/board/stop": {
      const b = await body<{ id?: string }>(req);
      json(res, 200, { ok: b.id ? stopBoardAgent(b.id) : false });
      return true;
    }
    case "POST /api/board/holo": {
      const b = await body<{ id?: string; itemId?: string; script?: string; parts?: Part[]; error?: string }>(req);
      if (!b.id || !b.itemId || typeof b.script !== "string") return json(res, 400, { error: "Need board, item and script." }), true;
      await reportBuild(b.id, b.itemId, b.script, { parts: Array.isArray(b.parts) ? b.parts.slice(0, 2000) : undefined, error: b.error?.slice(0, 2000) });
      json(res, 200, { ok: true });
      return true;
    }
  }
  return false;
}

function centroid(ps: [number, number, number][]): [number, number, number] {
  if (!ps.length) return [0, 0, 0];
  const s = ps.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return [s[0] / ps.length, 0, s[2] / ps.length];
}
