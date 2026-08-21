// ---------------------------------------------------------------------------
// The street environment - public/models/TRY4_SCENE.glb (latest round of
// your own baking/cleanup pass, replacing TRY2_SCENE.glb - merged by
// material, unreachable buildings past the corner removed). Baked/unlit by
// default (matches your call that pretty much everything is baked); a short
// list of reused generic props and materials you want dynamic response on
// stays lit PBR - see LIT_EXCEPTION_MATERIAL_NAMES below.
// Paired with a proper environment map below so metal/glass/wet-looking
// surfaces actually have something to reflect instead of rendering flat and
// plasticky - PBR materials genuinely need that, it's not optional polish.
//
// Optimization patterns still in play:
//  - Fog caps visual draw distance, camera far-plane matches it.
//  - Draco geometry compression (decode-only, from loader.js) - full
//    coverage in this file (1046/1046 primitives).
//  - Meshes merged by material in Blender (your own pass) - 912 meshes,
//    down from TRY2's 1292 (which was itself down from FURNISHEDSCENE915's
//    2342). This is the real draw-call fix, still trending the right way.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { loadModel, loadingManager } from './loader.js';
import { toUnlitFlat } from './shading.js';
import { createAtmosphere } from './atmosphere.js';

// Real mesh collision, replacing the crude radius/axis clamps in
// controls.js (those stay in place as an outer safety-net backstop - see
// the comment there). Octree is three.js's own spatial index for exactly
// this: capsule-vs-triangle-soup collision without a full physics engine.
// Built once, from the WHOLE street mesh (all 912 meshes, post-swap), after
// addStreetScene finishes below - not a simplified/bounding-box proxy, per
// your ask for collision against the whole mesh. That build is a one-time
// synchronous cost (walks every triangle in the scene) so expect a brief
// hitch right when the street finishes loading, not a per-frame cost -
// controls.js just queries this already-built tree every frame, which is
// cheap regardless of how much geometry went into it.
export const worldOctree = new Octree();

// Temporary diagnostic - the street scene load/fail path only ever logged to
// console.error, which is useless if you don't have devtools open. This
// object gets updated as loading progresses; read it from devtools/console
// if a load ever silently fails or the bounding box looks suspicious.
export const streetSceneStatus = { state: 'loading', detail: '' };

// Live reference to the loaded street Object3D, for anything outside this
// file that needs to look up specific nodes by name (e.g. titleScreen.js
// resolving its menu-sign node names into real meshes to raycast against).
// `let` + reassignment, not a getter - ES module imports of a `let` binding
// are live, so `import { streetScene } from './world.js'` always reads the
// current value, it doesn't need re-importing after this gets set below.
export let streetScene = null;

// Vertical gradient backdrop (dark at top -> greyish purple at horizon),
// swapped in for the old flat scene.background Color per your "sky colored
// ombre" call. A plain 2D canvas is enough here - scene.background renders
// a plain Texture as a fixed screen-space image (top of canvas = top of
// screen), no equirect/cube projection needed for a backdrop this subtle.
//
// Transition compressed to the top 35% (was a full-height ramp) - most of
// what's actually visible in-game is a thin sliver of sky peeking over/
// between buildings, which was only ever catching the darkest part of the
// old full-height gradient and reading as "all black". Reaching the
// greyish-purple horizon tone within that first 35% means the visible
// sliver actually shows the ombre instead of just the top of it.
//
// Canvas bumped way up to 1536x768 (was 512x256, briefly) when stars still
// lived in here - a screen a few thousand pixels wide dividing by a 512px-
// wide source magnifies everything drawn on it, same bug documented on
// skyline.js's removal. Kept at 1536 even though the stars have since moved
// out (see below) since the higher res also makes the gradient itself
// smoother.
//
// The actual star dots that used to be drawn onto this canvas are gone -
// moved to atmosphere.js as a real animated Points layer (createStars)
// so they can actually twinkle, which a static canvas texture can't do
// without an expensive full-texture redraw every frame. This function is
// just the gradient now.
function createSkyGradientTexture() {
  const width = 1536;
  const height = 768;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  // Dark near-black (with a faint purple tint so it doesn't read as pure
  // gray/black) easing down into the same greyish-purple horizon color the
  // flat background used to be, darkened a touch per "a bit darker", now
  // lightened slightly (3a3742 -> 4a4555) so it actually registers as
  // purple against the dark rather than reading as more black.
  gradient.addColorStop(0, '#0e0c13');
  gradient.addColorStop(0.35, '#4a4555');
  gradient.addColorStop(1, '#4a4555');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function buildWorld(scene, renderer) {
  // Night/dusk palette, replacing the old neutral-daylight-haze setup - per
  // your call that the actual mood baked into TRY2_SCENE.glb's textures is
  // way more night-time-sunset than daylight. Checked directly rather than
  // guessing at colors: TRY2_SCENE.glb has no KHR_lights_punctual data (no
  // literal Blender Sun/light objects survived the glTF export - this file
  // is fully baked, so Blender's lighting only exists as painted-in texture
  // color, not as light nodes something like Three.js can read back out).
  // Sampled several of the actual exterior building bakes instead (MAIN
  // MARKET BUILDING BAKE, TEALBUILDING_BAKED, main blue building BAKED) -
  // they're genuinely dark (average RGB in the 0-20 range) with scattered
  // warm/cool highlight pops (teal ~[14,66,60], blue ~[13,31,67]), i.e. a
  // real blue-hour/dusk scene, not daylight. Fog/background swapped from
  // the old light gray-blue (0xb9c2cc) to a deep dusky plum-blue that reads
  // as "just after sunset" rather than "midday haze."
  //
  // Switched FogExp2 -> Fog (linear, near/far) per your call to get rid of
  // the haze inside the actual walkable area. FogExp2 has no "start
  // distance" - it's density-based and starts fogging from distance 0, so
  // even standing still and looking across a shop you were getting real
  // visible haze (~30% visibility by just 12 units per the old density
  // note). Linear fog fixes that with an explicit near/far range: near=32
  // means zero fog anywhere inside WORLD_RADIUS (30, controls.js's wander
  // clamp) or the ~30-unit corner-to-corner reach of the model's own
  // footprint (half-extents ~20.5x22.5) - the whole walkable area stays
  // clear. far=55 ramps it to fully opaque fog color just inside WORLD_SIZE
  // (60, the fallback ground plane below) - still doing the original job of
  // hiding the hard edge/horizon seam, just pushed out past where you can
  // actually stand instead of sitting on top of everything.
  // Lightened slightly (0x2b2440 -> 0x3c3350) as part of the contrast pass -
  // note this only affects the far ring past near=32, so it's mostly a
  // cosmetic/consistency change, not the fix for close-up storefront
  // contrast (see toneMapping note in main.js for that).
  // Lightened again + shifted more purple/magenta (less flat navy) per your
  // "more purple, sunset-ish" call: fog 0x3c3350 -> 0x4d3a70, background
  // 0x1f1a30 -> 0x3d2c5c. Then desaturated a notch per your follow-up
  // ("less saturated") - blended each toward its own gray equivalent
  // (~30%) rather than picking new hue/lightness targets from scratch, so
  // it keeps the same purple direction and brightness, just calmer: fog
  // 0x4d3a70 -> 0x4f4167, background 0x3d2c5c -> 0x3e3354.
  // "bring the fog back but more of a purple grey and make it slightly
  // dynamic" - shifted fog the same direction the background already went
  // ("very greyish purple," line ~146 below): blended 0x4f4167 toward its
  // own gray equivalent at ~55% (same technique as that pass), landing on
  // 0x4c4657 - still readably purple, just calmer/greyer to match. The
  // "dynamic" part is a slow, subtle lightness drift, not a color change
  // here - see the sine animation on streetFog.color in main.js's tick().
  // "mooooore fogggg closer to meeeee" - near pulled way in, 32 -> 10, so
  // it's no longer fully clear across the whole walkable area (the old
  // near=32 kept everything inside WORLD_RADIUS totally fog-free, see the
  // note above) - now it starts creeping in close, just past arm's reach.
  // far pulled in too, 55 -> 42, so the ramp to full opacity is steeper/
  // thicker rather than just starting earlier at the same old gentle slope.
  // "also turn the fog black" - color only, 0x4c4657 (greyish-purple) ->
  // 0x000000, near/far untouched. main.js's tick() drift (streetFog, the
  // "slightly dynamic" lightness breathe) reads its base HSL straight off
  // this color at module load, so it stays in sync automatically - black's
  // H/S are both 0, so the drift just nudges lightness between 0 and
  // +0.04, a faint near-black pulse rather than a color shift. Left
  // scene.background's gradient (horizon ~0x403d48) alone - you've drawn
  // that distinction before ("you asked for the background specifically
  // this round, left fog as-is"), so treating this the same way rather
  // than assuming black fog implies a black background too.
  scene.fog = new THREE.Fog(0x000000, 10, 42);
  // Desaturated background further per "very greyish purple" - pushed the
  // same gray-blend technique from ~30% to ~65%, background only (you
  // asked for the background specifically this round, left fog as-is):
  // 0x3e3354 -> 0x403d48. Same brightness/hue direction, just much closer
  // to neutral gray now.
  //
  // Swapped the flat Color for a vertical gradient per your "sky colored
  // ombre" call - dark near the top of the screen, easing down to the
  // greyish purple at the horizon (roughly where it meets rooftops/signs).
  // scene.background only accepts a flat 2D screen-space image when it's a
  // plain Texture (not sky-projected like a CubeTexture/equirect env map),
  // which is exactly what's wanted here since you said it may barely be
  // visible behind the buildings anyway - this is a cheap backdrop, not a
  // real sky dome. Horizon color kept at the same ~0x403d48 greyish-purple,
  // darkened a touch (per "a bit darker") rather than picked fresh.
  scene.background = createSkyGradientTexture();

  // Environment map for realistic PBR reflections - without this,
  // MeshStandardMaterial/MeshPhysicalMaterial surfaces have nothing to
  // reflect and read as flat/plasticky no matter how good their roughness/
  // metalness values are, since specular highlights are literally image-
  // based lighting sampled from this texture. RoomEnvironment is three.js's
  // built-in neutral studio-ish environment made for exactly this - it's
  // not meant to be seen directly (scene.background stays the fog color
  // above), just to give reflective surfaces something plausible to catch.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  pmremGenerator.dispose();
  // Dropped a bit further than the old daylight value (0.6 -> 0.45) - a
  // night scene should read moodier/darker in its reflections, not have
  // studio-bright highlights sitting on top of dark baked textures.
  // Nudged back up (0.45 -> 0.6) as part of the contrast-reduction pass -
  // this only touches the still-lit PBR exception materials (glass, trim),
  // not the baked storefronts, but it was crushing their reflections too
  // dark to read against the ACES curve below.
  scene.environmentIntensity = 0.6;

  // "Sun" is now doing sunset duty - warm low-angle key light instead of
  // neutral overhead daylight. Color shifted toward amber/pink
  // (0xfff2e0 -> 0xff9d5c) and dropped low on the horizon (y: 45 -> 10,
  // ~12° elevation vs. the old ~53°) for the long grazing shadows and warm
  // rim-lighting a real sunset throws, instead of flat top-down daylight.
  // Intensity trimmed too (1.6 -> 1.1) - it's now mostly there for
  // direction/shadow-casting and a warm kiss of light on the still-lit PBR
  // materials, not for overall scene brightness (the baked textures are
  // already carrying their own night lighting).
  const sun = new THREE.DirectionalLight(0xff9d5c, 1.1);
  sun.position.set(40, 10, 25);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  // Real-time shadows from the sun, per your call - renderer.shadowMap.enabled
  // (main.js) is the other half of this, doesn't do anything without a light
  // actually casting. Shadow camera is a tight orthographic box fit to this
  // scene's real bounds (checked via node-transform walk when the file was
  // first wired in: x -20.3..20.4, y -5.3..28.5, z -22.3..22.3) rather than
  // three.js's much larger default - a tight frustum matters a lot for
  // shadow quality, since the whole map's resolution gets spent on
  // whatever area the frustum covers. Too tight and shadows clip/pop at
  // the edges of the scene; too loose and they go blurry/blocky. 2048 map
  // size is a reasonable quality/cost middle ground for a scene this size.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 35;
  sun.shadow.camera.bottom = -10;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 100;
  // Bias fights shadow acne (the moiré/self-shadowing artifact flat
  // surfaces get from their own depth being compared against itself at
  // floating-point precision) without pushing shadows so far off their
  // caster that they visibly detach ("peter-panning").
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;

  // Sky/ground bounce fill - dusk-purple sky down to a warm amber ground
  // bounce (was sky-blue/brown daylight bounce). Intensity nudged up
  // slightly (0.45 -> 0.5) since the direct sun is dimmer now and this is
  // doing more of the work of keeping the still-lit PBR materials readable
  // in a darker scene. Nudged again (0.5 -> 0.65) alongside environmentIntensity
  // for the contrast pass - same caveat, only affects lit exception materials.
  scene.add(new THREE.HemisphereLight(0x4a4470, 0x5c3a28, 0.65));

  // fallback ground plane, slightly below y=0 so it doesn't z-fight with the
  // model's own street geometry - just a safety net for any gaps at the
  // edges of the model, not the primary walking surface. PBR now too
  // (MeshStandardMaterial), matte asphalt-ish gray, so it's lit consistently
  // with everything else instead of standing out as flat/unlit if it peeks
  // through a gap.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE),
    // Black instead of grey per your call - was 0x3a3a3f.
    new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // Fake distant skyline (used to live in skyline.js, now deleted) -
  // REMOVED, per your call after seeing it in both modes. Hiding it in
  // title mode fixed that view, but walk mode had the same underlying
  // problem: individual "windows" are a tiny handful of pixels out of a
  // 2048px texture wrapped around an 85-unit-radius cylinder, so even a
  // normal perspective view only ever sees a small, heavily magnified/
  // blurry slice of it - never actually reads as a skyline, just scattered
  // oversized color blocks. If it's ever worth rebuilding, that's the
  // exact scale/texture-resolution mismatch to fix first.

  // Floating light orbs + ground smoke - see atmosphere.js for the full
  // writeup. Returns an update fn since these are animated (uTime uniform
  // for the orbs, plain JS for the small smoke-puff count) - main.js's tick
  // loop needs to call this every frame, so it's handed back out of
  // buildWorld rather than self-driving off its own rAF loop.
  const atmosphere = createAtmosphere(scene);

  addStreetScene(scene);
  addLoki(scene);
  // addBackgroundBuilding(scene) - RETIRED as of TRY6_SCENE.glb: the
  // 920_WEB_OPTIMIZED_FINALSAVE_fullscene.glb upload merged that same mesh
  // directly into the main scene (node tripo_node_...001, loaded as part of
  // addStreetScene above already), so calling this too would add a second,
  // duplicate copy on top. Function left defined below, not deleted - same
  // "unwire don't delete" pattern as the five per-room rebake overlays -
  // in case a future export goes back to shipping it as a standalone file.

  return { updateAtmosphere: atmosphere.update };
}

// Shrunk 100 -> 60 to help kill the fog/horizon seam above - still 2x
// WORLD_RADIUS (30, controls.js's wander limit), plenty of margin for a
// fallback plane you're never meant to actually reach the edge of.
const WORLD_SIZE = 60;

// TRY4_SCENE.glb replaces TRY2_SCENE.glb - another round of your own baking/
// cleanup pass ("working on baking as many new textures as possible").
// Checked continuity the same way as the TRY2 switch, not assumed: Object040
// and Rack land at the exact same world-space position in both files (full
// transform-hierarchy walk), so no repositioning needed. Mesh count dropped
// again too - 912 meshes (was TRY2's 1292, FURNISHEDSCENE915's 2342 before
// that) - more merge-by-material work paying off.
//
// Lit-vs-unlit split carried over as an EXCLUDE list (baked/unlit by
// default, matches "pretty much everything is baked"), re-verified by name
// against this new file rather than assumed copied-over:
//  - VynilMaterial.002, Speaker.002, BoxMaterial.001, BoxMaterial.002,
//    RecordStoreWallsMaterial.002 - all confirmed present under the exact
//    same names, no change needed.
//  - Material_#11_1 (the hanger material, all 4 numbered variants) is GONE
//    - the hanger node (S_Hanger_2_003_123.002) now only lists the 10
//    clothing-item materials it always had, no separate hanger-plastic
//    primitive at all anymore. The base name "Material_#11_1" DOES still
//    exist in this file, but it's been repurposed onto an unrelated node
//    (Plane044) with a totally different color map - deliberately NOT
//    carried into the exception list below. Turns out this is correct, not
//    just a safe default: diffed materials against TRY2 directly and found
//    22 brand-new ones in this file, virtually all named after what they
//    are in their color map - including "Material.004" -> colormap "all
//    hangers baked". You baked the hangers this round, resolving the
//    back-and-forth from before - they're SUPPOSED to be unlit now, and
//    bake-by-default already gets that right without needing an exception.
// Also swept the other 21 new materials this same diff turned up (new box/
// crate/rack bakes, "OUTER POSTERS BAKED", "cornersigns baked", etc.) -
// none of their names collide with the exception list below, so they all
// correctly fall through to baked/unlit by default too.
//
// VynilMaterial.002, Speaker.002, BoxMaterial.001/.002 REMOVED from the
// exception list - found the hard way (green PlasticCrate bins not showing
// their new bake, bookshelves reading oddly dark). Checked directly: these
// 4 materials are NOT scoped to "the vinyl shelf" and "the speakers" the
// way they were when this exception was first written - they're generic
// material slots Blender reused across dozens of unrelated objects.
// BoxMaterial.002 alone is shared by 19 different box/crate/cabinet nodes;
// VynilMaterial.002 and Speaker.002 both turn up as sub-parts of merged
// Bookshelf/Cabinet nodes (a speaker or a stack of records sitting ON a
// shelf, merged into that shelf's single mesh) in addition to the actual
// dedicated Speaker0X_Cube/VinylShelf_Cube nodes. A material-name exception
// can't tell "the vinyl rack itself" apart from "a crate that happens to
// share the vinyl rack's plastic material" - keeping them lit meant EVERY
// object using these materials stayed on old dynamic-lighting-only
// rendering, hiding whatever new bake you'd done for that specific
// instance. Only RecordStoreWallsMaterial.002 stays - that one really is
// used by exactly one wall (confirmed: 1 node), and the ask there was
// specifically about keeping its normal map's bump response, not about
// texture freshness.
//
// "multiple items connected to one base color mesh that appear way too
// white" - first guess here was Material_#1111225034 (picked by evidence:
// most-shared material in the file + near-white average color), but you
// pointed at the actual Blender materials directly instead of me continuing
// to guess from the rendered result, so going with what you named rather
// than my inference:
//  - Material_#1111223369_2 (one of 3 materials on Box2229_1 - a single box
//    mesh with multiple printed faces sharing that one box's UV space,
//    which is exactly the "connected to UV" case from your original TRY2
//    instructions) - only this one face's material, not its _0/_1 siblings
//    on the same box, since you only named this one.
//  - Material_#5389 (Box2508), Material_#1111223370 (Plane433),
//    Material_#5366 (Box2354) - same pattern, single objects with
//    multi-region UV.
//  - lowitem2 - different shape (reused across 26 separate "Box111xx"
//    nodes rather than one multi-face object), but you grouped it with
//    the others so treating it the same way.
// Re-verified directly against TRY5_SCENE.glb (not carried over blind) -
// 3 of the original 6 no longer exist there (Material_#5389,
// Material_#1111223370, lowitem2 - same kind of churn as the TRY2->TRY4
// transition's "hanger material" loss noted below). The remaining 3 still
// resolve under the exact same names. If something that used to look
// dynamically-lit now reads flat/baked, one of the 3 dropped ones is the
// likely cause - check what material TRY5's Box2508/Plane433 nodes (and the
// 26 "Box111xx" nodes that used lowitem2) carry now and add it back here
// under its new name if still needed.
const LIT_EXCEPTION_MATERIAL_NAMES = new Set([
  'RecordStoreWallsMaterial.002',
  'Material_#1111223369_2', 'Material_#5366',
  // "i want normals on the wall, floor, and vinyl in the vinyl shop" -
  // wall/floor is RecordStoreWallsMaterial.002 above, already covered.
  // "theres one vinyl material not 5?" + "merge down to one material and
  // use these" (your own normal + base color atlas) - the 5 separate
  // Vynil materials only ever existed because each upload round added its
  // own copy of the same vinyl-record concept. Collapsed down to one
  // (VynilMaterial.004 - kept because it was already wired to the most
  // geometry, 17 of 22 vinyl primitives) with your new normal/base color
  // textures, every primitive that used .001/.002/.003/VynilMaterial_005_patch
  // repointed onto it, and those 4 now-empty material slots removed
  // entirely. One name here instead of five.
  'VynilMaterial.004',
]);

// "a lot of these also have the original material AND the baked. i want
// just the bake. each model apart from our agreed upon should really only
// have one texture map" - checked every material in TRY7_SCENE.glb
// directly: 307 already carry exactly one texture map, 10 carry none (flat
// color, nothing to strip), and the 2 lit exceptions above legitimately
// carry 3 (baseColor + normal + roughness, the thing you actually asked
// for on wall/floor/vinyl). The other 21 had TWO - a baseColorTexture AND
// an emissiveTexture - none of them lit exceptions, so they all go through
// toUnlitFlat(), which only ever reads material.map and falls back to
// emissiveMap ONLY when .map is missing (shading.js). Since all 21 have a
// baseColorTexture, the emissiveTexture's pixels were already dead - never
// sampled at render time, same "decoded but never drawn" waste as the
// normal/roughness strip before it. Pixel-checked all 21 pairs before
// touching anything (not assumed): 11 were literal duplicates of the same
// image in both slots, the rest had a real bake in baseColorTexture
// (several literally named "...BAKED" or "lightbaked-...") paired with an
// unrelated or near-blank emissive image - baseColorTexture was the
// intentional content in every case. Stripped emissiveTexture off all 21,
// then compacted images/textures/bufferViews (290->284 images).
//
// One thing worth guarding rather than blindly stripping: toUnlitFlat's LED
// flicker effect triggers off `hasEmissive`, which is true if EITHER
// emissiveMap is present OR emissiveFactor is a nonzero color - it never
// reads the emissive texture's actual pixels either way, just uses presence
// as a boolean. 18 of the 21 already had an emissiveFactor set, so dropping
// their texture doesn't touch whether they flicker. The other 3 (the
// B_CeilingLight materials - real light fixtures, where flicker is clearly
// intentional) had no emissiveFactor and were relying solely on emissiveMap
// presence to flicker - gave those 3 an emissiveFactor of [1,1,1] before
// dropping their texture, so the exact same flicker keeps firing with zero
// pixel data behind it.

// "you can rescale the huge baked and normal maps for the record store
// from 3k to 2048x2048" - the 4 textures that were still at 3072x3072: the
// two lit-exception materials' base color + normal (VynilMaterial.004's
// merged atlas from the material-consolidation pass above, and
// RecordStoreWallsMaterial.002's wall/floor bake + normal). Downscaled all
// 4 to 2048x2048 (LANCZOS). Base color stayed JPEG at the same quality it
// already was; normals stayed lossless PNG, per the project's standing rule
// of not lossy-compressing normal maps - the resample itself is the only
// quality cost there. Roughness on both materials was already 1024x1024,
// untouched. 139.7MB -> 123.4MB.

// "these are deletable" (deletable.zip, your manual triage of the 550-
// texture review export, 301 files). Matched by filename against the
// CURRENT file, not the old export's index numbers - those went stale
// after 5 rounds of recompaction. 256 of the 301 were already gone (dead
// normal/roughness/emissive maps from earlier strip passes, or old vinyl
// variants merged away this session) - nothing left to do there. Of the 45
// that were still live, held 2 back rather than deleting on your word
// alone, because they directly contradict explicit earlier asks and small
// Finder thumbnails make them easy to mistake for junk: "groundbake"
// (Material.005, the actual walkable ground plane - deliberately near-
// black per "Darken ground plane grey to black", which is exactly why a
// thumbnail could read as empty), and RecordStoreWallsMaterial's roughness
// map (one of only 2 materials left with real PBR normal/roughness,
// specifically because "i want normals on the wall, floor, and vinyl").
// Flagged those back to you instead of silently dropping them.
//
// The remaining 43 (all background-prop baseColorTextures going through
// toUnlitFlat - lamps, windows, cabinets, pipes, a traffic sign, non-hero
// NPC clothing; none share a name with any of your custom vinyl/thrift/sign
// bakes) had their texture reference replaced with a baseColorFactor set to
// that image's own average color (sRGB->linear converted to render the
// same as an average texture sample would) instead of just deleting the
// reference outright, which would've left them at glTF's default white.
// Many were already flat single-color swatches, so this is a zero-visual-
// change removal for those; the handful with real detail get flattened to
// their average tone, per your call. Checked the 2 window materials
// (alphaMode BLEND) for a real per-pixel glass pattern before doing this -
// both were already uniform flat alpha, so that alpha carried straight
// into the new baseColorFactor too. 123.4MB -> 119.8MB.

// "the roughness can be removed from the walls but keep the normal and
// base color" - RecordStoreWallsMaterial.002 keeps normalTexture and
// baseColorTexture, dropped metallicRoughnessTexture. Roughness now
// defaults to glTF's spec default (1.0, fully rough / no specular
// highlight) since nothing else sets a roughnessFactor - fine for matte
// walls, and a one-line roughnessFactor tweak if it ever reads wrong,
// rather than carrying a whole texture for it. 119.8MB -> 118.8MB.

// "compressable.zip" + "keep the visual strength as much as possible" -
// your triage of 80 background-prop textures you want SHRUNK, not deleted
// (unlike the deletable pass above). Matched by filename against the
// current file (with a truncation-prefix fallback for names the original
// export cut short, like RecordSWindowMaterial's combined name) - 76 of 80
// still exist.
//
// Checked alphaMode on every material touching these 76 before compressing
// anything: baskets, a network-rail fence, and RecordSWindowMaterial.002
// (actual window glass) are BLEND-mode and genuinely need their alpha
// channel, so those stayed PNG - lossless re-optimize only, same pixels.
// 30 were already JPEG - left completely untouched, since re-encoding an
// already-lossy JPEG is pure quality loss for little size gain, which
// works against "keep the visual strength." The other 39 are PNGs whose
// alpha channel is present but DEAD (their material's alphaMode is the
// glTF default OPAQUE - the renderer never reads that alpha regardless of
// what's baked into it) - converted those to JPEG quality 94, well above
// what's already used elsewhere in this file, so the actual baked detail
// stays visually intact. 118.8MB -> 98.8MB - first time this file's been
// under GitHub's 100MB push limit.

// "anything else i can cut down?" - ran the same rule the compressable.zip
// pass established, across the WHOLE file instead of just the 80 you'd
// hand-picked: every PNG whose alpha channel is dead (material's alphaMode
// is the glTF default OPAQUE, so the renderer never reads it) becomes JPEG
// quality 94. Found 99 more this way (56.6MB). Held back 15 that genuinely
// need alpha - BLEND-mode materials, plus anything shading.js force-cuts-
// out by name (eyelash/eyeliner/eyebrow hints) - those stayed untouched
// PNGs. Every already-JPEG image, and the two lit-exception record-store
// materials, untouched as before. 98.8MB -> 54.8MB.

// "finish sweeping first!" - last pass, checked all 25 remaining PNGs by
// hand. 7 (Material_#1000000024/25, #69, #1111225183/203/204, #27_1, all
// OPAQUE) turned out to have no alpha channel at all - missed by the last
// two sweeps since that logic only handled "alpha present but dead," never
// "no alpha to begin with." Nothing to lose there - straight JPEG q94. The
// other 15 are genuine BLEND-mode alpha (baskets, fence/rail, 3
// RecordSWindowMaterial variants, a few small props) - kept PNG, ran a
// lossless re-optimize pass (0 improved further - they were already
// optimally encoded). The last 3 (RecordStoreWalls' normal, VynilMaterial's
// merged normal + metallic-roughness) are untouched, same as every pass
// before - normal maps stay lossless, and these are the only 2 materials
// left reading real PBR data. 54.8MB -> 49.4MB. Every PNG left in the file
// now has a specific, checked reason to still be one.

// "i forgot some baked textures for some items. i fixed in here. all are
// compressable" (missed and forgotten textures.glb) - this is the food-
// dish atlas and 6 other items from your "i see a few missing textures"
// screenshots earlier. Matched by node name (Object070/073, Object258,
// Object1720, Object1405100615_2, Object1405100847_1, Plane1000174), all
// confirmed the same objects by identical transforms first. The 8 material
// names here (a_1, Material_#79_1_X, etc) are Blender-generic and ARE
// shared with unrelated objects elsewhere (Material_#79_1_0/_7 alone also
// live on 3 iPadBOX nodes) - imported as brand new material/texture
// entries rather than overwriting those shared slots, so only these 7
// nodes' primitives changed. Vertex-count-checked every node before
// deciding material-only-swap vs full transplant: Object070/073, Object1720,
// and Plane1000174 had identical geometry already in the file (material
// swap only); Object258 and Object1405100615_2 and all 3 primitives of
// Object1405100847_1 had different vertex counts (full geometry transplant,
// same as the crate-saga lesson - matching material name isn't matching
// geometry). Dropped KHR_materials_specular on all 8 (dead weight, same as
// every other non-lit-exception material) and converted the 4 PNGs among
// their 21 images to JPEG q94 per "all are compressable" - none of these
// materials set alphaMode, so all default OPAQUE and their alpha (even
// TEALBUILDING_BAKED's real alpha variance) is never actually read.
// 49.4MB -> 51.3MB.

// Manually folds the FULL street setup - base TRY4_SCENE.glb load, all four
// rebake swaps, and the free windows material - into loader.js's shared
// LoadingManager queue, not just the base file. Without this, the manager's
// onLoad (which hides the loading screen - see loader.js) fires the moment
// TRY4_SCENE.glb alone finishes, since that's the only item it's tracking
// at that point - the rebake loadModel() calls below don't start until
// AFTER that await resolves, so the loading screen was hiding early and you
// were watching the rebakes pop in live afterward. That's the actual root
// cause of "loads in old textures first" - itemStart here before anything
// loads, itemEnd in the finally block below once EVERYTHING (including the
// synchronous windows swap) is done, keeps the queue non-empty and the
// loading screen up for the whole real duration.
const STREET_LOADING_TOKEN = 'street-scene-full-load';

async function addStreetScene(scene) {
  loadingManager.itemStart(STREET_LOADING_TOKEN);
  try {
    // TRY7_SCENE.glb - latest full-scene pass. History (TRY4 -> TRY5 -> TRY6)
    // trimmed out of this comment since it was getting long enough to bury
    // what's actually current - see git log on this file if you need the
    // play-by-play (each swap's reasoning is in its own commit message).
    //
    // Source upload: heavydutyfullscene.glb, 648MB raw - "baked a few new
    // textures like the fence and added a new building." Verified by direct
    // diff against TRY6's source, not assumed: 714 nodes (was 724) - NOT
    // purely additive this time, 4 added / 14 removed. The removed 14 don't
    // match anything this codebase references by name (checked against
    // every MENU_SIGN/THRIFT/VINYL/LANDMARKS/LIT_EXCEPTION/RECORD_PLAYER
    // list directly) - reads as Blender-side geometry cleanup alongside the
    // rebakes, not anything load-bearing. One removed node DOES matter
    // though: Plane.003, the old flat billboard-with-a-photo "wall with a
    // building on it" - gone, replaced by one of the 4 added nodes,
    // tripo_node_1b17d649..., a real 3D building mesh this time instead of
    // a flat cutout plane. See TITLE_HIDDEN_NODE_NAMES below - carried the
    // same "don't block the title camera" layer treatment over to it. The
    // other 3 added nodes (2 Counter_Cube/1 Stickersbox02) are plain props,
    // nothing referenced them before so nothing to update.
    //
    // Images: 548/554 byte-identical to TRY6's source by content hash
    // (reused, not reprocessed - same approach as every prior full-scene
    // swap), 6 genuinely new: the fence rebake ("sidebakedrail"/"bakedfence",
    // landing on existing nodes B_Networkrail_0003/007 - texture-only swap,
    // matches "baked... the fence" exactly), a speaker rebake, a fresh
    // "groundbake" (this one didn't match TRY6's patched-in version by hash,
    // but same small 1024px non-issue either way), and the new building's
    // normal+color maps (normal forced PNG per the usual rule, never JPEG).
    // Standard 1536px/JPEG-q80 tier throughout, same two called-out HD
    // exceptions as always (RecordStoreWallsMaterial.002 wall/floor,
    // VynylMaterial.004 records, both 3072px + lossless normal maps) plus
    // the thrift clothing/shoe HD tier. Landed at 152.0MB.
    //
    // Memory-crash fix (post-launch): the browser tab was getting killed by
    // Chrome's "significant memory" tab-kill. Measured directly, not
    // guessed - 554 unique textures across this scene decode to ~2.5GB of
    // GPU memory once uploaded+mipmapped (no texture atlasing, every
    // baked room/prop is its own image). The real fix is GPU-compressed
    // textures (KTX2/Basis - the loader support from way back is sitting
    // unused for exactly this), but there's no encoder tool reachable to
    // do that conversion right now. Stopgap: dropped the standard tier's
    // JPEG/PNG resolution 1536px -> 1024px, EXCEPT the 17 sign panels
    // (MENU_SIGN_NODE_NAMES), the 14 thrift clothing/shoe items
    // (THRIFT_SIMPLE_SWAP_NODE_NAMES), and the two established HD-tier
    // materials (RecordStoreWallsMaterial.002 wall/floor, VynylMaterial.004
    // records - left fully untouched at 3072px, not even trimmed to 2048)
    // per your "keep the agreed high res" call - those 25+4 images were
    // walked out via the real node->mesh->material->texture graph, not
    // guessed from filenames. Only 64 of 554 images actually changed.
    // Brought the ~2.5GB estimate down to ~2.05GB - real but partial; if
    // the crashes continue, the next lever is the untouched 1024px bucket
    // (231 images, ~1.3GB on its own) or finally sourcing a KTX2 encoder.
    //
    // Vinyl store item fixes (bakedvinylnewtextures.glb, two rounds): first
    // round only patched what pixel-diffed as genuinely different
    // (Box01/03/04 -> "boxbake", PlasticCrate03/06's box part ->
    // "combocrates", Stickersbox02_Cube.099 reassigned to the ALREADY-
    // correct SouvenirsMaterial.001 instead of the vinyl-records material
    // it was wrongly on). Second round, per "change everything": also
    // patched PlasticCrate02 (cloned off VynilMaterial.004 into its own
    // material - it was sharing that 19-user material and couldn't be
    // edited in place), PlasticCrate06's vinyl-part primitive
    // (VynilMaterial.002, patched in place - sole user), and the record
    // player (EletronicsMaterial.002, patched in place - shared by
    // RecordPlayer_Cube.001 AND .070, both get it). Vinyl-family textures
    // kept at the established 3072 HD cap; record player at the standard
    // 1024 cap. Also stripped RecordPlayer's emissive entirely (factor +
    // texture + KHR_materials_emissive_strength) per "i also took emmissive
    // off of a few things" - the new export has none. Also re-patched the
    // ground plane bake (groundplanebakeds.glb, same Plane.002/
    // Material.005 as before - genuinely new content, diff 36 vs the old
    // bake). Note: the two fresh 3072px HD normal maps this added back
    // about ~100MB of GPU texture memory on top of the crash-fix pass
    // above - expected, vinyl is the one family that's deliberately staying
    // HD.
    //
    // "updated baked maps for the loki car, the main sidewalk, and the side
    // sidewalk" (BAKED MAIN PAVEMENT.png / SIDE SIDEWALK PROPERLIT.001.png
    // / lokifullbake.png) - identified by checking directly, not guessing:
    // Material.005 ("groundbake", node Plane.002) is the one this file
    // already documents as the actual walkable ground plane, matching
    // "main sidewalk." Material.001 (node Plane.001, old image name
    // "BakedTexture_Music") matched by its baseColorTexture already being
    // 1024x1024 same as the new upload, and its filename's ".001" suffix
    // lining up with Blender's own auto-increment naming for that same
    // material - "side sidewalk." Straight baseColorTexture swap on both,
    // re-encoded JPEG (both materials are the file's usual OPAQUE default,
    // no alphaMode set, so the new bakes' alpha-padding gets dropped same
    // as everywhere else in this file). Loki's single material (LOKI.glb)
    // got the same treatment - its new 1024x1024 bake is actually smaller
    // than the 2048 one from this session's own earlier downscale pass, so
    // LOKI.glb dropped 2.0MB -> 178KB on top of being a content update.
    // Re-verified TRY7_SCENE.glb against verify_try7.mjs after the swap -
    // same 689 meshes/340 materials, every tracked node-name group still
    // matched (17/17, 14/14, 54/54, 6/6, 6/6) - a base-color-only texture
    // swap doesn't touch node names/counts, but checked anyway rather than
    // assuming.
    //
    // Missed two on that pass: PlasticCrate04_Cube.001 and
    // PlasticCrate05_Cube.001 weren't in bakedvinylnewtextures.glb (only
    // 02/03/06 were), so they got skipped even though they needed the same
    // "combocrates" fix as 03/06 - a follow-up upload ("fucking please.glb")
    // called them out specifically. No new texture work needed, just
    // rewired both onto the already-existing BoxMaterial_combocrates_patch
    // material from the round above.
    //
    // PlasticCrate06's vinyl-part primitive - went back and forth on this
    // one, settled by re-reading "fucking please.glb" itself instead of
    // going on your ".005" shorthand: that file's own materials list is
    // BoxMaterial.006, BoxMaterial.005, VynilMaterial.002 - there IS no
    // VynilMaterial.005 in it. The ".005" was BoxMaterial.005 (the crate
    // box tier, same one PlasticCrate03/04/05 use), and the vinyl half of
    // the split PlasticCrate06 mesh is plain VynilMaterial.002 ("the
    // regular vinyl pattern"). Reverted off the VynilMaterial_005_patch
    // material back onto 281 (VynilMaterial.002, already correctly
    // textured from the original bakedvinylnewtextures.glb patch). Also
    // checked "fucking please.glb"'s node transforms against the live
    // scene directly (translation/rotation/scale, all 5 nodes) - byte-
    // identical, nothing had actually moved this round.
    //
    // Real bug, found after actually looking at the extracted PNGs instead
    // of trusting pixel-diff numbers alone: the "combocrates" image inside
    // bakedvinylnewtextures.glb (used for BoxMaterial_combocrates_patch,
    // material ".005") is genuinely dark/washed out - confirmed against
    // the RAW upload bytes directly, not something my re-encode broke. You
    // posted the actual correct bake as an image (saved as
    // uploads/combocrates.png) - swapped material 342's baseColor to that
    // file directly. Standard tier, already 1024 with real alpha, no
    // resize needed.
    //
    // Turned out the combocrates swap above wasn't actually the fix (the
    // "correct" combocrates.png you posted was pixel-IDENTICAL to what
    // bakedvinylnewtextures.glb already had embedded - checked directly,
    // not assumed - so that whole texture was a red herring). The real bug:
    // "fucking please.glb" wasn't just new materials, it had different
    // GEOMETRY for Box03/PlasticCrate03/04/05/06 too ("combined and
    // separated from the base mesh" - confirmed by reading the accessors
    // directly, different vertex counts than what TRY7 had). Patching just
    // the material left the OLD geometry's UVs pointing at the wrong part
    // of the new texture atlas - that's what the solid-black crate in your
    // screenshot was (UVs sampling the atlas's unused black space, not a
    // missing/broken texture). Fix: full mesh transplant, not a material
    // patch - copied the actual Draco-compressed primitive data (bufferView
    // + accessors) for all 5 nodes straight out of "fucking please.glb"
    // and swapped each node's mesh index outright, materials pointed at
    // the same already-correct TRY7 materials (341/342/281), node
    // transforms copied verbatim from the upload too.
    //
    // Dedup pass (your "how are we looking size-wise" ask): MD5'd every
    // embedded image and found 9 groups of EXACT byte-for-byte duplicates,
    // mostly from the vinyl-family material patches above re-encoding the
    // SAME source pixels as a fresh image instead of reusing what was
    // already in the file (VynilMaterial_Normal_OpenGL existed 3 separate
    // times - 9.92MB/3072px each). Repointed every texture onto a single
    // canonical copy per group and fully compacted the images/bufferViews
    // arrays so the freed bytes are actually gone, not just orphaned JSON.
    // Nothing about resolution or quality changed - every surviving image
    // is byte-identical to what was already there, this only removed
    // exact duplicates. 177.0MB -> 153.6MB file size, ~2.38GB -> ~2.15GB
    // estimated decoded GPU memory.
    //
    // Dead-weight pass - your catch, not something I went looking for:
    // "a lot of these have normals, i thought this was baked and unlit."
    // Checked shading.js's toUnlitFlat() directly - it builds a
    // MeshBasicMaterial and only ever wires up color/map/transparent/
    // opacity/alphaTest/side. normalTexture, metallicRoughnessTexture, and
    // (same category, same reason) KHR_materials_specular's specular/
    // specularColor textures are NEVER read by that material type -
    // decoded on load, never touch a rendered pixel, for every material
    // except the (currently 2, actually in-use) LIT_EXCEPTION_MATERIAL_NAMES.
    // Stripped those three texture slots off every non-exception material,
    // then fully compacted images/textures/bufferViews so the freed bytes
    // are actually gone. 550 images -> 290, 153.6MB -> 130.4MB. First pass
    // at this crashed the verify harness - missed that
    // KHR_materials_specular's textures live under material.extensions,
    // not the top-level texture slots, so the index remap broke a handful
    // of materials before I caught it there instead of on the live site.
    //
    // Continuity re-verified in full against the SAME reference lists every
    // prior swap has checked: all 17 MENU_SIGN_NODE_NAMES, 14
    // THRIFT_SIMPLE_SWAP_NODE_NAMES, 54 VINYL_STORE_SIMPLE_SWAP_NODE_NAMES,
    // plus the crates/glass-building/cover-supply landmark nodes - still
    // resolve under their exact names. The five per-room rebake overlays
    // stay DISABLED, same reasoning as always - see their old Promise.all
    // call site further down.
    const { scene: street } = await loadModel('/models/TRY7_SCENE.glb');

    // Baked/unlit by DEFAULT now - only LIT_EXCEPTION_MATERIAL_NAMES above
    // (just the record-store wall's normal map at this point - see the note
    // above it) stays on the normal lit PBR path GLTFLoader already builds.
    // Everything else - all the clothing prints, architecture, signage,
    // furniture, crates, etc. - gets flattened to MeshBasicMaterial via
    // toUnlitFlat. toUnlitFlat already injects real emissive (map + factor +
    // KHR_materials_emissive_strength) into the unlit shader (see
    // shading.js) - applying it broadly like this is what actually "brings
    // the emission back" on baked signs/lights, no separate glow hack
    // needed (that hack is gone below, see the comment where it used to be).
    let meshCount = 0;
    street.traverse((obj) => {
      if (obj.isMesh) {
        meshCount++;
        obj.castShadow = true;

        // Same double-sided-floor shadow-acne fix as before - forces the
        // shadow pass to only use the front face of double-sided materials,
        // otherwise flat single-layer floor slabs wash their own shadows
        // out (front and back face sit at virtually the same depth).
        const oldMaterials = Array.isArray(obj.material) ? obj.material : [obj.material];
        // Stash the ORIGINAL glTF material name(s) before toUnlitFlat below
        // replaces the material object entirely - toUnlitFlat's
        // MeshBasicMaterial never copies .name over, so anything that later
        // needs to identify a mesh by its source material (partial rebake
        // swaps, see addThriftRebake below) can't read it off
        // obj.material.name anymore after this loop runs. Bit this exact
        // bug before with the crates rebake - fixing it generally here so
        // it doesn't have to get rediscovered every time.
        obj.userData.origMaterialNames = oldMaterials.map((m) => m?.name ?? null);
        const newMaterials = oldMaterials.map((mat) => {
          if (!mat) return mat;
          if (mat.side === THREE.DoubleSide) mat.shadowSide = THREE.FrontSide;

          if (LIT_EXCEPTION_MATERIAL_NAMES.has(mat.name)) return mat;
          const unlit = toUnlitFlat(mat);
          if (unlit.side === THREE.DoubleSide) unlit.shadowSide = THREE.FrontSide;
          unlit.polygonOffset = true;
          unlit.polygonOffsetFactor = 1;
          unlit.polygonOffsetUnits = 1;
          mat.dispose();
          return unlit;
        });
        obj.material = Array.isArray(obj.material) ? newMaterials : newMaterials[0];
        // Unlit materials get no benefit from receiving shadows (no lighting
        // term to darken) - only turn it on for meshes that stayed lit.
        obj.receiveShadow = newMaterials.some((m) => m !== null && !(m instanceof THREE.MeshBasicMaterial));
      }
    });

    // "i dont want it to block the camera in the main menu" - the new
    // ground plane (Plane.002) and the wall+building (Plane.003) render
    // fine in walk mode but risked sitting in the title screen's
    // orthographic view of the sign building (same `scene`, same objects,
    // only the camera differs between modes - see main.js/titleScreen.js).
    // THREE.Layers is the standard fix for "visible from one camera, not
    // another" without needing a second scene graph or a per-frame
    // visibility toggle: put these two on layer 1, leave every camera at
    // its default (layer 0 only) except the walk camera, which explicitly
    // opts into layer 1 too (see main.js). Title's OrthographicCamera never
    // enables layer 1, so it simply never sees these two nodes - they're
    // still fully present/rendered in walk mode. Layers don't inherit
    // through the hierarchy in three.js (each Object3D checks its own
    // .layers, not a parent's), but both of these resolve directly to leaf
    // meshes (verified via the node harness, isMesh true for both, no
    // children to also flag), so setting it once per node is enough - no
    // traverse needed. The merged-in BG building (tripo_node_...001) is
    // NOT included here - it already existed before this upload as a
    // separate file and nobody flagged it blocking the title view, so it
    // stays on the default layer, visible from both cameras same as always.
    // Plane.003 -> tripo_node_1b17d649... as of TRY7_SCENE.glb - the flat
    // billboard got replaced by a real building mesh (see the load comment
    // above), same "don't block the title camera" concern carries over.
    // Its base-color texture got two follow-up patches from standalone
    // "buildingbake.glb" uploads. First just swapped the bake. Second was
    // "rescaled and new bake" - node transform updated too this time
    // (translation.y 23.71->16.94, scale.y 51.98->37.26, shorter and
    // lowered to stay grounded at the new height; x/z untouched, checked
    // directly against the upload's own node values, not guessed). Normal
    // map still untouched both times - byte-identical hash across all three
    // uploads, never actually changed.
    const TITLE_HIDDEN_NODE_NAMES = ['Plane.002', 'tripo_node_1b17d649-d3ad-4287-9088-27fc9b46c0de'];
    for (const rawName of TITLE_HIDDEN_NODE_NAMES) {
      const node = street.getObjectByName(sanitizeGltfName(rawName));
      if (node) {
        node.layers.set(1);
      } else {
        console.warn(`[title-hidden] ${rawName} not found in TRY7_SCENE - skipping`);
      }
    }

    // Windows swap (see addBlackGlassWindows below for the full writeup)
    // runs HERE, before scene.add - it's plain in-code material assignment
    // with no GLB fetch behind it, so there's no reason to let it join the
    // async rebake batch below and risk a frame or two of the old baked
    // gold-glow material before scene.add even happens. Doing it first
    // means the street never has an old-windows frame to pop from at all.
    addBlackGlassWindows(street);

    scene.add(street);
    streetScene = street;

    // Cover Supply sign - was guessing this needed to move to different
    // panels elsewhere on the building (see git history / old comment here
    // if curious), but that guess was wrong: you exported the actual node
    // (COVER_SUPPLY_SIGN.glb - same name "Object1783_2", same material
    // "Material_#1111223362", same position (-8.11, 0.02, -9.12) as what's
    // already in TRY4_SCENE.glb) with a real new bake. So the node was
    // always in the right spot - it just had the wrong TEXTURE (old one:
    // 512x512 RGB, no alpha, nearly blank/white. New one: 1024x1024 RGBA,
    // a real cutout - checked directly, alpha is ~76% fully transparent /
    // 23% fully opaque, basically no soft partial-alpha pixels, i.e. a
    // clean sign-shape cutout, not a soft blend). Straight texture swap on
    // the existing node, not a reposition or a cross-panel split.
    //
    // These four rebake swaps used to run as sequential awaits (one whole
    // fetch+parse had to finish before the next one even started
    // downloading). That's the actual cause of the "loads in old textures
    // first, then pops" choppiness - TRY4_SCENE.glb renders immediately
    // with its original baked materials, and each rebake only replaces its
    // bit once ITS OWN turn in that queue comes up, so the pop-in was
    // getting smeared out over the sum of all four load times instead of
    // the slowest one. Promise.all fires all four fetches at once, so the
    // whole batch lands together in roughly max(...) time instead of
    // sum(...) - same total data, shorter/less staggered flash of old
    // materials before the swap. Order doesn't matter between them (each
    // touches a disjoint set of nodes), so there's no correctness reason
    // they needed to be sequential in the first place.
    // All five of these per-room rebake overlays (addCoverSupplySignSwap/
    // addCratesRebake/addGlassBuildingSwap/addThriftRebake/
    // addVinylStoreRebake) are DISABLED as of TRY5_SCENE.glb, not deleted -
    // same "unwire don't delete" pattern as companion.js/npc.js elsewhere in
    // this project. Reasoning: TRY5 (source upload
    // 921_WEB_OPTIMIZED_FINALSAVE_allbaked.glb) already contains every node
    // these five functions target, under the exact same names, positions,
    // and material names as before - verified directly (all 54 vinyl-store
    // names, 14 thrift names, plus the cover-supply/crates/glass-building
    // landmark nodes all resolve). The filename itself ("FINALSAVE",
    // "allbaked") plus that exact-name continuity strongly suggests this
    // export already IS the up-to-date, finalized version of those rooms -
    // re-applying the older separately-uploaded rebake files on top would
    // risk overwriting TRY5's own current bakes with stale ones rather than
    // improving anything. If any specific room turns out to look wrong (an
    // old/different bake than expected), the fix is to re-enable just that
    // one call below rather than assuming all five need to come back.
    //
    // await Promise.all([
    //   addCoverSupplySignSwap(street),
    //   addCratesRebake(street),
    //   addGlassBuildingSwap(street),
    //   addThriftRebake(street),
    //   addVinylStoreRebake(street),
    // ]);

    // (windows swap - addBlackGlassWindows - already ran above, before
    // scene.add, since it doesn't need to wait on anything)

    // No auto floor-shift here, on purpose - see the kabukicho/
    // FURNISHEDSCENE915 lesson this comment used to describe in more detail:
    // a single outlier mesh can drag the whole bounding box and make a
    // correctly-placed scene look wrong if you naively shift by -box.min.y.
    // Landmark positions (Object040, Rack) matched the old file exactly, so
    // this scene's own placement should already be correct - just measuring
    // for the status readout below, not touching position.
    const box = new THREE.Box3().setFromObject(street);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    console.log('[street scene] size:', size, 'center:', center, '- no shift applied (see comment above)');

    // Build the collision octree from the FINAL geometry - after the sign/
    // crate swaps above, not before, so the tree matches what's actually
    // on screen (a stale pre-swap tree would let you walk through the new
    // crates or clip into the old sign panel's leftover shape). Whole
    // street mesh goes in, not a wall-only subset - see the export site for
    // the perf note on this being a one-time cost, not per-frame.
    worldOctree.fromGraphNode(street);

    streetSceneStatus.state = 'loaded';
    streetSceneStatus.detail =
      `meshes:${meshCount} size:${size.x.toFixed(0)}x${size.y.toFixed(0)}x${size.z.toFixed(0)} ` +
      `rawCenterY:${center.y.toFixed(0)} finalPosY:${street.position.y.toFixed(0)}\n` +
      // Per-room rebake overlays (vinyl/thrift/crates/glass/cover-supply) are
      // disabled as of TRY5_SCENE.glb - see the long comment at the old
      // Promise.all call site above for why. This used to show live
      // simple/multi/add counts for the vinyl rebake specifically; leaving
      // that stat out now rather than showing permanent 0/0s, which would
      // read as a failure instead of "intentionally not running."
      `rebakes: disabled (TRY5 has these baked in already)`;
  } catch (err) {
    console.error('[street scene] failed to load TRY2_SCENE.glb:', err);
    streetSceneStatus.state = 'error';
    streetSceneStatus.detail = String(err?.message ?? err);
  } finally {
    loadingManager.itemEnd(STREET_LOADING_TOKEN);
  }
}

// Background filler building (BG_BUILDING.glb, from your upload "BG
// BUILDING.glb" - a single standalone mesh, not a swap onto anything in the
// main street scene). Placement is NOT guessed - the source file already
// carries a real position/rotation/scale baked onto its one node
// (translation ~47.4/16.5/-6.8, uniform scale ~57.6x), well outside the
// walkable radius (controls.js's WORLD_RADIUS is 30), consistent with "put
// it behind the walkable scene" - so this just loads the file and adds it
// as-is, no transform copying needed like the other additive rebakes.
//
// Re-processed from your second upload, which had your own re-baked/
// compressed color texture ("extrabuildingfiller_baked", 1024x1024) already
// swapped in, position nudged, and Draco compression turned on for the
// geometry - re-extracted fresh from that file rather than reusing the
// first pass. Still dropped NormalGL/ORM (this mesh goes through
// toUnlitFlat() below same as everything else baked in this scene, which
// only ever reads material.map - normal/ORM are never sampled by an unlit
// MeshBasicMaterial, so shipping them is dead weight regardless of which
// upload they came from).
//
// NOT blurring the texture anymore. Two earlier passes baked a Gaussian
// blur in as a cheap stand-in for depth-of-field (radius 14, then a lighter
// radius 4 after "doesn't look anything like this") - both were the wrong
// move per your call: "dont bake the texture. it already is baked" - it's
// your finished bake, not raw source for me to reprocess, and any "seems
// farther away" treatment belongs in a real render-time effect (like the
// title screen's tilt-shift pass, postprocessing.js) if/when this mesh
// needs one, not baked destructively into the only copy of the texture.
// This pass just re-encodes the PNG with PIL's optimize=True (lossless -
// same pixels, smaller file from better DEFLATE settings) per "compress it
// at MOST but please dont much": ~863KB -> ~650KB, pixel-identical, no
// quality lost. Texture has real (non-cutout) alpha - carried through as
// alphaMode BLEND, not forced opaque.
// lokibaked.glb / lokibaked-1aea9f4a.glb - "a 16k mesh with one single
// baked UV" you asked about, then uploaded. Single mesh (15,399 verts,
// 21,546 tris), single material, single 4096x4096 baked PNG. Geometry is
// Draco-compressed already (~72KB), so the only real weight was the
// texture: downscaled 4096 -> 2048 and re-encoded losslessly (PIL,
// optimize=True), same "shrink the bake, don't touch the mesh" move used
// on the record store 3k->2k pass - 4.71MB source glb -> 1.92MB LOKI.glb.
//
// Position/rotation/scale are NOT set here - per "this was one asset in
// the scene directly exported," the node's transform in the file itself
// (translation ~(-17.47, 0, -16.69), a quaternion rotation, ~0.0093 scale)
// already IS the correct world placement from Blender, so this just adds
// the loaded scene as-is, same trust-the-export pattern as
// addBackgroundBuilding right below.
//
// One thing worth flagging, not silently deciding: the bake's alpha
// channel has real partial-transparency data (~7% of pixels sit around
// alpha 102, reads like soft cutout edges - hair/fur strands, most
// likely), but the exported glTF material never sets alphaMode to BLEND
// or MASK, so per spec (and this whole file's established "alphaMode
// defaults to OPAQUE" rule) it renders fully opaque here, same as
// GLTFLoader would render it anywhere else. If those edges are meant to
// read as soft/transparent instead of solid, that's a re-export with
// alphaMode set on the material, not something to guess at from here.
const LOKI_LOADING_TOKEN = 'loki-model-load';

// imonloki.glb - "im sitting on top of the car" for the About Me section,
// confirmed "the car" IS the Loki model right above. 35MB source, almost
// entirely unused PBR maps: 10 character-part meshes (body/hair/eyes/
// shorts/tank top/laces/a strap) each came with normal + occlusion +
// metallicRoughness textures (some 4k, one 8.9MB alone) on top of the
// baseColor map, none of which this site's unlit pipeline reads
// (toUnlitFlat only ever looks at .map). Stripped every material down to
// just its baseColorTexture and dropped the now-unreferenced image bytes
// straight out of the file (not just ignored at runtime) - 35.0MB ->
// 3.94MB. Also deliberately dropped the Details/laces material's
// emissiveTexture (it had one, 49KB) rather than carrying it through:
// toUnlitFlat treats ANY emissiveMap as "this is an LED sign, flicker it"
// (see shading.js), which is correct for city signage and would have been
// wrong here - shoelaces flickering like a neon sign. eyes_base_color had
// no alpha channel at all (safe PNG->JPEG). Hair's alphaMode is BLEND in
// the file - real cutout cards - left as PNG with alpha. body/shorts/tank/
// lasjes have real alpha data too but no alphaMode set on their materials,
// so same as Loki's own bake, they render OPAQUE per spec regardless -
// left alone rather than guessing at intent.
//
// Placement: the 10 part-nodes' own translation/rotation/scale (all
// checked directly in the exported file) put them at ordinary human-figure
// proportions - basically already real-world-meter scale, no correction
// needed. Loki's single node, by contrast, needed that ~0.0093 scale
// factor to come down to real-world size from whatever much larger unit
// Blender modeled it in. So this group is placed at Loki's node's own
// world position/rotation (same spot in the city, facing the same way)
// but WITHOUT inheriting Loki's scale - copying that too would shrink a
// full human figure down to about 1% size. Exact seating/offset and the
// camera framing for this section are still coming from you - this just
// gets it sitting in the right neighborhood, not pixel-perfect yet.
const IMONLOKI_LOADING_TOKEN = 'imonloki-model-load';

async function addImOnLoki(scene, lokiNode) {
  loadingManager.itemStart(IMONLOKI_LOADING_TOKEN);
  try {
    const { scene: me } = await loadModel('/models/IMONLOKI.glb');
    me.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    if (lokiNode) {
      me.position.copy(lokiNode.position);
      me.quaternion.copy(lokiNode.quaternion);
      // scale intentionally NOT copied - see writeup above.
    }
    scene.add(me);
  } catch (err) {
    console.error('[imonloki] failed to load IMONLOKI.glb:', err);
  } finally {
    loadingManager.itemEnd(IMONLOKI_LOADING_TOKEN);
  }
}

async function addLoki(scene) {
  loadingManager.itemStart(LOKI_LOADING_TOKEN);
  try {
    const { scene: loki } = await loadModel('/models/LOKI.glb');
    loki.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    scene.add(loki);
    addImOnLoki(scene, loki.children[0]);
  } catch (err) {
    console.error('[loki] failed to load LOKI.glb:', err);
  } finally {
    loadingManager.itemEnd(LOKI_LOADING_TOKEN);
  }
}

async function addBackgroundBuilding(scene) {
  try {
    const { scene: bg } = await loadModel('/models/BG_BUILDING.glb');
    bg.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      unlit.polygonOffset = true;
      unlit.polygonOffsetFactor = 1;
      unlit.polygonOffsetUnits = 1;
      rawMat.dispose();
      obj.material = unlit;
      obj.castShadow = true;
      obj.receiveShadow = false;
    });
    scene.add(bg);
  } catch (err) {
    console.error('[bg building] failed to load BG_BUILDING.glb:', err);
  }
}

// See the call site above for the full writeup - straight texture swap on
// the existing "Object1783_2" node, using the real re-bake you exported
// (COVER_SUPPLY_SIGN.glb) instead of the wrong cross-panel guess this used
// to do. Runs AFTER the main traverse loop above, so it overwrites whatever
// that pass already did to this node's material (it'll have gone through
// toUnlitFlat already, same as everything else not in the lit-exception
// list - fine, this replaces the map wholesale either way).
async function addCoverSupplySignSwap(street) {
  try {
    const target = street.getObjectByName('Object1783_2');
    if (!target || !target.isMesh) {
      console.warn('[cover supply sign] Object1783_2 not found in TRY4_SCENE - skipping');
      return;
    }

    const { scene: signScene } = await loadModel('/models/COVER_SUPPLY_SIGN.glb');
    const newMesh = signScene.children.find((c) => c.isMesh) ?? signScene;
    if (!newMesh || !newMesh.isMesh || !newMesh.material) {
      console.warn('[cover supply sign] no usable mesh/material in COVER_SUPPLY_SIGN.glb - skipping');
      return;
    }
    const newTexture = Array.isArray(newMesh.material) ? newMesh.material[0]?.map : newMesh.material.map;
    if (!newTexture) {
      console.warn('[cover supply sign] new export has no base color texture - skipping');
      return;
    }

    // Real alpha cutout this time (checked directly: ~76% fully
    // transparent, ~23% fully opaque, almost no soft partial-alpha pixels)
    // - the old texture on this node had no alpha at all, so the material
    // was never set up for transparency. BLEND (not MASK) to keep the thin
    // anti-aliased edge that IS present, same choice as the record-store
    // window glass elsewhere in this file.
    const oldMaterials = Array.isArray(target.material) ? target.material : [target.material];
    for (const m of oldMaterials) m?.dispose();

    const newMat = new THREE.MeshBasicMaterial({
      map: newTexture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    newMat.polygonOffset = true;
    newMat.polygonOffsetFactor = 1;
    newMat.polygonOffsetUnits = 1;
    target.material = newMat;
    target.receiveShadow = false;
  } catch (err) {
    console.error('[cover supply sign] failed to load COVER_SUPPLY_SIGN.glb:', err);
  }
}

// Two-crate rebake - geometry AND material swap onto the matching existing
// nodes (unlike the sign above, which only needed a texture swap - these
// came with genuinely new geometry too, checked directly: 572/578 verts vs
// whatever the old versions had, not worth diffing exactly since the whole
// point is replacing them). Goes through the same lit/unlit decision as
// the main traverse loop above (LIT_EXCEPTION_MATERIAL_NAMES check ->
// toUnlitFlat if not excepted) so a rebake dropped in later doesn't
// silently skip that pipeline.
const CRATE_REBAKE_NODE_NAMES = ['B_Daily_R_VR_N_JP_Basket_0003', 'B_Daily_R_VR_N_JP_Basket_0004'];

async function addCratesRebake(street) {
  try {
    const { scene: rebake } = await loadModel('/models/CRATES_REBAKE.glb');

    for (const name of CRATE_REBAKE_NODE_NAMES) {
      const target = street.getObjectByName(name);
      if (!target || !target.isMesh) {
        console.warn(`[crates rebake] ${name} not found in TRY4_SCENE - skipping`);
        continue;
      }
      // BUG (first pass): was matching by comparing material NAMES between
      // the target and the new meshes - but by the time this runs, the
      // main traverse loop above has already run target's material through
      // toUnlitFlat, which builds a fresh MeshBasicMaterial and never
      // copies .name over. So target's material name was always '', never
      // matched anything, and both crates silently got skipped ("no
      // matching new mesh" warnings nobody saw because nothing logs to the
      // page). CRATES_REBAKE.glb uses the exact same NODE names as
      // TRY4_SCENE.glb though (confirmed directly), so just look the new
      // mesh up by that instead - no material-name round-trip needed.
      const newMesh = rebake.getObjectByName(name);
      if (!newMesh || !newMesh.isMesh) {
        console.warn(`[crates rebake] no matching new mesh for ${name} - skipping`);
        continue;
      }

      target.geometry.dispose();
      target.geometry = newMesh.geometry;

      const oldMaterials = Array.isArray(target.material) ? target.material : [target.material];
      for (const m of oldMaterials) m?.dispose();

      const rawMat = Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material;
      if (LIT_EXCEPTION_MATERIAL_NAMES.has(rawMat.name)) {
        target.material = rawMat;
        target.receiveShadow = true;
      } else {
        const unlit = toUnlitFlat(rawMat);
        unlit.polygonOffset = true;
        unlit.polygonOffsetFactor = 1;
        unlit.polygonOffsetUnits = 1;
        rawMat.dispose();
        target.material = unlit;
        target.receiveShadow = false;
      }
      target.castShadow = true;
    }
  } catch (err) {
    console.error('[crates rebake] failed to load CRATES_REBAKE.glb:', err);
  }
}

// Glass outer building - single node/material swap (see call site above for
// the identity check). One wrinkle: the new material's baseColorTexture
// ("glass building bake") has real alpha data - checked directly, not
// assumed: 82% fully opaque, 18% fully transparent, ~0.3% partial, i.e. a
// genuine window/glass cutout, not noise. But the glTF material has no
// alphaMode set at all, which means GLTFLoader parses it as the spec
// default (OPAQUE) and ignores that alpha channel entirely - toUnlitFlat
// would carry that OPAQUE-ness straight through and the windows would
// render solid. This isn't the "freestyling transparency" mistake from
// earlier in this project (manually inventing an opacity number) - it's
// the opposite: forcing transparent:true here is what actually RESPECTS
// the real alpha data that's already baked in, correcting an export flag
// that didn't get set, same class of issue as the eyelash/eyebrow alpha
// bug in shading.js.
const GLASS_BUILDING_NODE_NAME = 'Box1801';

async function addGlassBuildingSwap(street) {
  try {
    const target = street.getObjectByName(GLASS_BUILDING_NODE_NAME);
    if (!target || !target.isMesh) {
      console.warn(`[glass building] ${GLASS_BUILDING_NODE_NAME} not found in TRY4_SCENE - skipping`);
      return;
    }
    const { scene: rebake } = await loadModel('/models/GLASS_BUILDING_REBAKE.glb');
    const newMesh = rebake.getObjectByName(GLASS_BUILDING_NODE_NAME);
    if (!newMesh || !newMesh.isMesh) {
      console.warn('[glass building] no matching mesh in GLASS_BUILDING_REBAKE.glb - skipping');
      return;
    }

    target.geometry.dispose();
    target.geometry = newMesh.geometry;
    const rawMat = Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material;
    rawMat.transparent = true; // see the note above - correcting a missing alphaMode, not inventing a value
    applyRebakeMaterial(target, rawMat);
    target.castShadow = true;
  } catch (err) {
    console.error('[glass building] failed to load GLASS_BUILDING_REBAKE.glb:', err);
  }
}

// Signed building's window facade - swap the baked gold-emissive glass for
// a plain dark reflective glass, per your call. No new GLB/rebake here,
// just a material built in code and dropped onto the one confirmed node
// (see call site comment above for the identity check). Kept as a real
// PBR MeshStandardMaterial (picks up scene.environment reflections, same
// as the other lit-exception materials) rather than converting through
// toUnlitFlat, since a flat baked color can't read as "glass" - reflections
// are what sell that. Skipped MeshPhysicalMaterial's transmission (true
// see-through glass) on purpose - it needs its own render pass/render
// target under the hood, real GPU cost for a look that reads almost
// identically to a dark low-roughness reflective surface at night anyway.
const ALLWINDOWS_NODE_NAME = 'ALLWINDOWS';

function addBlackGlassWindows(street) {
  const target = street.getObjectByName(ALLWINDOWS_NODE_NAME);
  if (!target || !target.isMesh) {
    console.warn(`[black glass windows] ${ALLWINDOWS_NODE_NAME} not found in TRY4_SCENE - skipping`);
    return;
  }
  const oldMaterials = Array.isArray(target.material) ? target.material : [target.material];
  for (const m of oldMaterials) m?.dispose();

  target.material = new THREE.MeshStandardMaterial({
    color: 0x07070a,
    roughness: 0.18,
    metalness: 0.5,
    envMapIntensity: 1.2,
    side: THREE.DoubleSide, // original material was doubleSided too
  });
  target.receiveShadow = true;
  target.castShadow = true;
}

// Thrift store clothing rebake (THRIFT_REBAKE.glb, "rebaked the clothes in
// the thrift store") - two different matching patterns in one upload, found
// by checking directly rather than assuming names carried over 1:1 (same
// lesson as the crates rebake's Blender-suffix surprise):
//
//  - Most items (the shoe pile - Blackclay/Blackclay 1/Blackclay 2/
//    Brazil kkr/Glogang clog/Mirror/moon foot clog/Steakslide/Yb kkr, plus 5
//    of the 6 ZBrushPolyMesh3D047 variants) kept their exact node names and
//    are single-mesh single-material nodes - straightforward geometry+
//    material swap onto the matching existing node, same pattern as the
//    crates rebake above.
//
//  - Three groups (A_Ch_NewFemale_Lo_ShortsD_010, E_F7M_Lo_suShorts_AD008,
//    ZBrushPolyMesh3D059) are different: in TRY4_SCENE.glb these are single
//    merged multi-primitive meshes (10/6/2 materials each - one clothing
//    rack/pile represented as one draw call, GLTFLoader turns a multi-
//    primitive glTF mesh into a Group of child Meshes, not a material
//    array). In the rebake, the SAME materials come back split into
//    separate single-material nodes instead - confirmed by world position,
//    not assumed: every split node for a given group sits at the exact same
//    spot as the one merged node it came from, and the material names match
//    individual primitives already inside that merged mesh. This isn't new
//    content, it's the same rack re-baked but exported unmerged - so
//    instead of a node-level swap, this matches by each child's ORIGINAL
//    material name (obj.userData.origMaterialNames, captured in the main
//    traverse loop above - can't read it off obj.material.name directly,
//    toUnlitFlat already replaced that material and doesn't copy .name,
//    same bug class as the crates rebake's first pass) and swaps only the
//    matching primitives, leaving the merged-mesh draw-call optimization
//    intact. Falls back to a Blender-suffix-stripped name match
//    (Material_#1111225198 vs Material_#1111225198.001) if the exact name
//    doesn't hit, since a partial re-export can trigger Blender's own
//    duplicate-name renumbering the same way node names did.
//
//  - Not every primitive in those 3 groups got re-baked this round either -
//    e.g. E_F7M_Lo_suShorts_AD008 has 6 materials, only 3 came back in this
//    upload. Only swaps what actually matched; anything else stays as-is,
//    same "partial rebake" pattern as the clothing/shoe store history.
const THRIFT_SIMPLE_SWAP_NODE_NAMES = [
  'Blackclay', 'Blackclay 1', 'Blackclay 2', 'Brazil kkr',
  'Glogang clog', 'Mirror', 'moon foot clog', 'Steakslide', 'Yb kkr',
  'ZBrushPolyMesh3D047.001', 'ZBrushPolyMesh3D047.002', 'ZBrushPolyMesh3D047.003',
  'ZBrushPolyMesh3D047.004', 'ZBrushPolyMesh3D047.006',
];

const THRIFT_MATERIAL_SWAP_GROUP_NAMES = [
  'A_Ch_NewFemale_Lo_ShortsD_010',
  'E_F7M_Lo_suShorts_AD008',
  'ZBrushPolyMesh3D059',
];

function stripBlenderSuffix(name) {
  return name ? name.replace(/\.\d+$/, '') : name;
}

// THIS is the actual bug behind the vinyl store rebake reading as a total
// no-op - found by finally running the real GLTFLoader/DRACOLoader against
// both files in Node instead of just parsing the raw glTF JSON myself, and
// diffing what object.name actually comes out as. Three.js's GLTFLoader
// runs EVERY node/mesh/camera/light name through
// PropertyBinding.sanitizeNodeName() unconditionally (see
// createUniqueName() in GLTFLoader.js) - it strips '.', '[', ']', ':', '/'
// entirely and turns whitespace into '_', because those characters are
// reserved separators in its animation track-path syntax. It doesn't
// matter whether the file has any animations - this runs on every load.
// So 'RecordPlayer_Cube.070' is never actually a name you can look up at
// runtime - the live scene graph has 'RecordPlayer_Cube070' instead. Every
// getObjectByName() call in this file (and vinylInteraction.js's
// RECORD_PLAYER_NODE_NAME) needs to search for the SANITIZED name, not the
// raw glTF JSON name straight off a file inspection - confirmed directly by
// loading both files through the real loader and printing actual .name
// values, not assumed from this rule alone.
function sanitizeGltfName(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

function applyRebakeMaterial(targetMesh, rawMat) {
  const oldMaterials = Array.isArray(targetMesh.material) ? targetMesh.material : [targetMesh.material];
  for (const m of oldMaterials) m?.dispose();
  if (LIT_EXCEPTION_MATERIAL_NAMES.has(rawMat.name)) {
    targetMesh.material = rawMat;
    targetMesh.receiveShadow = true;
  } else {
    const unlit = toUnlitFlat(rawMat);
    unlit.polygonOffset = true;
    unlit.polygonOffsetFactor = 1;
    unlit.polygonOffsetUnits = 1;
    rawMat.dispose();
    targetMesh.material = unlit;
    targetMesh.receiveShadow = false;
  }
}

async function addThriftRebake(street) {
  try {
    const { scene: rebake } = await loadModel('/models/THRIFT_REBAKE.glb');

    // simple 1:1 node swaps - same pattern as addCratesRebake above
    for (const name of THRIFT_SIMPLE_SWAP_NODE_NAMES) {
      const target = street.getObjectByName(name);
      const newMesh = rebake.getObjectByName(name);
      if (!target || !target.isMesh || !newMesh || !newMesh.isMesh) {
        console.warn(`[thrift rebake] simple swap skipped for ${name} - not found in one of the two files`);
        continue;
      }
      target.geometry.dispose();
      target.geometry = newMesh.geometry;
      const rawMat = Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material;
      applyRebakeMaterial(target, rawMat);
      target.castShadow = true;
    }

    // Lookup of the rebake's individual single-material nodes, keyed by
    // material name - exact first, Blender-suffix-stripped as a fallback.
    const rebakeByExactMat = new Map();
    const rebakeByBaseMat = new Map();
    rebake.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      if (!mat?.name) return;
      rebakeByExactMat.set(mat.name, obj);
      const base = stripBlenderSuffix(mat.name);
      if (!rebakeByBaseMat.has(base)) rebakeByBaseMat.set(base, obj);
    });

    for (const groupName of THRIFT_MATERIAL_SWAP_GROUP_NAMES) {
      const group = street.getObjectByName(groupName);
      if (!group) {
        console.warn(`[thrift rebake] group ${groupName} not found in TRY4_SCENE - skipping`);
        continue;
      }
      const children = group.isMesh ? [group] : group.children.filter((c) => c.isMesh);
      let swapped = 0;
      for (const child of children) {
        const origName = child.userData.origMaterialNames?.[0];
        if (!origName) continue;
        const newMesh = rebakeByExactMat.get(origName) ?? rebakeByBaseMat.get(stripBlenderSuffix(origName));
        if (!newMesh) continue; // this primitive wasn't part of this rebake - leave as-is

        child.geometry.dispose();
        child.geometry = newMesh.geometry;
        const rawMat = Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material;
        applyRebakeMaterial(child, rawMat);
        child.castShadow = true;
        swapped++;
      }
      console.log(`[thrift rebake] ${groupName}: swapped ${swapped}/${children.length} primitives`);
    }
  } catch (err) {
    console.error('[thrift rebake] failed to load THRIFT_REBAKE.glb:', err);
  }
}

// Full vinyl/record store room rebake (vinylstorewithbakes.glb, "new vinyl
// store bakes") - a complete re-export of the whole room, 58 nodes covering
// everything in there: bookshelves, cabinets, boxes, crates, the counter,
// the door/walls/windows, the vinyl shelf/wall, the record player, and the
// souvenir sticker boxes. Raw upload was 423.2MB (422.6MB of it images,
// several 4096px normal/roughness/metallic maps that toUnlitFlat never
// even reads since this room goes through the same baked/unlit pipeline as
// everything else) - same 1536px cap treatment as the other rebakes, JPEG-
// q80 for opaque maps / PNG for the ones with real alpha (checked per-image,
// not assumed), landing at 12.5MB.
//
// Checked node-by-node against TRY4_SCENE.glb rather than assumed, same
// discipline as every other rebake here: 54 of the 58 nodes matched an
// existing TRY4 node by exact name (full list below) - confirmed via a full
// transform-hierarchy walk that every one of those 54 lands at the same
// world position in both files, so straight geometry+material swaps onto
// the matching existing nodes, same pattern as addCratesRebake/
// addThriftRebake above. This includes every record-store node the vinyl
// interaction feature already depends on - RecordPlayer_Cube.070,
// RecordStoreDoor_Cube, RecordStoreWalls_Cube.005, RecordStoreWindows_Cube.015,
// VinylShelf_Cube.001/.180, VinylWall_Cylinder.023, Stickersbox02_Cube.099 -
// so vinylInteraction.js's street.getObjectByName('RecordPlayer_Cube.070')
// lookup keeps working after this: the node itself isn't touched, only its
// geometry/material get replaced, same as every prior rebake swap.
//
// The other 3 (RecordPlayer_Cube.001, Stickersbox02_Cube.001,
// Stickersbox02_Cube.002) don't match anything in TRY4 by name, and
// Blender-suffix-stripping them lands on RecordPlayer_Cube.070 and
// Stickersbox02_Cube.099 respectively - but those two already have their
// own exact-name match above, so they're not the same slot. Checked what
// these 3 actually are before deciding what to do with them, not guessed:
//  - RecordPlayer_Cube.001's mesh bounding box overlaps but doesn't match
//    RecordPlayer_Cube.070's (070 is a much higher-poly merged mesh
//    spanning a taller volume - looks like the player plus its stand/table
//    merged into one draw call this round; 001 is a smaller sub-volume
//    inside that same footprint) - reads as a second, smaller electronics
//    piece (same EletronicsMaterial.002, same alphaMode BLEND), not a
//    leftover duplicate of 070.
//  - Stickersbox02_Cube.099 in TRY4 was one big merged mesh (souvenirs +
//    vinyl materials in one draw call, wide bounding box spanning most of
//    the shelf). The rebake's .001 and .002 are two much smaller boxes at
//    two DIFFERENT specific spots within that footprint (SouvenirsMaterial
//    and VynilMaterial respectively) - reads as the artist splitting that
//    one merged shelf mesh into individually-placed sticker boxes this
//    round, not duplicating .099.
// All 5 of these nodes (070/099 plus the 3 new ones) share the exact same
// local translation/rotation/scale in the rebake file - confirmed directly
// off the node JSON, not assumed - meaning the vertex data itself carries
// the real per-object position (same baked-local-space export as the rest
// of this room), not the node transform. So the 3 new ones get ADDED as
// plain sibling meshes next to their nearest same-slot existing node
// (RecordPlayer_Cube.070's parent / Stickersbox02_Cube.099's parent),
// copying that existing node's local position/quaternion/scale - same
// transform, correct spot, no guessing needed. If any of these three read
// as an unwanted duplicate once you can actually see them in place, they're
// easy to spot and pull - each is added as its own separate Mesh, nothing
// gets merged into 070/099's geometry.
const VINYL_STORE_SIMPLE_SWAP_NODE_NAMES = [
  'Bookshelf01_Cube.001', 'Bookshelf01_Cube.002', 'Bookshelf01_Cube.003', 'Bookshelf01_Cube.176',
  'Bookshelf02_Cube.001', 'Bookshelf02_Cube.002', 'Bookshelf02_Cube.003', 'Bookshelf02_Cube.179',
  'Box01_Cube.072', 'Box02_Cube.071', 'Box03_Cube.068', 'Box04_Cube.059', 'Box05_Cube.017',
  'Cabinet01_Cube.001', 'Cabinet01_Cube.002', 'Cabinet01_Cube.157',
  'Cabinet02_Cube.001', 'Cabinet02_Cube.002', 'Cabinet02_Cube.158',
  'Cabinet03_Cube.002', 'Cabinet03_Cube.159',
  'Cabinet04_Cube.001', 'Cabinet04_Cube.002', 'Cabinet04_Cube.157',
  'Cabinet05_Cube.001', 'Cabinet05_Cube.002', 'Cabinet05_Cube.158',
  'Cabinet06_Cube.001', 'Cabinet06_Cube.002', 'Cabinet06_Cube.157',
  'Cabinet07_Cube.001', 'Cabinet07_Cube.002', 'Cabinet07_Cube.159',
  'Counter_Cube.170', 'Plane.001',
  'PlasticCrate01_Cube.001', 'PlasticCrate01_Cube.056',
  'PlasticCrate02_Cube.001', 'PlasticCrate02_Cube.057',
  'PlasticCrate03_Cube.001', 'PlasticCrate03_Cube.058',
  'PlasticCrate04_Cube.001', 'PlasticCrate04_Cube.012',
  'PlasticCrate05_Cube.001', 'PlasticCrate05_Cube.013',
  'PlasticCrate06_Cube.057',
  'RecordPlayer_Cube.070', 'RecordStoreDoor_Cube', 'RecordStoreWalls_Cube.005',
  'RecordStoreWindows_Cube.015', 'Stickersbox02_Cube.099',
  'VinylShelf_Cube.001', 'VinylShelf_Cube.180', 'VinylWall_Cylinder.023',
];

// The 3 additive nodes - each paired with the existing TRY4 node whose
// local transform they should copy (see the writeup above for why).
const VINYL_STORE_ADD_NODES = [
  { newName: 'RecordPlayer_Cube.001', transformFrom: 'RecordPlayer_Cube.070' },
  { newName: 'Stickersbox02_Cube.001', transformFrom: 'Stickersbox02_Cube.099' },
  { newName: 'Stickersbox02_Cube.002', transformFrom: 'Stickersbox02_Cube.099' },
];

// Builds a fresh standalone Mesh from a rebake primitive's raw geometry +
// material, going through the same lit-exception/toUnlitFlat/polygonOffset
// treatment as applyRebakeMaterial - used where there's no existing target
// mesh to mutate in place (the additive nodes below, and the multi-
// primitive rebuild nodes further down).
function buildRebakeMesh(rawGeometry, rawMat) {
  const isException = LIT_EXCEPTION_MATERIAL_NAMES.has(rawMat.name);
  const mat = isException ? rawMat : toUnlitFlat(rawMat);
  if (!isException) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    rawMat.dispose();
  }
  const mesh = new THREE.Mesh(rawGeometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = isException;
  return mesh;
}

// 3 of the "simple swap" names above are lying about being simple - checked
// directly (same discipline as everything else here): TRY4_SCENE.glb's mesh
// for these 3 nodes has 2 primitives, not 1, which means GLTFLoader builds
// a GROUP for that node (one child Mesh per primitive), not a Mesh - so
// target.isMesh is false and the loop above silently skips them via its own
// warning. This wasn't obvious from the node/material inspection earlier in
// this feature's build (that only checked node names + world position, not
// primitive count) - found by actually testing target.isMesh, not assumed.
// RecordPlayer_Cube.070 is the same node vinylInteraction.js's bindTarget
// looks up with an identical isMesh check - meaning the click-to-lock
// feature has likely never actually bound a target at all, independent of
// this rebake (that bug predates this upload, just never surfaced since
// nothing before this exercised the isMesh check on this specific node).
// This fix resolves both: after this runs, RecordPlayer_Cube.070 is a real
// Mesh again.
//
// The rebake's own version of these 3 doesn't necessarily have the same
// primitive count either (checked, not assumed): RecordPlayer_Cube.070 and
// Stickersbox02_Cube.099 came back as ONE merged primitive each in the
// rebake (their old second material - VynilMaterial.002 in both cases -
// isn't part of either merged mesh anymore, i.e. genuinely dropped/merged
// away this round, not lost by this code), while PlasticCrate06_Cube.057
// kept the same 2 materials (BoxMaterial.002, VynilMaterial.002) split the
// same way. Rather than trying to preserve the old Group/multi-primitive
// structure, this replaces the whole node - old Group (and its child
// meshes/materials) removed and disposed, a fresh Mesh (or Group of Meshes,
// for the still-multi-material crate) built from whatever the rebake
// actually contains, added back under the same parent at the same name so
// anything that looks this node up by name (vinylInteraction.js included)
// keeps working.
const VINYL_STORE_MULTI_PRIMITIVE_REPLACE_NAMES = [
  'PlasticCrate06_Cube.057', 'RecordPlayer_Cube.070', 'Stickersbox02_Cube.099',
];

function replaceMultiPrimitiveNode(street, rebake, name) {
  const lookupName = sanitizeGltfName(name);
  const target = street.getObjectByName(lookupName);
  const newSource = rebake.getObjectByName(lookupName);
  if (!target || !newSource) {
    console.warn(`[vinyl store rebake] multi-primitive replace skipped for ${name} - not found in one of the two files`);
    return false;
  }
  const parent = target.parent;
  if (!parent) {
    console.warn(`[vinyl store rebake] ${name} has no parent - skipping replace`);
    return false;
  }

  // Dispose whatever's currently there - a lone Mesh (shouldn't happen for
  // these 3 given the primitive-count check above, but handled anyway) or
  // the multi-child Group GLTFLoader actually builds for them.
  const oldMeshes = target.isMesh ? [target] : target.children.filter((c) => c.isMesh);
  for (const m of oldMeshes) {
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat?.dispose();
  }

  // Build the replacement to match whatever shape the rebake actually has -
  // a single Mesh if it merged down to one primitive, a Group of Meshes if
  // it's still split across materials.
  const newPrimitives = newSource.isMesh ? [newSource] : newSource.children.filter((c) => c.isMesh);
  let replacement;
  if (newPrimitives.length === 1) {
    const src = newPrimitives[0];
    const rawMat = Array.isArray(src.material) ? src.material[0] : src.material;
    replacement = buildRebakeMesh(src.geometry, rawMat);
  } else {
    replacement = new THREE.Group();
    for (const src of newPrimitives) {
      const rawMat = Array.isArray(src.material) ? src.material[0] : src.material;
      replacement.add(buildRebakeMesh(src.geometry, rawMat));
    }
  }
  replacement.name = lookupName; // sanitized, matching what GLTFLoader would have assigned
  replacement.position.copy(target.position);
  replacement.quaternion.copy(target.quaternion);
  replacement.scale.copy(target.scale);

  parent.remove(target);
  parent.add(replacement);
  return true;
}

// A couple of materials in this upload have emissiveFactor/emissiveTexture
// set to the exact same image as their base color - checked directly, not
// guessed: Material.001 (used only by Plane.001 - reads like a flat poster/
// decal, not a light fixture) has emissiveFactor [0.5,0.5,0.5] pointing at
// the SAME "BakedTexture_Music" image as its base color. That's the classic
// Blender "plug the bake into Emission too so it renders full-bright
// regardless of scene lighting" trick, not an intentional "this should
// flicker like an LED sign" mark - but toUnlitFlat's hasEmissive check
// can't tell those two intents apart from the glTF data alone, so it was
// putting the same animated flicker on this poster as every actual sign.
// EletronicsMaterial.002 (the record player) also carries real emissive -
// originally left flickering since it read like an intentional lit panel/
// screen, but per your call it should just stay static too. Both stripped
// by name here, scoped to just this rebake's own material list, rather
// than touching toUnlitFlat/applyRebakeMaterial globally - these are
// generic-enough Blender auto-names that blanket-excluding them across
// every other rebake in this file isn't safe.
const VINYL_STORE_NO_FLICKER_MATERIAL_NAMES = new Set(['Material.001', 'EletronicsMaterial.002']);

function stripUnwantedFlicker(rawMat) {
  if (!VINYL_STORE_NO_FLICKER_MATERIAL_NAMES.has(rawMat.name)) return rawMat;
  rawMat.emissiveMap = null;
  if (rawMat.emissive) rawMat.emissive.setRGB(0, 0, 0);
  return rawMat;
}

// On-screen diagnostic, NOT console-only - main.js's debug-pos HUD (already
// visible on screen in walk mode, see updatePositionDebug there) appends
// streetSceneStatus.detail as-is, so folding these counts into that string
// means they show up in a plain screenshot of the game itself. Added after
// this rebake turned out hard to debug blind - counts are more useful than
// a pass/fail boolean here since a partial failure (some nodes ok, some
// not) still needs distinguishing from "the whole file never loaded."
export const vinylRebakeStatus = { simpleOk: 0, simpleSkipped: 0, multiOk: 0, multiFailed: 0, addOk: 0, addFailed: 0, loadError: null };

async function addVinylStoreRebake(street) {
  try {
    const { scene: rebake } = await loadModel('/models/VINYL_STORE_REBAKE.glb');

    // simple 1:1 node swaps - same pattern as addCratesRebake/addThriftRebake.
    // Each iteration is its own try/catch now - one unexpected failure
    // shouldn't be able to silently take the rest of the batch down with it
    // (this is also just a general hardening, not only about the 3 nodes
    // below - those get skipped by the isMesh check, not a thrown error).
    for (const name of VINYL_STORE_SIMPLE_SWAP_NODE_NAMES) {
      try {
        const lookupName = sanitizeGltfName(name);
        const target = street.getObjectByName(lookupName);
        const newMesh = rebake.getObjectByName(lookupName);
        if (!target || !target.isMesh || !newMesh || !newMesh.isMesh) {
          console.warn(`[vinyl store rebake] simple swap skipped for ${name} - not found as a single mesh in one of the two files`);
          vinylRebakeStatus.simpleSkipped++;
          continue;
        }
        target.geometry.dispose();
        target.geometry = newMesh.geometry;
        const rawMat = stripUnwantedFlicker(Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material);
        applyRebakeMaterial(target, rawMat);
        target.castShadow = true;
        vinylRebakeStatus.simpleOk++;
      } catch (err) {
        console.error(`[vinyl store rebake] simple swap threw for ${name}:`, err);
        vinylRebakeStatus.simpleSkipped++;
      }
    }

    // the 3 multi-primitive nodes - see the writeup above.
    for (const name of VINYL_STORE_MULTI_PRIMITIVE_REPLACE_NAMES) {
      try {
        const ok = replaceMultiPrimitiveNode(street, rebake, name);
        if (ok) vinylRebakeStatus.multiOk++;
        else vinylRebakeStatus.multiFailed++;
      } catch (err) {
        console.error(`[vinyl store rebake] multi-primitive replace threw for ${name}:`, err);
        vinylRebakeStatus.multiFailed++;
      }
    }

    // additive nodes - genuinely new geometry (see writeup above), added as
    // siblings of their nearest same-slot node, copying that node's local
    // transform so they land in the right spot without guessing a position.
    // transformFrom now resolves correctly even after the multi-primitive
    // replace above, since that replace keeps the same name on the new
    // node/Group it installs.
    for (const { newName, transformFrom } of VINYL_STORE_ADD_NODES) {
      try {
        const lookupNewName = sanitizeGltfName(newName);
        const newMesh = rebake.getObjectByName(lookupNewName);
        const anchor = street.getObjectByName(sanitizeGltfName(transformFrom));
        if (!newMesh || !newMesh.isMesh || !anchor || !anchor.parent) {
          console.warn(`[vinyl store rebake] additive node skipped for ${newName} - source or anchor not found`);
          vinylRebakeStatus.addFailed++;
          continue;
        }
        const rawMat = stripUnwantedFlicker(Array.isArray(newMesh.material) ? newMesh.material[0] : newMesh.material);
        const addedMesh = buildRebakeMesh(newMesh.geometry, rawMat);
        addedMesh.name = lookupNewName;
        addedMesh.position.copy(anchor.position);
        addedMesh.quaternion.copy(anchor.quaternion);
        addedMesh.scale.copy(anchor.scale);
        anchor.parent.add(addedMesh);
        vinylRebakeStatus.addOk++;
      } catch (err) {
        console.error(`[vinyl store rebake] additive node threw for ${newName}:`, err);
        vinylRebakeStatus.addFailed++;
      }
    }
  } catch (err) {
    console.error('[vinyl store rebake] failed to load VINYL_STORE_REBAKE.glb:', err);
    vinylRebakeStatus.loadError = String(err?.message ?? err);
  }
}

// Fake bulb-glow sprite hack removed. It existed because MeshBasicMaterial
// (what toUnlitFlat produces) has no native emissive concept, and this
// project was only flattening 3 hand-picked light-fixture materials to
// unlit - so a fake additive sprite, hand-positioned per material, was the
// cheapest way to get a glow back on that one lamp.
//
// Two things changed that make it not just unnecessary now but actively
// wrong: (1) toUnlitFlat itself already injects real emissive (map + color
// + KHR_materials_emissive_strength) into the compiled MeshBasicMaterial
// shader (see shading.js - this was already true, just wasn't being relied
// on broadly), and (2) with the bake-by-default flip above, basically every
// emissive material in the scene now goes through toUnlitFlat, so that
// injected emissive is doing the job everywhere automatically - no more
// hand-picking positions.
// The sprite hack was also the likely cause of the "floating glow orb"
// bugs you flagged after TRY2_SCENE went in - it positioned itself via
// obj.getWorldPosition(), which reads a MESH NODE's own transform origin,
// not the geometry's center. TRY2_SCENE merges meshes by material, so a
// node matching one of those 3 material names could now represent a much
// bigger/different chunk of merged geometry than the single small lamp part
// it used to be in FURNISHEDSCENE915.glb - same material name, different
// mesh identity, wrong single point to hang a sprite off of. Real per-pixel
// emissive (via the shader injection) doesn't have this problem at all,
// since it's not trying to represent a whole fixture as one point.
