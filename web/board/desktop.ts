import * as THREE from "three";
import { newId, type Vec3 } from "../../shared/board";
import type { Ctl } from "./ctl";
import type { BoardScene } from "./scene";

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
    | { kind: "orbit"; x0: number; y0: number; moved: boolean };
  let drag: Drag | null = null;

  const down = (e: PointerEvent) => {
    if (scene.mode !== "flat" || e.button !== 0) return;
    const { origin, dir } = ray(e);
    const hit = scene.pick(origin, dir);
    const tool = ctl.tool();

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
      // Moving one of the selection moves all of it.
      const sel = ctl.selected().includes(hit.id) ? ctl.selected().filter((id) => id !== hit.id) : [];
      const others = sel
        .map((id) => scene.views.get(id))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .map((o) => ({ id: o.id, offset: new THREE.Vector3(...o.item.pos).sub(new THREE.Vector3(...v.item.pos)) }));
      drag = { kind: "item", id: hit.id, y, grabOffset: new THREE.Vector3(...v.item.pos).sub(at), vertical: e.shiftKey && e.altKey, startY: y, startClientY: e.clientY, moved: false, x0: e.clientX, y0: e.clientY, others };
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
      pos = [round(at.x), round(drag.y), round(at.z)];
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
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const { origin, dir } = ray(e);
    if (d.kind === "orbit") {
      if (!d.moved) ctl.select([]);
      return;
    }
    if (d.kind === "ink") {
      scene.showInk(null);
      if (d.pts.length < 2) return;
      const base = d.pts[0].clone();
      ctl.add("ink", [round(base.x), round(base.y), round(base.z)], {
        points: d.pts.map((p) => [round(p.x - base.x), round(p.y - base.y), round(p.z - base.z)] as Vec3),
        color: ctl.inkColor(),
        width: 0.005,
      });
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
    if (scene.mode !== "flat") return;
    const { origin, dir } = ray(e);
    const hit = scene.pick(origin, dir);
    if (hit?.kind === "item") ctl.edit(hit.id);
  };

  const key = (e: KeyboardEvent) => {
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
