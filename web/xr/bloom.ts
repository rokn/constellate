import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * The desktop's bloom, in the headset. three's EffectComposer can't run
 * inside a WebXR session (it would draw each full-screen pass once per eye),
 * so this does it by hand:
 *
 *  1. the map is drawn, in stereo, into an offscreen target the size of the
 *     headset's framebuffer (both eyes side by side);
 *  2. with XR switched off for a moment, what's brighter than the threshold
 *     is blurred down a chain of half-size targets and back up (a dual
 *     filter: cheap enough for a Quest's GPU), each eye's half kept apart so
 *     one eye's glow never bleeds into the other's;
 *  3. what goes behind the map (the room, and the panels the map is in
 *     front of) is drawn into the headset's framebuffer, unbloomed;
 *  4. map and glow are laid over it, keeping alpha so the glow lights the
 *     room in passthrough.
 *
 * The engine then draws the overlay (the other panels, hands, rays, tags)
 * over everything, unbloomed, so text stays crisp.
 *
 * The knobs are the desktop's: strength, spread (radius) and threshold.
 */

export type BloomParams = { strength: number; radius: number; threshold: number };

const LEVELS = 5;

const VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Keep a sample inside the eye its fragment belongs to. */
const EYE = /* glsl */ `
  uniform float uStereo;
  vec2 eye(vec2 uv, vec2 texel) {
    if (uStereo < 0.5) return uv;
    float e = step(0.5, vUv.x) * 0.5;
    return vec2(clamp(uv.x, e + texel.x, e + 0.5 - texel.x), clamp(uv.y, texel.y, 1.0 - texel.y));
  }
`;

const PREFILTER = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  ${EYE}
  void main() {
    vec2 o = uTexel;
    vec3 c = texture2D(tMap, eye(vUv + vec2(-o.x, -o.y), o)).rgb;
    c += texture2D(tMap, eye(vUv + vec2(o.x, -o.y), o)).rgb;
    c += texture2D(tMap, eye(vUv + vec2(-o.x, o.y), o)).rgb;
    c += texture2D(tMap, eye(vUv + vec2(o.x, o.y), o)).rgb;
    c *= 0.25;
    // The same high pass as the desktop's UnrealBloomPass.
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.01, lum), 1.0);
  }
`;

const DOWN = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uTexel;
  varying vec2 vUv;
  ${EYE}
  void main() {
    vec2 o = uTexel;
    vec3 s = texture2D(tMap, eye(vUv, o)).rgb * 4.0;
    s += texture2D(tMap, eye(vUv + vec2(-o.x, -o.y), o)).rgb;
    s += texture2D(tMap, eye(vUv + vec2(o.x, -o.y), o)).rgb;
    s += texture2D(tMap, eye(vUv + vec2(-o.x, o.y), o)).rgb;
    s += texture2D(tMap, eye(vUv + vec2(o.x, o.y), o)).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
  }
`;

const UP = /* glsl */ `
  uniform sampler2D tMap;
  uniform sampler2D tLow;
  uniform vec2 uTexel;
  uniform vec2 uLowTexel;
  uniform float uK;
  varying vec2 vUv;
  ${EYE}
  void main() {
    vec2 o = uLowTexel;
    vec3 s = texture2D(tLow, eye(vUv + vec2(-2.0 * o.x, 0.0), o)).rgb;
    s += texture2D(tLow, eye(vUv + vec2(2.0 * o.x, 0.0), o)).rgb;
    s += texture2D(tLow, eye(vUv + vec2(0.0, -2.0 * o.y), o)).rgb;
    s += texture2D(tLow, eye(vUv + vec2(0.0, 2.0 * o.y), o)).rgb;
    s += texture2D(tLow, eye(vUv + vec2(-o.x, -o.y), o)).rgb * 2.0;
    s += texture2D(tLow, eye(vUv + vec2(o.x, -o.y), o)).rgb * 2.0;
    s += texture2D(tLow, eye(vUv + vec2(-o.x, o.y), o)).rgb * 2.0;
    s += texture2D(tLow, eye(vUv + vec2(o.x, o.y), o)).rgb * 2.0;
    gl_FragColor = vec4(texture2D(tMap, eye(vUv, uTexel)).rgb + (s / 12.0) * uK, 1.0);
  }
`;

const COMPOSITE = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(tScene, vUv);
    vec3 b = texture2D(tBloom, vUv).rgb * uStrength;
    // The scene is premultiplied (it was blended onto a clear, transparent
    // target); the glow adds light, and in passthrough its own coverage.
    gl_FragColor = vec4(s.rgb + b, clamp(s.a + max(b.r, max(b.g, b.b)), 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

const shader = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending });

export class Bloom {
  private scene: THREE.WebGLRenderTarget;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private prefilter = shader(PREFILTER, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.2 }, uStereo: { value: 0 } });
  private downM = shader(DOWN, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uStereo: { value: 0 } });
  private upM = shader(UP, {
    tMap: { value: null },
    tLow: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uLowTexel: { value: new THREE.Vector2() },
    uK: { value: 1 },
    uStereo: { value: 0 },
  });
  // Laid over what's behind the map: premultiplied "over".
  private composite = new THREE.ShaderMaterial({
    vertexShader: VS,
    fragmentShader: COMPOSITE,
    uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  private clear = new THREE.Color();
  private size = new THREE.Vector2();

  constructor(renderer: THREE.WebGLRenderer) {
    // Half floats keep the dark end of the glow from banding; not every GPU can render to them.
    const ext = renderer.extensions;
    const type = ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type, samples: 4, depthBuffer: true });
    for (let i = 0; i < LEVELS; i++) {
      const o = { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.down.push(new THREE.WebGLRenderTarget(1, 1, o));
      this.up.push(new THREE.WebGLRenderTarget(1, 1, o));
    }
  }

  dispose() {
    this.scene.dispose();
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.prefilter, this.downM, this.upM, this.composite]) m.dispose();
    this.quad.dispose();
  }

  private resize(w: number, h: number) {
    if (this.size.x === w && this.size.y === h) return;
    this.size.set(w, h);
    this.scene.setSize(w, h);
    let lw = w;
    let lh = h;
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(2, Math.ceil(lw / 2));
      lh = Math.max(2, Math.ceil(lh / 2));
      this.down[i].setSize(lw, lh);
      this.up[i].setSize(lw, lh);
    }
  }

  private pass(renderer: THREE.WebGLRenderer, m: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null) {
    this.quad.material = m;
    renderer.setRenderTarget(to);
    this.quad.render(renderer);
  }

  /**
   * Draw `scene` with bloom into `target`, over what `under` draws there:
   * the headset's framebuffer while presenting (what the renderer has bound
   * at the start of an XR frame), or null for the canvas.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget | null, p: BloomParams, under: () => void) {
    const stereo = renderer.xr.isPresenting;
    if (target) this.resize(target.width, target.height);
    else {
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.resize(s.x, s.y);
    }

    // 1. The map, in stereo, offscreen, on nothing: it's laid over the room later.
    renderer.getClearColor(this.clear);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.scene);
    renderer.render(scene, camera);
    renderer.setClearColor(this.clear, clearAlpha);

    // 2. The glow, flat: each full-screen pass drawn once over both eyes.
    const xrOn = renderer.xr.enabled;
    const autoClear = renderer.autoClear;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    const st = stereo ? 1 : 0;
    const texel = (t: THREE.WebGLRenderTarget) => new THREE.Vector2(1 / t.width, 1 / t.height);

    this.prefilter.uniforms.tMap.value = this.scene.texture;
    this.prefilter.uniforms.uTexel.value = texel(this.scene);
    this.prefilter.uniforms.uThreshold.value = p.threshold;
    this.prefilter.uniforms.uStereo.value = st;
    this.pass(renderer, this.prefilter, this.down[0]);
    this.downM.uniforms.uStereo.value = st;
    for (let i = 1; i < LEVELS; i++) {
      this.downM.uniforms.tMap.value = this.down[i - 1].texture;
      this.downM.uniforms.uTexel.value = texel(this.down[i - 1]);
      this.pass(renderer, this.downM, this.down[i]);
    }
    // Back up: each level adds the blurred one below it. Spread weighs the wide levels up.
    this.upM.uniforms.uK.value = THREE.MathUtils.lerp(0.75, 1.3, p.radius);
    this.upM.uniforms.uStereo.value = st;
    let low = this.down[LEVELS - 1];
    for (let i = LEVELS - 2; i >= 0; i--) {
      this.upM.uniforms.tMap.value = this.down[i].texture;
      this.upM.uniforms.tLow.value = low.texture;
      this.upM.uniforms.uTexel.value = texel(this.down[i]);
      this.upM.uniforms.uLowTexel.value = texel(low);
      this.pass(renderer, this.upM, this.up[i]);
      low = this.up[i];
    }

    // 3. What's behind the map, in stereo again.
    renderer.xr.enabled = xrOn;
    renderer.autoClear = autoClear;
    under();

    // 4. Map and glow over it.
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    this.composite.uniforms.tScene.value = this.scene.texture;
    this.composite.uniforms.tBloom.value = low.texture;
    // Matched by eye to the desktop pass at its default knobs.
    this.composite.uniforms.uStrength.value = p.strength * 2;
    this.pass(renderer, this.composite, target);
    renderer.xr.enabled = xrOn;
    renderer.autoClear = autoClear;
  }
}
