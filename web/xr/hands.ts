import * as THREE from "three";

/**
 * Reading a tracked hand. WebXR recognises one gesture, the pinch (it is the
 * hand's "select", and the engine takes it as the trigger); everything else
 * here is read from the 25 joints three.js keeps on the hand, every frame.
 * Each gesture switches on past one threshold and off past a looser one, so
 * it doesn't flicker at its edge, and the ones that open something must be
 * held a moment first.
 */

type Side = "left" | "right" | "none";

/** The joints the gestures look at, in the room's space (metres). */
export type HandPose = {
  wrist: THREE.Vector3;
  thumbBase: THREE.Vector3;
  thumbKnuckle: THREE.Vector3;
  thumbTip: THREE.Vector3;
  indexBase: THREE.Vector3;
  indexKnuckle: THREE.Vector3;
  indexTip: THREE.Vector3;
  middleBase: THREE.Vector3;
  middleTip: THREE.Vector3;
  ringTip: THREE.Vector3;
  pinkyBase: THREE.Vector3;
  /** Out of the palm, unit length. */
  palmNormal: THREE.Vector3;
  palmCenter: THREE.Vector3;
};

const JOINTS = {
  wrist: "wrist",
  thumbBase: "thumb-metacarpal",
  thumbKnuckle: "thumb-phalanx-proximal",
  thumbTip: "thumb-tip",
  indexBase: "index-finger-metacarpal",
  indexKnuckle: "index-finger-phalanx-proximal",
  indexTip: "index-finger-tip",
  middleBase: "middle-finger-metacarpal",
  middleTip: "middle-finger-tip",
  ringTip: "ring-finger-tip",
  pinkyBase: "pinky-finger-metacarpal",
} as const satisfies Record<string, XRHandJoint>;

/** The hand's joints this frame, or null while it isn't tracked. */
export function readHand(hand: THREE.XRHandSpace, side: Side): HandPose | null {
  const out: Partial<HandPose> = {};
  for (const [k, name] of Object.entries(JOINTS)) {
    const j = hand.joints[name];
    if (!j?.visible) return null;
    out[k as keyof typeof JOINTS] = j.getWorldPosition(new THREE.Vector3());
  }
  const p = out as HandPose;
  // The index and little-finger knuckles, seen from the wrist, crossed: out of
  // the palm. A left hand is a mirror, so the order swaps.
  const a = p.indexBase.clone().sub(p.wrist);
  const b = p.pinkyBase.clone().sub(p.wrist);
  p.palmNormal = (side === "left" ? b.cross(a) : a.cross(b)).normalize();
  p.palmCenter = p.wrist.clone().add(p.middleBase).multiplyScalar(0.5);
  return p;
}

/** A finger reaching away from the wrist (straight), or folded back towards it. */
const reach = (p: HandPose, tip: THREE.Vector3) => tip.distanceTo(p.wrist);

/** What a hand is doing, kept from frame to frame. */
export class HandGestures {
  pose: HandPose | null = null;
  /** Thumb on the middle finger (not the index): back on the left hand, forward on the right. */
  middlePinch = false;
  /** Palm up, fingers open, held a moment: the wrist menu shows. */
  palmUp = false;
  /** Index and thumb out in an L, the other fingers folded: one half of a frame. */
  ell = false;
  private upSince = 0;
  private downSince = 0;

  constructor(readonly side: Side) {}

  /** Read this frame. Returns true on the frame the middle pinch closes. */
  update(hand: THREE.XRHandSpace, now: number): { middlePinch: boolean } {
    const p = readHand(hand, this.side);
    this.pose = p;
    if (!p) {
      this.middlePinch = false;
      this.ell = false;
      this.palmUp = false;
      this.upSince = this.downSince = 0;
      return { middlePinch: false };
    }
    const pinch = p.thumbTip.distanceTo(p.indexTip);
    const mid = p.thumbTip.distanceTo(p.middleTip);
    const was = this.middlePinch;
    // The index stays clear, so a normal pinch never reads as this one.
    if (!was && mid < 0.018 && pinch > 0.035) this.middlePinch = true;
    else if (was && mid > 0.035) this.middlePinch = false;

    // Open hand, palm to the ceiling. Held for a moment to come up, and a little longer to go.
    const open = reach(p, p.indexTip) > 0.13 && reach(p, p.middleTip) > 0.13;
    const up = open && p.palmNormal.y > (this.palmUp ? 0.5 : 0.7);
    if (up) {
      this.downSince = 0;
      this.upSince ||= now;
      if (now - this.upSince > 220) this.palmUp = true;
    } else {
      this.upSince = 0;
      this.downSince ||= now;
      if (now - this.downSince > 450) this.palmUp = false;
    }

    // An L: index out, thumb out to the side, middle and ring folded.
    const index = p.indexTip.clone().sub(p.indexKnuckle).normalize();
    const thumb = p.thumbTip.clone().sub(p.thumbBase).normalize();
    const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(index.dot(thumb), -1, 1)));
    const slack = this.ell ? 10 : 0;
    this.ell =
      reach(p, p.indexTip) > 0.13 - slack / 1000 &&
      reach(p, p.middleTip) < 0.11 + slack / 1000 &&
      reach(p, p.ringTip) < 0.11 + slack / 1000 &&
      p.thumbTip.distanceTo(p.indexKnuckle) > 0.06 &&
      angle > 50 - slack &&
      angle < 130 + slack;

    return { middlePinch: !was && this.middlePinch };
  }

  /** The point between the thumb and index tips: where a pinch is. */
  pinchPoint() {
    const p = this.pose;
    return p ? p.thumbTip.clone().add(p.indexTip).multiplyScalar(0.5) : null;
  }

  /** The L: its inside corner, where the thumb meets the index, and the two fingertips. */
  ellPoints(): Ell | null {
    const p = this.pose;
    if (!p) return null;
    const corner = p.thumbKnuckle.clone().add(p.indexKnuckle).multiplyScalar(0.5);
    return { corner, index: p.indexTip.clone(), thumb: p.thumbTip.clone() };
  }
}

/** One half of a frame, in the room's space. */
export type Ell = { corner: THREE.Vector3; index: THREE.Vector3; thumb: THREE.Vector3 };

/** Whether a 2D point is inside a polygon (even-odd). */
export function inside(x: number, y: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
