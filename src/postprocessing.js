// ---------------------------------------------------------------------------
// Post-processing, aimed at closing some of the "real-time rasterizer" vs.
// "Blender Cycles" gap. Cycles is path-traced - bright/emissive surfaces
// naturally bloom from real light scatter in the render. Three.js's
// rasterizer doesn't do that at all unless it's added as an explicit
// post-process step, which is what this file is.
//
// Kept to just bloom for now, not a full AO/depth-of-field/color-grade
// stack. Reasoning: this project's whole lighting strategy already leans on
// baked textures to do the GI/shadow-detail heavy lifting (see world.js's
// bake-by-default setup) - the remaining gap between this and a Cycles
// render is mostly "does bright stuff actually glow," and bloom is the
// highest-impact fix for that at the lowest GPU cost (one extra blur pass).
// SSAO/DOF are real next steps if you want to push further, just heavier to
// add and tune - flagging rather than bundling in blind.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

// Same touch-device check the rest of the project uses (declared per-file by
// convention here rather than shared/imported - see world.js/main.js). Used
// below to trim the two heaviest passes on mobile: bloom, and the DOF
// depth pre-pass (which costs a whole second scene render per frame).
const IS_MOBILE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// Title-screen-only radial defocus ("blur around the edges and farthest
// parts, lines are too hard"). Not real depth-of-field (that needs a depth
// texture + a focus distance tuned to actual scene geometry, more setup
// than this needs) - instead a circular multi-tap blur whose radius scales
// with distance from screen center, cheap and framing-agnostic. Reads as
// "sharp in the middle, soft toward the edges/corners" which is what was
// asked for, and happens to line up with "farthest parts" too since the
// title camera's diagonal angle puts the building's receding far corner
// out toward the frame edges, not the center.
const TILT_SHIFT_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // Pulled back per your "a bit less intense" - strength 6.0 -> 3.5 (softer
    // max blur) and the sharp center zone widened 0.35 -> 0.48 (more of the
    // frame stays crisp before the falloff even starts).
    uStrength: { value: 3.5 }, // max blur radius in pixels, right at the frame corners
    uCenterRadius: { value: 0.48 }, // 0-1 fraction of the (aspect-corrected) screen radius that stays fully sharp before blur ramps in
    // Per your "soften all the edges, the windows' hard borders look
    // uncanny next to the blurred sign" - the center zone used to stay
    // completely untouched (blurAmount clamped to 0), which is exactly what
    // made the flat vector-hard window frames look so jarring against the
    // photo-blurred sign right next to them. This is a floor UNDER
    // blurAmount so even the "sharp" center gets a small constant soften
    // (roughly uBaseBlur * uStrength px) instead of zero - takes the edge
    // off hard baked-texture borders everywhere, while the radial falloff
    // above still ramps up further toward the frame edges on top of it.
    uBaseBlur: { value: 0.22 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uStrength;
    uniform float uCenterRadius;
    uniform float uBaseBlur;
    varying vec2 vUv;

    void main() {
      vec2 aspectCorrected = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      float dist = length(aspectCorrected);
      float blurAmount = mix(uBaseBlur, 1.0, smoothstep(uCenterRadius, 1.0, dist));

      vec2 texel = 1.0 / uResolution;
      float radius = blurAmount * uStrength;
      const int SAMPLES = 12;
      vec4 sum = texture2D(tDiffuse, vUv) * 2.0;
      float total = 2.0;
      for (int i = 0; i < SAMPLES; i++) {
        float angle = (float(i) / float(SAMPLES)) * 6.28318;
        vec2 offset = vec2(cos(angle), sin(angle)) * radius * texel;
        sum += texture2D(tDiffuse, vUv + offset);
        total += 1.0;
      }
      gl_FragColor = sum / total;
    }
  `,
};

// Distance blur ("add a blur to far away items") - real depth-of-field
// this time, not the title screen's screen-position-based tilt-shift
// above (that one has no idea what's actually far away in the scene, just
// what's near the frame edges - fine for the title's fixed diagonal
// framing, wrong for walk mode where "far" needs to mean actual distance
// from the camera). Needs a depth texture to know that - wired up in
// createPostProcessing below via a WebGLRenderTarget with depthTexture
// set, which three.js populates automatically during the normal color
// render pass (RenderPass), no separate depth pre-pass needed.
// Same 12-tap circular blur technique as TILT_SHIFT_SHADER above, just
// driven by linearized scene depth instead of screen-space distance from
// center. uFocusNear/uFocusFar are in the same world units as everything
// else in this file (meters-ish) - sharp out to uFocusNear, blur ramps in
// smoothly and maxes out at uFocusFar. Walk-mode-only (see main.js's
// tick() - toggled opposite of tiltShiftPass, off during the title
// screen's orthographic view where "depth" doesn't mean the same thing).
const DOF_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 2500 },
    uFocusNear: { value: 16 }, // sharp out to this distance
    uFocusFar: { value: 40 }, // fully blurred by this distance - lines up with the fog's new near/far=7/32 (world.js) so distant geometry fades AND softens together
    uStrength: { value: 2.5 }, // max blur radius in pixels
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uFocusNear;
    uniform float uFocusFar;
    uniform float uStrength;
    varying vec2 vUv;

    float viewDistance(float depth) {
      // Standard perspective depth -> linear view-space Z (three.js's own
      // perspectiveDepthToViewZ formula), then flipped positive - camera
      // looks down -Z, so viewZ comes out negative.
      float viewZ = (uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * depth - uCameraFar);
      return -viewZ;
    }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      float dist = viewDistance(depth);
      float blurAmount = smoothstep(uFocusNear, uFocusFar, dist);

      if (blurAmount <= 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 texel = 1.0 / uResolution;
      float radius = blurAmount * uStrength;
      const int SAMPLES = 12;
      vec4 sum = texture2D(tDiffuse, vUv) * 2.0;
      float total = 2.0;
      for (int i = 0; i < SAMPLES; i++) {
        float angle = (float(i) / float(SAMPLES)) * 6.28318;
        vec2 offset = vec2(cos(angle), sin(angle)) * radius * texel;
        sum += texture2D(tDiffuse, vUv + offset);
        total += 1.0;
      }
      gl_FragColor = sum / total;
    }
  `,
};

// Shadow lift - "keep the same overall brightness but decrease the
// intensity of the darks, it's all too dark where it's dark." A straight
// exposure bump would brighten everything including the parts that are
// already reading fine (the neon signs, highlights), which isn't what was
// asked. This is a gamma-style lift instead: pow(color, uGamma) with
// uGamma < 1 leaves pure black (0) and pure white (1) exactly where they
// are, but disproportionately brightens everything in between - a shadow
// at 0.1 lifts to roughly 0.18 (nearly double), while something already at
// 0.9 barely moves (~0.93). That's "same overall brightness, less crushed
// shadow detail." Runs on both modes, after OutputPass since this is meant
// to grade the final display-ready image the way a lift slider would in
// Photoshop/Lightroom, not the linear scene-referred values before tone
// mapping.
const SHADOW_LIFT_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uGamma: { value: 0.8 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uGamma;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(pow(color.rgb, vec3(uGamma)), color.a);
    }
  `,
};

// Grain + contrast, both always-on/both-modes like the shadow lift above,
// and combined into one pass rather than two separate ShaderPasses - one
// less full-screen texture read/write per frame for two effects that are
// both simple per-pixel math anyway, no reason to pay for a second pass.
// Runs LAST (after OutputPass/shadowLiftPass), same reasoning as the
// shadow lift: grades the final display-ready image, not the linear
// scene-referred values.
//
// Contrast: "slight reduction of contrast" - classic pivot-around-0.5
// contrast formula with uContrast slightly under 1 (0.92) pulls both ends
// of the range in toward mid-grey a little, without touching overall
// brightness (0.5 stays 0.5).
//
// Grain: "a slight grain to the entire scene" - per-pixel pseudo-random
// noise (a cheap hash of screen position, no texture lookup needed),
// re-rolled every frame via uTime so it reads as film grain/sensor noise
// rather than a static dither pattern burned into the image. uTime comes
// from the shared grainUniforms object below, same pattern as
// shading.js's flickerUniforms - ONE uniform object, updated once per
// frame in main.js's tick(), rather than each pass tracking its own
// clock. Amount kept low (0.035) - visible as texture/grit up close,
// not full VHS noise.
export const grainUniforms = { uTime: { value: 0 } };

const GRAIN_CONTRAST_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: grainUniforms.uTime,
    uContrast: { value: 0.92 },
    uGrainAmount: { value: 0.035 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uContrast;
    uniform float uGrainAmount;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      color.rgb = (color.rgb - 0.5) * uContrast + 0.5;

      float grain = hash(vUv * vec2(1000.0, 1000.0) + uTime) - 0.5;
      color.rgb += grain * uGrainAmount;

      gl_FragColor = color;
    }
  `,
};

// Dedicated depth pre-pass for DOF_SHADER - deliberately NOT done by
// handing EffectComposer a custom renderTarget with a depthTexture
// attached (the "usual" three.js trick). That relies on RenderPass always
// landing on the SAME physical render target every frame, but this
// composer's tiltShiftPass/dofPass toggle on/off by mode (see main.js's
// tick()), and EffectComposer skips both the render AND the buffer-swap
// entirely for a disabled pass - so which of its two ping-pong buffers is
// "current" at frame start drifts depending on how many passes were
// enabled the frame before. A depth texture attached to one fixed buffer
// would end up stale/wrong on some frames as that drift happens - a subtle
// bug that'd show up as the blur boundary lagging a frame behind, not an
// outright crash. Simplest correct fix: render depth into its own
// completely separate, fixed target every frame, outside the composer's
// ping-pong entirely. needsSwap = false, so this never touches the main
// color chain - it's a pure side effect (populate the depth texture) that
// the DOF pass right after it reads from.
class DepthPrepassPass extends Pass {
  constructor(scene, camera, depthTarget) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.depthTarget = depthTarget;
    this.needsSwap = false;
  }
  render(renderer) {
    if (!this.depthTarget) return; // mobile - target never allocated, pass never enabled
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.depthTarget);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
  }
}

export function createPostProcessing(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

  // DOF_SHADER's depth source - see DepthPrepassPass above for why this is
  // a separate target rather than the composer's own. Walk mode's
  // perspective camera only (DOF is walk-only, see main.js's tick() -
  // title mode never enables depthPrepassPass/dofPass, so this target
  // just sits unused/free at zero extra cost while on the title screen).
  // Mobile never enables depthPrepassPass/dofPass (see main.js's tick), so
  // this full-screen render target + depth texture would just sit allocated
  // and never be written or read - skip creating it there at all. The passes
  // below are still constructed either way so the returned shape stays
  // identical and main.js needs no null-checks; they're simply never enabled.
  const depthTexture = IS_MOBILE ? null : new THREE.DepthTexture();
  if (depthTexture) depthTexture.type = THREE.UnsignedIntType;
  const depthTarget = IS_MOBILE
    ? null
    : new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
        depthTexture,
        depthBuffer: true,
      });

  // camera is reassigned per-frame in main.js (title screen's orthographic
  // camera vs. the walk mode perspective camera share this one composer/
  // bloom pipeline) - RenderPass.camera is a plain public property, safe to
  // swap each frame, not something that needs rebuilding the pass.
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // strength/radius/threshold are the three knobs. threshold matters most -
  // it's the brightness cutoff (post-tonemap, 0-1 range) below which
  // nothing blooms, so it's what keeps this from turning the whole image
  // hazy. Should catch neon signage/emissive maps/the atmosphere light
  // orbs (all genuinely bright) without blooming ordinary lit surfaces.
  //
  // First pass (0.7/0.4/0.8) bloomed way too much of the scene - basically
  // every sign washed out to a white halo, not just the actual neon. Second
  // pass (0.3/0.25/0.92) was readable but still "needs less." Pulled
  // strength down further and threshold up again - should now read as a
  // faint glow on the brightest panels only, not a haze over everything.
  // Still a guess since I can't preview this - keep pushing the same
  // direction (strength down, threshold up) if it's still too much.
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.15, // strength
    0.2, // radius
    0.95 // threshold
  );
  // Off on mobile. UnrealBloomPass is by far the most expensive pass in this
  // chain - it allocates 5 mip-level render targets and does a separate
  // downsample + upsample blur draw at each one, so it's ~10 extra
  // fullscreen passes plus their buffers, every frame. At strength 0.15 /
  // threshold 0.95 it's already a very faint glow on the brightest sign
  // panels only, so this is close to the best cost/visual-loss ratio
  // available here. Desktop keeps it exactly as tuned.
  bloomPass.enabled = !IS_MOBILE;
  composer.addPass(bloomPass);

  // Title-screen-only radial defocus, see TILT_SHIFT_SHADER above. Toggle
  // .enabled from main.js based on mode - disabled (default) means
  // ShaderPass just passes the image through untouched, effectively free,
  // so walk mode stays completely unaffected.
  const tiltShiftPass = new ShaderPass(TILT_SHIFT_SHADER);
  tiltShiftPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  tiltShiftPass.enabled = false;
  composer.addPass(tiltShiftPass);

  // Walk-mode-only distance blur, see DOF_SHADER/DepthPrepassPass above.
  // depthPrepassPass MUST run immediately before dofPass (it just fills in
  // the texture dofPass reads that same frame) - both start disabled and
  // get toggled together, opposite of tiltShiftPass, in main.js's tick().
  const depthPrepassPass = new DepthPrepassPass(scene, camera, depthTarget);
  depthPrepassPass.enabled = false;
  composer.addPass(depthPrepassPass);

  const dofPass = new ShaderPass(DOF_SHADER);
  dofPass.uniforms.tDepth.value = depthTexture;
  dofPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  dofPass.uniforms.uCameraNear.value = camera.near;
  dofPass.uniforms.uCameraFar.value = camera.far;
  dofPass.enabled = false;
  composer.addPass(dofPass);

  // Required as the last pass whenever EffectComposer is in the picture at
  // all - applies the renderer's actual tone mapping (ACES, see main.js)
  // and output color space to the final composited image. Without this,
  // the composited result comes out flat/washed since the passes above
  // work in linear space, not display-ready color.
  composer.addPass(new OutputPass());

  // Shadow lift, see SHADOW_LIFT_SHADER above - always on, both modes, no
  // per-frame toggle needed like the tilt-shift pass.
  const shadowLiftPass = new ShaderPass(SHADOW_LIFT_SHADER);
  composer.addPass(shadowLiftPass);

  // Grain + contrast, see GRAIN_CONTRAST_SHADER above - always on, both
  // modes, runs last of all so it grades the fully composited image.
  const grainContrastPass = new ShaderPass(GRAIN_CONTRAST_SHADER);
  composer.addPass(grainContrastPass);

  return {
    composer,
    renderPass,
    bloomPass,
    tiltShiftPass,
    depthPrepassPass,
    dofPass,
    shadowLiftPass,
    grainContrastPass,
    setSize(width, height) {
      composer.setSize(width, height);
      tiltShiftPass.uniforms.uResolution.value.set(width, height);
      dofPass.uniforms.uResolution.value.set(width, height);
      depthTarget?.setSize(width, height); // null on mobile - never allocated
    },
  };
}
