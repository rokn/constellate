import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardSummary } from "./board";
import { boardTree, boardUrl, codeUrl, findBoardByName, flatTree, keepViews, parseRoute, pathTo } from "./project";

const board = (id: string, name: string, parent?: string, createdAt = 0): BoardSummary => ({ id, name, parent, createdAt, updatedAt: createdAt, items: 0 }) as BoardSummary;

test("parseRoute reads the app's addresses", () => {
  assert.deepEqual(parseRoute("/projects"), { kind: "projects" });
  assert.deepEqual(parseRoute("/p/abc/code"), { kind: "code", pid: "abc" });
  assert.deepEqual(parseRoute("/p/abc/code/"), { kind: "code", pid: "abc" });
  assert.deepEqual(parseRoute("/p/abc/board"), { kind: "board", pid: "abc", boardId: undefined });
  assert.deepEqual(parseRoute("/p/abc/board/b-1"), { kind: "board", pid: "abc", boardId: "b-1" });
  assert.deepEqual(parseRoute("/p/abc"), { kind: "project", pid: "abc" });
  assert.deepEqual(parseRoute("/"), { kind: "home" });
  assert.deepEqual(parseRoute("/nowhere"), { kind: "home" });
});

test("parseRoute finds the addresses from before projects", () => {
  assert.deepEqual(parseRoute("/board"), { kind: "legacy-board", boardId: undefined });
  assert.deepEqual(parseRoute("/board/b1"), { kind: "legacy-board", boardId: "b1" });
  assert.deepEqual(parseRoute("/", "?root=/code/app&module=api"), { kind: "legacy-code" });
  assert.deepEqual(parseRoute("/", "?"), { kind: "home" });
});

test("codeUrl carries a code link, and parses back as the Code view", () => {
  assert.equal(codeUrl("p1"), "/p/p1/code");
  const url = codeUrl("p1", { root: "/code/app", module: "api", paths: ["src/a.ts", "src/b"], only: true, label: "Payments & co", from: { boardId: "b1", itemId: "i1" }, ask: "where is it?" });
  const [path, search] = url.split("?");
  assert.deepEqual(parseRoute(path, `?${search}`), { kind: "code", pid: "p1" });
  const q = new URLSearchParams(search);
  assert.equal(q.get("root"), "/code/app");
  assert.equal(q.get("module"), "api");
  assert.equal(q.get("paths"), "src/a.ts,src/b");
  assert.equal(q.get("only"), "1");
  assert.equal(q.get("label"), "Payments & co");
  assert.equal(q.get("from"), "b1:i1");
  assert.equal(q.get("ask"), "where is it?");
  assert.equal(new URLSearchParams(codeUrl("p1", { from: { boardId: "b1" } }).split("?")[1]).get("from"), "b1");
});

test("boardUrl names the board, and the item to show on it", () => {
  assert.equal(boardUrl("p1", "b1"), "/p/p1/board/b1");
  assert.equal(boardUrl("p1", "b1", "item 1"), "/p/p1/board/b1?item=item%201");
});

test("boardTree nests boards under their parents, oldest first", () => {
  const tree = boardTree([board("c", "Staging", "b", 3), board("b", "Deployments", undefined, 2), board("a", "Architecture", undefined, 1), board("d", "Orphan", "gone", 4), board("e", "Prod", "b", 2)]);
  assert.deepEqual(tree.map((n) => n.id), ["a", "b", "d"]);
  assert.deepEqual(tree[1].children.map((n) => n.id), ["e", "c"]);
  assert.deepEqual(flatTree(tree).map((x) => `${x.depth}:${x.node.id}`), ["0:a", "0:b", "1:e", "1:c", "0:d"]);
});

test("boardTree keeps a board that names itself as its parent at the top", () => {
  assert.deepEqual(boardTree([board("a", "Loop", "a")]).map((n) => n.id), ["a"]);
});

test("pathTo walks from the top of the tree to a board", () => {
  const tree = boardTree([board("a", "Architecture"), board("b", "Payments", "a"), board("c", "Ledger", "b")]);
  assert.deepEqual(pathTo(tree, "c").map((n) => n.id), ["a", "b", "c"]);
  assert.deepEqual(pathTo(tree, "a").map((n) => n.id), ["a"]);
  assert.deepEqual(pathTo(tree, "nope"), []);
});

test("findBoardByName prefers exact, then the last part, then a start, then anywhere", () => {
  const tree = boardTree([board("a", "Architecture", undefined, 1), board("b", "Architecture › Payments", "a", 2), board("c", "Deployments", undefined, 3), board("d", "Payments roadmap", undefined, 4)]);
  assert.equal(findBoardByName(tree, "architecture")?.id, "a");
  assert.equal(findBoardByName(tree, " Payments ")?.id, "b");
  assert.equal(findBoardByName(tree, "deploy")?.id, "c");
  assert.equal(findBoardByName(tree, "roadmap")?.id, "d");
  assert.equal(findBoardByName(tree, ""), undefined);
  assert.equal(findBoardByName(tree, "nothing like it"), undefined);
});

test("keepViews keeps each view once it has been opened", () => {
  let k = keepViews({ code: false }, { pid: "p1", view: null });
  assert.deepEqual(k, { pid: "p1", code: false });
  k = keepViews(k, { pid: "p1", view: "code", boards: ["b1", "b2"] });
  assert.deepEqual(k, { pid: "p1", code: true });
  k = keepViews(k, { pid: "p1", view: "board", boardId: "b1", boards: ["b1", "b2"] });
  assert.deepEqual(k, { pid: "p1", code: true, boardId: "b1" });
  // Back in the Code view, the board is still there; and it follows the boards view to another board.
  k = keepViews(k, { pid: "p1", view: "code", boards: ["b1", "b2"] });
  assert.deepEqual(k, { pid: "p1", code: true, boardId: "b1" });
  k = keepViews(k, { pid: "p1", view: "board", boardId: "b2", boards: ["b1", "b2"] });
  assert.equal(k.boardId, "b2");
});

test("keepViews lets go of a deleted board, and of another project's views", () => {
  const k = { pid: "p1", code: true, boardId: "b1" };
  assert.deepEqual(keepViews(k, { pid: "p1", view: "code", boards: ["b2"] }), { pid: "p1", code: true, boardId: undefined });
  // Not known yet (the project is loading): kept.
  assert.deepEqual(keepViews(k, { pid: "p1", view: null }), k);
  assert.deepEqual(keepViews(k, { pid: "p2", view: null }), { pid: "p2", code: false });
  assert.deepEqual(keepViews(k, { pid: undefined, view: null }), { pid: undefined, code: false });
  // The input is never changed.
  assert.deepEqual(k, { pid: "p1", code: true, boardId: "b1" });
});
