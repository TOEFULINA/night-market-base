// ---------------------------------------------------------------------------
// Shading helper for the street/market - everything else that used to live
// here (toon/cel-shading, non-PBR lambert pass, the outline-mesh trick) was
// only ever used by companion.js/npc.js/post.js, which are gone now (see
// their removal note in world.js/main.js history) - trimmed this file down
// to just what's actually still wired in: toUnlitFlat, used by every baked
// street material, and flickerUniforms, the shared clock its emissive
// flicker reads from.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Some exported files have their real per-material textures wired to the
// material's emissive slot instead of base color - the texture is genuinely
// there, just filed under the wrong name by the time GLTFLoader hands it to
// us (material.emissiveMap instead of material.map). Falls back to that
// instead of rendering flat white.
function resolveMapAndColor(material) {
  if (material.map) return { map: material.map, color: material.color ? material.color.clone() : new THREE.Color(0xffffff) };
  if (material.emissiveMap) return { map: material.emissiveMap, color: new THREE.Color(0xffffff) };
  return { map: null, color: material.color ? material.color.clone() : new THREE.Color(0xffffff) };
}

// A handful of materials (matched by name, checked directly via the actual
// pixel alpha data - not a guess) are small opaque shapes painted on a
// mostly-transparent texture, but never got alphaMode set on export, so
// GLTFLoader treats them as fully OPAQUE per the glTF spec default. Forcing
// alphaTest here cuts out the transparent part regardless of what the
// export got wrong.
const ALPHA_CUTOUT_NAME_HINTS = ['Eyelash', 'Eyeline', 'Brow', 'EyeIris', 'EyeHighlight'];
function needsForcedAlphaCutout(material) {
  return !!material.name && ALPHA_CUTOUT_NAME_HINTS.some((hint) => material.name.includes(hint));
}

// Unlit/flat - routes the base color texture straight through as-is,
// completely ignoring scene lights: what's painted in the texture IS what
// you see, regardless of time of day or which way a surface faces the sun.
// Cheaper than any lit option too, since there's no lighting math at all.
// This is what every baked street/market material goes through by default
// (see world.js's LIT_EXCEPTION_MATERIAL_NAMES for the short list that
// doesn't).
//
// Shared time uniform for the flicker below - ONE object, reused across
// EVERY flickering material's compiled shader (not a fresh {value:0} per
// material). Three.js reads a uniform's .value at render time from
// whatever object the shader references, so updating flickerUniforms.uTime
// once per frame (see main.js's tick loop) updates every flickering sign at
// once - no need to track/loop over every individual material instance.
export const flickerUniforms = { uTime: { value: 0 } };

export function toUnlitFlat(material) {
  const { map, color } = resolveMapAndColor(material);
  const forceCutout = needsForcedAlphaCutout(material);

  // Used ONLY to decide which materials flicker (signs/lit panels the
  // artist actually marked as emissive in Blender), NOT to add brightness
  // on top of the base color anymore - see the flicker block below for why.
  const hasEmissive =
    !!material.emissiveMap || (material.emissive && (material.emissive.r > 0 || material.emissive.g > 0 || material.emissive.b > 0));

  const basic = new THREE.MeshBasicMaterial({
    color,
    map,
    transparent: forceCutout ? false : material.transparent,
    opacity: material.opacity,
    alphaTest: forceCutout ? 0.5 : material.alphaTest,
    side: forceCutout ? THREE.DoubleSide : material.side,
  });

  // Flicker, "like flickering LED signs" - MULTIPLIES the existing output
  // color instead of adding a separate emissive glow on top of it (used to
  // sample material.emissiveMap/emissiveColor/emissiveIntensity and ADD
  // that in - removed per your call that the signs were reading too bright
  // because of this double-up: base color texture is already the baked
  // "lit" look the artist painted, so stacking a second emissive layer on
  // top of it was pushing brightness past what was intended). Bloom is
  // untouched by this change - UnrealBloomPass thresholds on the final
  // rendered frame, not on emissive data, so it still blooms whatever's
  // bright in the base color/flicker output. It'll just have LESS to grab
  // now that nothing's artificially boosted above the base texture's own
  // brightness - if specific signs need to read brighter/glowier than
  // their baked texture, that's a texture change (or a per-material
  // brightness multiplier), not something to fix by re-adding emissive.
  //
  // uTime is the shared clock (flickerUniforms above), uFlickerSeed is
  // unique per material instance so every sign flickers on its own pattern
  // instead of all pulsing in lockstep. Two layered effects: a fast
  // shimmer (a real LED's PWM dimming reads as a flicker even when
  // "steady"), plus a brief brightness dip every second or so (the "bad
  // connection" stutter). Injected before #include <opaque_fragment> so
  // tonemapping/fog still apply on top, same as before.
  if (hasEmissive) {
    basic.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = flickerUniforms.uTime;
      shader.uniforms.uFlickerSeed = { value: Math.random() * 1000 };

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nuniform float uFlickerSeed;'
        )
        .replace(
          '#include <opaque_fragment>',
          'float flickerT = uTime + uFlickerSeed;\n' +
          'float flickerShimmer = 0.90 + 0.10 * sin(flickerT * 26.0);\n' +
          'float flickerStep = fract(sin(floor(flickerT * 5.0) * 43758.5453 + uFlickerSeed) * 12345.678);\n' +
          'float flickerDip = flickerStep < 0.09 ? 0.55 : 1.0;\n' +
          'outgoingLight *= flickerShimmer * flickerDip;\n' +
          '#include <opaque_fragment>'
        );
    };
  }

  return basic;
}
