import * as THREE from "three";
import { viewOn } from "../shell/view";
import { newId, type Vec3 } from "../../shared/board";
import type { Ctl } from "./ctl";
import { magnet } from "./magnet";
import type { BoardScene } from "./scene";
import { num, on } from "./tune";
import { inkStroke } from "./inkStroke";
import { fromClip, fromMermaid, toClip } from "../../shared/exchange";

/** What was copied, when the system clipboard can't be read. */
let clip = "";

/**
 * The mouse and keyboard. Left-drag on open table orbits; on an item it moves
 * the item across the table (with Shift, up and down). Click selects
 * (Shift adds), double-click edits words. The connect tool pulls a link from
 * one item to another; the ink tool draws on the table.
 */

const CLICK_SLOP = 4;

export function attachDesktop(scene: BoardScene, ctl: Ctl) {
  const el = scene.renderer.domElement;
  const ndc = new THREE.Vector2();
  const ray = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, scene.camera);
    return { origin: rc.ray.origin.clone(), dir: rc.ray.direction.clone() };
  };

  type Drag =
    | { kind: "item"; id: string; y: number; grabOffset: THREE.Vector3; vertical: boolean; startY: number; startClientY: number; moved: boolean; x0: number; y0: number; others: { id: string; offset: THREE.Vector3 }[] }
    | { kind: "pull"; from: string; x0: number; y0: number }
    | { kind: "ink"; pts: THREE.Vector3[] }
    | { kind: "orbit"; x0: number; y0: number; moved: boolean; link?: string }
    | { kind: "box"; x0: number; y0: number; additive: boolean }
    | { kind: "sweep"; erase: boolean; ids: string[] };
  // The marquee a shift-drag on open table draws.
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;display:none;pointer-events:none;border:1px solid #ffb547;background:rgba(255,181,71,0.08);box-shadow:0 0 12px rgba(255,181,71,0.35);z-index:5";
  el.parentElement?.appendChild(box);
  let drag: Drag | null = null;

  const down = (e: PointerEvent) => {
    if (scene.mode !== "flat" || e.button !== 0) return;
    const { origin, dir } = ray(e);
    const hit = scene.pick(origin, dir);
    const tool = ctl.tool();
    // Items locked: the mouse only turns the view.
    if (on("lockItems")) return;

    if (tool === "lasso" || tool === "erase") {
      // Sweep across items: each one the pointer passes over is collected.
      scene.controls.enabled = false;
      drag = { kind: "sweep", erase: tool === "erase", ids: hit?.kind === "item" ? [hit.id] : [] };
      if (tool === "lasso") ctl.select(drag.ids, e.shiftKey);
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "ink") {
      const p = scene.tablePoint(origin, dir, 0.012);
      if (!p) return;
      scene.controls.enabled = false;
      drag = { kind: "ink", pts: [p] };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (hit?.kind === "item" && tool === "connect") {
      scene.controls.enabled = false;
      drag = { kind: "pull", from: hit.id, x0: e.clientX, y0: e.clientY };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (hit?.kind === "item") {
      const v = scene.views.get(hit.id);
      if (!v) return;
      scene.controls.enabled = false;
      const y = v.item.pos[1];
      const at = scene.tablePoint(origin, dir, y) ?? new THREE.Vector3(...v.item.pos);
      // Moving one of the selection moves all of it; moving a frame moves what's in it.
      let sel = ctl.selected().includes(hit.id) ? ctl.selected().filter((id) => id !== hit.id) : [];
      if (v.item.kind === "frame" && on("frameCarries")) {
        const [w, d] = v.item.size ?? [0.8, 0.5];
        const [fx, , fz] = v.item.pos;
        const inside = ctl.client.board?.items.filter((i) => i.id !== v.id && i.kind !== "frame" && Math.abs(i.pos[0] - fx) <= w / 2 && Math.abs(i.pos[2] - fz) <= d / 2).map((i) => i.id) ?? [];
        sel = [...new Set([...sel, ...inside])];
      }
      const others = sel
        .map((id) => scene.views.get(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .map((o) => ({ id: o.id, offset: new THREE.Vector3(...o.item.pos).sub(new THREE.Vector3(...v.item.pos)) }));
      drag = { kind: "item", id: hit.id, y, grabOffset: new THREE.Vector3(...v.item.pos).sub(at), vertical: e.shiftKey && e.altKey, startY: y, startClientY: e.clientY, moved: false, x0: e.clientX, y0: e.clientY, others };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (hit?.kind === "link" && tool === "select") {
      drag = { kind: "orbit", x0: e.clientX, y0: e.clientY, moved: false, link: hit.id };
      return;
    }
    if (e.shiftKey) {
      // Shift-drag on open table: a box to select what's in it.
      scene.controls.enabled = false;
      drag = { kind: "box", x0: e.clientX, y0: e.clientY, additive: e.metaKey || e.ctrlKey };
      el.setPointerCapture(e.pointerId);
      return;
    }
    drag = { kind: "orbit", x0: e.clientX, y0: e.clientY, moved: false };
  };

  const move = (e: PointerEvent) => {
    if (scene.mode !== "flat") return;
    const { origin, dir } = ray(e);
    if (!drag) {
      const hit = scene.pick(origin, dir);
      scene.setHover(hit && hit.kind !== "table" ? [hit.id] : []);
      el.style.cursor = ctl.tool() === "ink" ? "crosshair" : hit?.kind === "item" ? (ctl.tool() === "connect" ? "alias" : "grab") : "default";
      return;
    }
    if (drag.kind === "orbit") {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > CLICK_SLOP) drag.moved = true;
      return;
    }
    if (drag.kind === "sweep") {
      const hit = scene.pick(origin, dir);
      if (hit?.kind === "item" && !drag.ids.includes(hit.id)) {
        drag.ids.push(hit.id);
        if (!drag.erase) ctl.select([hit.id], true);
      }
      scene.setHover(drag.ids);
      return;
    }
    if (drag.kind === "box") {
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${Math.min(drag.x0, e.clientX) - r.left}px`;
      box.style.top = `${Math.min(drag.y0, e.clientY) - r.top}px`;
      box.style.width = `${Math.abs(e.clientX - drag.x0)}px`;
      box.style.height = `${Math.abs(e.clientY - drag.y0)}px`;
      return;
    }
    if (drag.kind === "ink") {
      const p = scene.tablePoint(origin, dir, 0.012);
      if (p && p.distanceTo(drag.pts[drag.pts.length - 1]) > 0.006) drag.pts.push(p);
      scene.showInk(drag.pts, ctl.inkColor());
      return;
    }
    if (drag.kind === "pull") {
      const v = scene.views.get(drag.from);
      const hit = scene.pick(origin, dir, { ignore: drag.from });
      const to = hit?.kind === "item" ? new THREE.Vector3(...scene.views.get(hit.id)!.item.pos).setY(0.06) : scene.tablePoint(origin, dir, 0.06);
      if (v && to) scene.showPull(new THREE.Vector3(...v.item.pos).setY(v.midY), to);
      scene.setHover(hit?.kind === "item" ? [hit.id] : []);
      return;
    }
    // An item: across the table, or (Shift+Alt) up and down.
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > CLICK_SLOP) drag.moved = true;
    if (!drag.moved) return;
    const v = scene.views.get(drag.id);
    if (!v) return;
    let pos: Vec3;
    if (drag.vertical || e.shiftKey) {
      const dy = (drag.startClientY - e.clientY) * 0.0025 * (scene.camera.position.distanceTo(scene.controls.target) / 2);
      drag.y = Math.max(0, drag.startY + dy);
      pos = [v.item.pos[0], round(drag.y), v.item.pos[2]];
    } else {
      const at = scene.tablePoint(origin, dir, drag.y);
      if (!at) return;
      at.add(drag.grabOffset);
      const g = num("gridSize");
      const snap = (n: number) => (on("snap") ? Math.round(n / g) * g : n);
      pos = [round(snap(at.x)), round(drag.y), round(snap(at.z))];
    }
    if (!drag.others.length && !on("snap")) {
      const m = magnet(ctl.client.board, drag.id, pos);
      pos = m.pos;
      scene.showGuides(m.guides);
    }
    ctl.client.hold(drag.id, { pos });
    for (const o of drag.others) {
      const p = new THREE.Vector3(...pos).add(o.offset);
      ctl.client.hold(o.id, { pos: [round(p.x), round(p.y), round(p.z)] });
    }
  };

  const up = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    scene.controls.enabled = true;
    scene.showGuides(null);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const { origin, dir } = ray(e);
    if (d.kind === "orbit") {
      if (!d.moved && d.link) ctl.selectLink?.(d.link);
      else if (!d.moved) {
        ctl.select([]);
        ctl.selectLink?.(null);
      }
      return;
    }
    if (d.kind === "sweep") {
      scene.setHover([]);
      if (d.erase && d.ids.length) ctl.remove(d.ids);
      return;
    }
    if (d.kind === "box") {
      box.style.display = "none";
      const r = el.getBoundingClientRect();
      const x0 = Math.min(d.x0, e.clientX);
      const x1 = Math.max(d.x0, e.clientX);
      const y0 = Math.min(d.y0, e.clientY);
      const y1 = Math.max(d.y0, e.clientY);
      const ids: string[] = [];
      for (const v of scene.views.values()) {
        if (v.hidden || v.dying) continue;
        const p = v.center().project(scene.camera);
        const sx = r.left + ((p.x + 1) / 2) * r.width;
        const sy = r.top + ((1 - p.y) / 2) * r.height;
        if (p.z < 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(v.id);
      }
      ctl.select(ids, d.additive);
      return;
    }
    if (d.kind === "ink") {
      scene.showInk(null);
      if (d.pts.length < 2) return;
      // Shift keeps it as drawn; otherwise a box, circle, line or arrow comes out clean.
      const ink = inkStroke(d.pts.map((p) => [p.x, p.y, p.z] as Vec3), on("inkShapes") && !e.shiftKey);
      ctl.add("ink", ink.pos, { ...ink.extra, color: ctl.inkColor(), width: 0.005 });
      return;
    }
    if (d.kind === "pull") {
      scene.showPull(null);
      const hit = scene.pick(origin, dir, { ignore: d.from });
      if (hit?.kind === "item") ctl.link(d.from, hit.id);
      return;
    }
    if (!d.moved) {
      ctl.client.release(d.id);
      for (const o of d.others) ctl.client.release(o.id);
      ctl.select([d.id], e.shiftKey || e.metaKey);
      return;
    }
    ctl.client.release(d.id);
    for (const o of d.others) ctl.client.release(o.id);
  };

  const dbl = (e: MouseEvent) => {
    if (scene.mode !== "flat" || on("lockItems")) return;
    const { origin, dir } = ray(e);
    const hit = scene.pick(origin, dir);
    if (hit?.kind === "item") ctl.edit(hit.id);
  };

  const key = (e: KeyboardEvent) => {
    if (!viewOn("board")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const sel = ctl.selected();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) ctl.client.redo();
      else ctl.client.undo();
      return;
    }
    // Copy, cut, paste: items as JSON (across boards), or a Mermaid diagram pasted in.
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x") && sel.length) {
      const b = ctl.client.board;
      if (!b || window.getSelection()?.toString()) return;
      e.preventDefault();
      clip = toClip(b, sel);
      void navigator.clipboard?.writeText(clip).catch(() => {});
      if (e.key.toLowerCase() === "x") ctl.remove(sel);
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      const land = (text: string) => {
        const at = scene.focusPoint();
        const t = text.trim();
        const got = fromClip(t, at) ?? (/^(flowchart|graph)\b/i.test(t) || /-->|==>|-\.->/.test(t) ? fromMermaid(t, at) : null);
        if (!got || !got.items.length) return;
        ctl.client.apply([{ op: "add", items: got.items, links: got.links }]);
        ctl.select(got.items.map((i) => i.id));
      };
      void (navigator.clipboard?.readText?.() ?? Promise.reject()).then((t) => land(t || clip), () => land(clip));
      return;
    }
    if (mod && e.key.toLowerCase() === "d" && sel.length) {
      // Duplicate the selection, a little to the right.
      e.preventDefault();
      const b = ctl.client.board;
      if (!b) return;
      const copies = b.items.filter((i) => sel.includes(i.id)).map((i) => ({ ...structuredClone(i), id: newId(), pos: [i.pos[0] + 0.12, i.pos[1], i.pos[2] + 0.06] as Vec3 }));
      ctl.client.apply([{ op: "add", items: copies }]);
      ctl.select(copies.map((c) => c.id));
      return;
    }
    if (mod) return;
    switch (e.key) {
      case "Delete":
      case "Backspace":
        if (sel.length) ctl.remove(sel);
        break;
      case "Escape":
        if (ctl.tool() !== "select") ctl.setTool("select");
        else ctl.select([]);
        break;
      case "v":
        ctl.setTool("select");
        break;
      case "c":
        ctl.setTool("connect");
        break;
      case "d":
        ctl.setTool(ctl.tool() === "ink" ? "select" : "ink");
        break;
      case "s":
        ctl.setTool(ctl.tool() === "lasso" ? "select" : "lasso");
        break;
      case "x":
        ctl.setTool(ctl.tool() === "erase" ? "select" : "erase");
        break;
      case "f":
        if (sel.length) scene.focus(sel);
        else scene.overview();
        break;
      case "o":
      case "Home":
        scene.overview();
        break;
      case "r":
      case "R":
        for (const id of sel) {
          const it = ctl.client.board?.items.find((i) => i.id === id);
          if (it) ctl.client.apply([{ op: "update", id, patch: { rotY: ((it.rotY ?? 0) + (e.shiftKey ? -15 : 15)) % 360 } }], `rot:${id}`);
        }
        break;
      case "[":
      case "]":
        for (const id of sel) {
          const it = ctl.client.board?.items.find((i) => i.id === id);
          if (it) ctl.client.apply([{ op: "update", id, patch: { scale: round((it.scale ?? 1) * (e.key === "]" ? 1.15 : 1 / 1.15)) } }], `scale:${id}`);
        }
        break;
      case "e":
        for (const id of sel) {
          const it = ctl.client.board?.items.find((i) => i.id === id);
          if (it?.kind === "holo") ctl.client.apply([{ op: "update", id, patch: { explode: (it.explode ?? 0) > 0.5 ? 0 : 1 } }]);
        }
        break;
      case "Enter":
        if (sel.length === 1) ctl.edit(sel[0]);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  el.addEventListener("pointerdown", down, { capture: true });
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("dblclick", dbl);
  window.addEventListener("keydown", key);
  return () => {
    el.removeEventListener("pointerdown", down, { capture: true });
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    el.removeEventListener("dblclick", dbl);
    window.removeEventListener("keydown", key);
    box.remove();
  };
}

/** Where on the table a point on the screen lands (board space), for dropping a component there. */
export function dropPoint(scene: BoardScene, clientX: number, clientY: number): Vec3 {
  const el = scene.renderer.domElement;
  const r = el.getBoundingClientRect();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), scene.camera);
  const p = scene.tablePoint(rc.ray.origin, rc.ray.direction, 0);
  return p ? [round(p.x), 0, round(p.z)] : scene.focusPoint();
}

const round = (n: number) => Math.round(n * 1000) / 1000;
