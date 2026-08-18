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

export function createPostProcessing(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

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
  composer.addPass(bloomPass);

  // Title-screen-only radial defocus, see TILT_SHIFT_SHADER above. Toggle
  // .enabled from main.js based on mode - disabled (default) means
  // ShaderPass just passes the image through untouched, effectively free,
  // so walk mode stays completely unaffected.
  const tiltShiftPass = new ShaderPass(TILT_SHIFT_SHADER);
  tiltShiftPass.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  tiltShiftPass.enabled = false;
  composer.addPass(tiltShiftPass);

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

  return {
    composer,
    renderPass,
    bloomPass,
    tiltShiftPass,
    shadowLiftPass,
    setSize(width, height) {
      composer.setSize(width, height);
      tiltShiftPass.uniforms.uResolution.value.set(width, height);
    },
  };
}
