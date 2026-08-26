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

// "doesn't run on mobile / crashes or freezes the browser" - traced to raw
// texture VRAM, not file size or geometry: TRY7_SCENE.glb alone decodes to
// ~1GB of GPU memory (256 textures, several at 2048-3072px), plus another
// ~100MB across the standalone models (RECORD_DISC.glb's 3 textures were
// 2048px each for a small spinning disc - 48MB on their own). Desktop GPUs
// shrug that off; mobile WebGL (especially iOS Safari) commonly caps out
// around 256-512MB before the tab just dies. Built matching *_MOBILE.glb
// variants (public/models/mobile/) with every texture capped at 512px -
// cuts the same four files down to ~260MB combined, well inside a safe
// mobile budget, with no visible quality loss at the scale a phone screen
// actually renders this at. Same isMobile media-query controls.js already
// uses for touch-vs-mouse input - duplicated here (not imported from
// Controls) since this module needs it before any Controls instance
// exists.
const IS_MOBILE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
function modelPath(desktopPath, hasMobileVariant = true) {
  if (!IS_MOBILE || !hasMobileVariant) return desktopPath;
  const filename = desktopPath.split('/').pop().replace(/\.glb$/i, '_MOBILE.glb');
  return `/models/mobile/${filename}`;
}

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
  // "i want this to fade to black not grey" - the fog was already pure black
  // (see scene.fog below), so the grey haze the buildings dissolved into was
  // never the fog, it was THIS backdrop showing through: the horizon stop sat
  // at #4a4555, a light greyish-purple, so anything fogged out to nothing
  // still landed on grey. Whole ramp is black now, top and horizon, which
  // makes the backdrop agree with the black fog instead of fighting it.
  // Keeping the gradient (rather than swapping in a flat Color) so the stops
  // stay here as one obvious knob if you ever want the tint back.
  gradient.addColorStop(0, '#000000');
  gradient.addColorStop(0.35, '#000000');
  gradient.addColorStop(1, '#000000');
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
  // "make the fog darker" - color's already pure black (0,0,0), can't go
  // darker than that, so this reads as DENSER instead: near/far pulled in
  // again (10/42 -> 7/32), same "steeper ramp to full opacity" move as the
  // 32->10/55->42 pull-in above, just a second pass in the same direction.
  // More of the street reads swallowed-black at a given distance now.
  scene.fog = new THREE.Fog(0x000000, 7, 32);
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
  // "get rid of my newest additions like side buildings and make it pure
  // black on mobile" - Plane.002 (street plane) and the two big tripo_node
  // buildings (see the mesh-strip on the mobile GLB itself, further below -
  // this isn't just a visibility toggle, their mesh/material/texture data
  // never gets decoded on mobile at all now) are gone on mobile, which would
  // leave a gap where they used to fill the frame - flat black instead of
  // the gradient backdrop covers that gap and matches "pure black" directly.
  scene.background = IS_MOBILE ? new THREE.Color(0x000000) : createSkyGradientTexture();

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
  addMe(scene);
  addBike(scene);
  addTiles(scene);
  addSigns(scene);
  addAlbumCovers(scene);
  addRecordDisc(scene);
  // addBackgroundBuilding(scene) - RETIRED as of TRY6_SCENE.glb: the
  // 920_WEB_OPTIMIZED_FINALSAVE_fullscene.glb upload merged that same mesh
  // directly into the main scene (node tripo_node_...001, loaded as part of
  // addStreetScene above already), so calling this too would add a second,
  // duplicate copy on top. Function itself deleted per "clear out all the
  // old and unused stuff" - it and the five per-room rebake overlays below
  // (see addStreetScene's history block) had all been sitting unused since
  // TRY5/TRY6, and BG_BUILDING.glb/COVER_SUPPLY_SIGN.glb/CRATES_REBAKE.glb/
  // GLASS_BUILDING_REBAKE.glb/THRIFT_REBAKE.glb/VINYL_STORE_REBAKE.glb don't
  // even exist in public/models/ anymore - calling any of them would just
  // 404. If a future export ever goes back to shipping one of these as a
  // standalone file, it's a small function to write fresh rather than worth
  // having kept dead code around for.

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
    // BUG + fix, same session: the first pass above patched images 227/228
    // - those numbers came from material.baseColorTexture.index, which is
    // a TEXTURE array index, not an image array index. This file's
    // texture[i].source != i for 291 of its 301 textures (no 1:1 identity
    // mapping, unlike LOKI.glb/IMONLOKI.glb's simpler single/1:1 texture
    // lists, which is why those two patched correctly on the first try).
    // Textures 227/228 actually point at images 201/202 - so the real
    // groundbake/BakedTexture_Music never got touched (you weren't seeing
    // the new sidewalk bakes because they were never applied), and two
    // unrelated materials (Material_3 "yb kkr baked", Material_#1111225164.005
    // "CHRISPATRICK BAKED") got the sidewalk images stamped onto them by
    // mistake instead. Fixed by resolving texture->image indirection
    // properly (material -> textures[bct.index] -> images[texture.source])
    // before touching any bufferView, restoring 227/228 from the commit
    // before this bug (git show <precommit>:public/models/TRY7_SCENE.glb),
    // and correctly patching 201/202 this time. Re-verified again after
    // the fix - same counts, all groups still matched.
    //
    // Second bug, same "side sidewalk" guess: you confirmed the sidewalks
    // still weren't showing even after a hard refresh, so I checked
    // Material.001/Plane.001's actual world geometry instead of trusting
    // the earlier filename-coincidence match - it's a small (4x0.9,
    // basically flat/2D) panel sitting ~3.4 units UP in the air, i.e. a
    // wall-mounted sign/poster, not a ground-level sidewalk at all. So
    // that "side sidewalk" identification was wrong from the start, and
    // the "fix" above had still been overwriting a real wall panel's
    // texture with sidewalk imagery. Reverted image 201 back to its
    // original ("BakedTexture_Music") from the same pre-bug commit used
    // above. Material.005/Plane.002 ("main pavement") checked out fine
    // geometrically (61x61 flat plane at y~0 - genuinely the ground) and
    // is left as the new bake. Still need the real side-sidewalk node
    // identified (debug-HUD coordinates, same method as the bike/wall-clip
    // fixes earlier) before that texture can go anywhere - not guessing a
    // third time.
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
    const { scene: street } = await loadModel(modelPath('/models/TRY7_SCENE.glb'));

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
        // swaps - the addThriftRebake function that used to rely on this
        // was deleted along with the other retired rebake overlays, but
        // userData.origMaterialNames itself stays populated here in case
        // anything else ever needs the same lookup) can't read it off
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

    // "the huge street plane has the wrong map, id rather it just be dark
    // grey" - Plane.002 (the ground-extension quad handled just above) is a
    // single 4-vertex quad scaled up ~30x in every axis, so its baked
    // texture (Material.005's baseColorTexture) stretches into unrecognizable
    // dark blotches at that size - almost certainly also what read as
    // "intersecting meshes" (the jagged dark shapes cutting across the
    // sidewalk/crosswalk) rather than any actual overlapping geometry.
    // Stripped the map and dropped in a flat dark grey instead, same idea as
    // the standalone ground plane's 0x030303 from the original "black ground
    // plane" pass, just lighter per "dark grey" this time.
    const groundExtension = street.getObjectByName(sanitizeGltfName('Plane.002'));
    if (groundExtension?.isMesh && groundExtension.material) {
      const mats = Array.isArray(groundExtension.material) ? groundExtension.material : [groundExtension.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.map = null;
        // "i want it darker like almost black" - 0x2a2a2a -> 0x0a0a0a. Not
        // fully black on purpose: the standalone fallback ground plane under
        // this sits at 0x030303, so pure black here would make the two
        // indistinguishable and you'd lose the edge where the street plane
        // ends. A few values above it keeps that separation readable while
        // still reading as black.
        mat.color.set(0x0a0a0a);
        mat.needsUpdate = true;
      }
    } else {
      console.warn('[ground extension] Plane.002 not found/no material - skipping grey-out');
    }

    // "that mesh i thought was a repeat is still clipping thru the sidewalk,
    // move it up, no clip at all even if tiny tiny gap" - the yellow tactile
    // paving strip. Not a duplicate mesh after all (that was the earlier
    // theory): it's three pieces sharing Material_#105_StandtoVR, all sitting
    // at y ~0.034-0.047, which is level with the sidewalk surface rather than
    // on top of it. Coplanar-ish geometry like that intersects and z-fights
    // instead of resting cleanly.
    // Nudging up in WORLD space, not touching node.scale - these nodes are
    // scaled ~0.0254, so editing local Y would need dividing by that scale to
    // mean anything, and it'd silently break if the export's scale ever
    // changes. Small enough to read as flush from eye level, large enough to
    // clear the depth buffer's precision at this distance.
    const TACTILE_STRIP_NODE_NAMES = ['Box1913', 'Box1924', 'Object1405100643'];
    const TACTILE_STRIP_LIFT = 0.015;
    for (const rawName of TACTILE_STRIP_NODE_NAMES) {
      const node = street.getObjectByName(sanitizeGltfName(rawName));
      if (node) {
        node.position.y += TACTILE_STRIP_LIFT;
      } else {
        console.warn(`[tactile strip] ${rawName} not found - skipping lift`);
      }
    }

    // "the building grey is way too light, i think the fog is only black at a
    // distance" - right on both counts. Fog is linear between near=7 and
    // far=32, so a surface sitting ~12-18 units out only picks up a fraction
    // of it; the big background buildings are close enough (and tall enough)
    // that most of their face reads at near-full material brightness. The fog
    // isn't the thing to change - pulling it in far enough to darken these
    // would also swallow the storefronts you actually want visible.
    // Darkening the buildings' own base colour instead: multiplyScalar keeps
    // whatever texture/shading detail is already baked in and just scales it
    // down, unlike .set() which would flatten them to a solid block. 0.35 is
    // the knob - lower is darker.
    const BG_BUILDING_NODE_NAMES = [
      'tripo_node_1b17d649-d3ad-4287-9088-27fc9b46c0de',
      'tripo_node_4bae5984-e7fd-4e13-b2cc-a0c2456c2ee1.001',
    ];
    // "far away mesh should blur to black not grey" - 0.35 -> 0.12.
    // These two are huge (one is ~51x37x67 units), so even though they read as
    // "far away" their near faces sit well inside the fog's 7->32 range and
    // only pick up partial fog. Partial fog over a mid-grey texture is exactly
    // the grey slab you're seeing. Fog can't fix it without pulling the whole
    // scene's draw distance in, so the buildings' own base colour comes down
    // instead - now near-black to start with, and whatever fog they do get
    // finishes the job. Lower = darker.
    const BG_BUILDING_DARKEN = 0.12;
    for (const rawName of BG_BUILDING_NODE_NAMES) {
      const node = street.getObjectByName(sanitizeGltfName(rawName));
      if (!node) {
        console.warn(`[bg building darken] ${rawName} not found - skipping`);
        continue;
      }
      node.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (!mat?.color) continue;
          mat.color.multiplyScalar(BG_BUILDING_DARKEN);
          mat.needsUpdate = true;
        }
      });
    }

    // "we have a missing sign mesh" - the blank panel next to the 3D
    // PRINTING sign turned out to be Object258 (confirmed by exact mesh
    // AND material name match - "Material_#12_1" - against a diagnostic
    // scan run against this exact file, not a guess). You sent a re-baked
    // standalone signs.glb with the real texture (Octarian Hangyodon +
    // AirPack, packed into the same combined atlas as the already-working
    // Love Potion/Shoes signs) - see addSigns() below. Permanently hidden
    // here (not layers.set(1) like TITLE_HIDDEN_NODE_NAMES above - this
    // one's just wrong in every mode, not mode-specific) so the new SIGNS
    // mesh doesn't render behind/through the old blank one.
    const oldSignNode = street.getObjectByName(sanitizeGltfName('Object258'));
    if (oldSignNode) {
      oldSignNode.visible = false;
    } else {
      console.warn('[missing sign] Object258 not found in TRY7_SCENE - skipping hide');
    }

    // Old vinyl record disc (Counter_Cube.001) - superseded by the
    // standalone RECORD_DISC.glb (see recordDiscRef/addRecordDisc below),
    // which has a correctly-centered origin baked in from the source file
    // instead of the runtime bounding-box recenter hack this one needed.
    // Nothing hides this automatically anymore since vinylInteraction's
    // bindTarget() was stripped down to stop touching it at all - it was
    // defaulting to visible and showing up as a second, misshapen,
    // non-spinning disc stacked on top of the real one. Permanently hidden
    // here, same as Object258 above.
    const oldDiscNode = street.getObjectByName(sanitizeGltfName('Counter_Cube.001'));
    if (oldDiscNode) {
      oldDiscNode.visible = false;
    } else {
      console.warn('[old disc] Counter_Cube.001 not found in TRY7_SCENE - skipping hide');
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

    // Five per-room rebake overlays used to run here (Cover Supply sign,
    // crates, glass building, thrift clothing, vinyl store - each a
    // standalone texture/geometry swap onto a specific TRY4_SCENE.glb
    // node). Disabled as of TRY5_SCENE.glb: that upload
    // (921_WEB_OPTIMIZED_FINALSAVE_allbaked.glb) already contained every
    // node these five targeted, under the same names/positions/materials,
    // already baked - re-applying the older separate rebake files on top
    // would have overwritten TRY5's own current bakes with stale ones.
    // Deleted outright now (functions + their /models/*.glb targets, which
    // don't exist on disk anymore either) per "clear out all the old and
    // unused stuff" - see addStreetScene's history above for the full
    // per-room detail if this era's rebake logic is ever needed as
    // reference again (git history has the original functions too).

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
// the loaded scene as-is - same trust-the-export pattern as every other
// standalone model in this file.
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

// imonloki.glb - RETIRED. "the origins were super crazy" (your words) -
// the old 10-node character group's own transforms didn't put it in the
// right spot, which is why addImOnLoki() used to reach over and manually
// copy Loki's position/quaternion onto it instead of trusting its own
// export, the one exception to this file's usual "trust the export"
// rule. Replaced by ME.glb below, split out of
// floortilescarandfinalbiemeglb.glb - "some new bakes pacled and proper
// geometry origins for the model of me" - a re-export where the character
// is back to being one correctly-origined node again, so it goes through
// the normal own-transform path like everything else now (see addMe()).
// IMONLOKI.glb itself deleted from public/models/ per "clear out all the
// old and unused stuff."

// floortilescarandfinalbiemeglb.glb - one combined re-export bundling
// three separate fixes in a single file: "the origins were super crazy.
// gonna send a new version with correct origins and a new bike bake and
// proper tiles, they werent packed" (message right before the upload),
// then "some new bakes pacled and proper geometry origins for the model
// of me" with the file itself. Split into three standalone glbs (ME.glb,
// BIKE.glb, TILES.glb) rather than wired in as one combined scene, since
// each piece already carries its own correct world transform and there's
// no reason to couple their load/error states together.
//
// Splitting method: the source is Draco-compressed
// (KHR_draco_mesh_compression, required) - rather than decoding/
// re-encoding geometry, each piece's compressed bufferViews were copied
// through byte-for-byte and just re-indexed into a smaller per-piece
// glTF (accessors/meshes/materials/textures/images/bufferViews all
// pruned to only what that piece actually uses). Geometry itself is
// therefore bit-identical to your export, nothing lossy happened there.
//
// Materials were stripped the same way IMONLOKI.glb's were (see the
// retirement note above) and for the same reason: this scene's pipeline
// renders everything through toUnlitFlat, which only ever reads
// pbrMetallicRoughness.baseColorTexture - so normalTexture/
// occlusionTexture/metallicRoughnessTexture/the KHR_materials_specular
// extension (all present on nearly every material in this upload) were
// dead weight, and emissiveTexture/emissiveFactor were dropped outright
// so nothing in this batch accidentally inherits toUnlitFlat's "any
// emissiveMap = flicker like an LED sign" behavior (shading.js) - correct
// for street signage, wrong for a bike headlight or a shoelace. alphaMode
// was left exactly as authored per material (this file's usual "OPAQUE
// unless BLEND/MASK is explicitly set" rule) - the two materials that did
// have alphaMode: BLEND (hair, and one bike decal/sticker material) kept
// their alpha channel; everything else went PNG/JPEG->JPEG since the
// alpha would've been discarded at render time anyway.
//
// Baked textures downscaled/re-encoded on top of that (same "shrink the
// bake, don't touch the mesh" move as every other rebake in this file):
// tiles/bike capped at 2048/1536 JPEG q85, the "me" character's alpha-
// carrying hair PNG capped at 1024. Total: 5.25MB->0.58MB (tiles),
// 0.90MB->0.39MB (bike), 7.95MB->1.72MB (me).

// TILES.glb - "proper tiles, they werent packed" - the main pavement +
// side sidewalk ground planes, now real merged geometry (not just a
// texture swap attempted twice before and reverted, see the
// groundbake/"side sidewalk" history further down this file). Two flat
// top-level nodes (Object040 = main pavement, ~39x1x43 world units;
// Object041 = side sidewalk, similar span), each placed at its own
// exported translation/rotation/scale - same trust-the-export handling as
// every other standalone model in this file.
const TILES_LOADING_TOKEN = 'tiles-model-load';

async function addTiles(scene) {
  loadingManager.itemStart(TILES_LOADING_TOKEN);
  try {
    const { scene: tiles } = await loadModel(modelPath('/models/TILES.glb'));
    tiles.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.receiveShadow = true;
    });
    scene.add(tiles);
  } catch (err) {
    console.error('[tiles] failed to load TILES.glb:', err);
  } finally {
    loadingManager.itemEnd(TILES_LOADING_TOKEN);
  }
}

// BIKE.glb - "a new bike bake" - turns out to be FOUR separate parked
// bikes strung along the sidewalk (x from about +13.8 down to -16.2 at
// z~-19), not four parts of one bike - this is very likely the same
// "these bikes have this weird material can we make it black instead"
// white-material issue from before, which you deferred with "ignore ill
// re export" - this looks like that re-export. Each of the 4 nodes keeps
// its own exported transform. NOTE: the OLD white-material bikes may
// still be sitting inside TRY7_SCENE.glb at roughly this same spot (never
// conclusively identified/removed - see the deferred investigation
// earlier in this file) - if these show up doubled/overlapping in-game,
// that's the old geometry still underneath, not a bug in this addition;
// flag it and I'll go find the old nodes to hide once you've seen it.
const BIKE_LOADING_TOKEN = 'bike-model-load';

async function addBike(scene) {
  loadingManager.itemStart(BIKE_LOADING_TOKEN);
  try {
    const { scene: bike } = await loadModel(modelPath('/models/BIKE.glb'));
    bike.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    scene.add(bike);
  } catch (err) {
    console.error('[bike] failed to load BIKE.glb:', err);
  } finally {
    loadingManager.itemEnd(BIKE_LOADING_TOKEN);
  }
}

// ME.glb - the "About Me" character, replacing IMONLOKI.glb (see the
// retirement note above). Single node this time (Tube.001, 9 primitives -
// hair/face/body/eyes/shorts/tank/shoes/details, same material set as the
// old file) instead of 10 separate part-nodes, and per "proper geometry
// origins for the model of me" its own translation is now the correct
// world placement directly - checked: (-16.08, 2.20, -17.67), right at
// Loki's spot and about 2.2 units up, i.e. sitting on the car roof/hood,
// which is exactly "im sitting on top of the car." No more borrowing
// Loki's position/quaternion and skipping its scale (the old IMONLOKI
// workaround) - this node's own scale (~0.0248, close to Loki's own
// ~0.0254 tile/bike scale) is trusted as-is, same as everything else in
// this shared re-export batch.
//
// Re-exported a second time right after ("had some unpacked textures
// heres the corrdect [correct one]... in the model of just me i mean") -
// justmeproper.glb, same single Tube.001 node/9-primitive structure and
// same material names, so this just replaced ME.glb's baked textures and
// added a real rotation quaternion (the first export had none, i.e.
// identity - this one has an actual facing direction baked in). Rebuilt
// through the same split-and-strip pipeline as the first ME.glb: Draco
// bufferViews copied through unchanged, materials stripped to
// baseColorTexture only, images optimized (18MB -> 1.2MB across all 9
// bakes combined this pass).
//
// Lashes ("lasjes") material patched separately right after: "give the
// lashes material a plain black color i forgot to pack that material" -
// the bake for that one slot was never actually done, so
// Material_3.001's baseColorTexture was swapped for a flat
// baseColorFactor [0,0,0,1] instead, and the now-unused "lasjes" image/
// texture/bufferView removed from the file outright (not just
// unreferenced - same "don't ship dead bytes" rule as every other
// texture pass in this file).
const ME_LOADING_TOKEN = 'me-model-load';

async function addMe(scene) {
  loadingManager.itemStart(ME_LOADING_TOKEN);
  try {
    const { scene: me } = await loadModel(modelPath('/models/ME.glb'));
    me.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    scene.add(me);
  } catch (err) {
    console.error('[me] failed to load ME.glb:', err);
  } finally {
    loadingManager.itemEnd(ME_LOADING_TOKEN);
  }
}

async function addLoki(scene) {
  loadingManager.itemStart(LOKI_LOADING_TOKEN);
  try {
    const { scene: loki } = await loadModel(modelPath('/models/LOKI.glb'));
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
  } catch (err) {
    console.error('[loki] failed to load LOKI.glb:', err);
  } finally {
    loadingManager.itemEnd(LOKI_LOADING_TOKEN);
  }
}

// SIGNS.glb - "we have a missing sign mesh" -> "its the one that says
// octarian hangyodon on it" -> "actuyally the airpack and that one".
// Single node (Object258, same name+material as the blank one hidden in
// addStreetScene above), one combined texture atlas covering the whole
// sign cluster on this building face: Octarian Hangyodon + AirPack (the
// two that were actually missing) plus Love Potion/Shoes+Accessories
// (already working elsewhere, now consolidated into this one re-baked
// mesh instead of staying split across the old geometry). Material had
// an emissiveTexture (2048px PNG, 3.35MB) in the original export, but
// toUnlitFlat() never actually samples emissiveMap for color - it's only
// checked as a boolean to decide whether a material flickers (see
// shading.js) - so that texture was dropped entirely and emissiveFactor
// [0.5,0.5,0.5] kept on its own to still trigger the flicker, same
// "don't ship dead bytes" rule as every other texture pass in this file.
// baseColorTexture (1024px JPEG, 330KB) left untouched - already small,
// and per the HD-tier sign rule elsewhere in this file (search
// MENU_SIGN_NODE_NAMES) sign text stays unshrunk for legibility anyway.
// "these are going to serve as the cover" - two flat quads (album covers next
// and current.glb, exported with square-ish UVs so cover art maps on with
// minimal stretch) that replace the old floating 2D UI cover card with a
// real mesh sitting right at the record player. No baked material in the
// export (plain geometry only) - loadVinylTrack in main.js builds a fresh
// MeshBasicMaterial per plane and swaps its .map on every track change,
// same unlit/flat convention as everything else here. Exported so main.js
// can reach these two meshes directly without a getObjectByName lookup
// through the (unrelated) street scene - starts null, populated once the
// tiny (2KB) file resolves, which given its size is effectively immediate.
export const albumCoverPlanes = { current: null, next: null };
const ALBUM_COVERS_LOADING_TOKEN = 'album-covers-model-load';

async function addAlbumCovers(scene) {
  loadingManager.itemStart(ALBUM_COVERS_LOADING_TOKEN);
  try {
    const { scene: covers } = await loadModel('/models/ALBUM_COVERS.glb');
    // "in case i misspoke too, plane .005 is current and plane .004 is the
    // 'up next' cover" - corrected from an earlier (wrong) guess.
    const current = covers.getObjectByName(sanitizeGltfName('Plane.005'));
    const next = covers.getObjectByName(sanitizeGltfName('Plane.004'));
    if (current?.isMesh) {
      // MeshBasicMaterial multiplies its .color against .map - this
      // started as 0x111111 (a near-black placeholder before any texture
      // loads) but that tint never got reset once main.js's
      // applyCoverPlaneTextures() sets the real cover .map, so every cover
      // was rendering at ~7% brightness ("really dark" - already unlit,
      // MeshBasicMaterial ignores scene lights entirely, this was a tint
      // bug not a lighting one). White leaves the map's own colors
      // untouched.
      current.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      albumCoverPlanes.current = current;
    } else {
      console.warn('[album covers] Plane.005 (current) not found in ALBUM_COVERS.glb - skipping');
    }
    if (next?.isMesh) {
      next.material = new THREE.MeshBasicMaterial({ color: 0xffffff }); // see "current" plane comment above - same tint fix
      albumCoverPlanes.next = next;
    } else {
      console.warn('[album covers] Plane.004 (next) not found in ALBUM_COVERS.glb - skipping');
    }
    scene.add(covers);
  } catch (err) {
    console.error('[album covers] failed to load ALBUM_COVERS.glb:', err);
  } finally {
    loadingManager.itemEnd(ALBUM_COVERS_LOADING_TOKEN);
  }
}

// "heres one with the unwarped mesh and origins" - replaces the record
// disc that used to live inside TRY7_SCENE.glb as Counter_Cube.001
// (looked up via getObjectByName, then runtime-recentered in
// vinylInteraction.js to work around its off-center origin). This is a
// standalone single-node export with a correctly-centered origin already
// baked in at the source, positioned directly at the record player via
// its own node transform - no recentering hack needed anymore.
// vinylInteraction.js reads this via bindDisc() instead of a
// getObjectByName lookup, same lazy-bind-once-loaded pattern as
// albumCoverPlanes above. Starts hidden (only shown while locked into the
// record player, see vinylInteraction.js's _lockIn/_unlock) - matches the
// old Counter_Cube.001's default-hidden behavior.
export const recordDiscRef = { mesh: null };
const RECORD_DISC_LOADING_TOKEN = 'record-disc-model-load';

async function addRecordDisc(scene) {
  loadingManager.itemStart(RECORD_DISC_LOADING_TOKEN);
  try {
    const { scene: discScene } = await loadModel(modelPath('/models/RECORD_DISC.glb'));
    const disc = discScene.getObjectByName(sanitizeGltfName('Stickersbox02_Cube.005'));
    if (disc?.isMesh) {
      disc.visible = false;
      recordDiscRef.mesh = disc;
    } else {
      console.warn('[record disc] Stickersbox02_Cube.005 not found in RECORD_DISC.glb - skipping');
    }
    scene.add(discScene);
  } catch (err) {
    console.error('[record disc] failed to load RECORD_DISC.glb:', err);
  } finally {
    loadingManager.itemEnd(RECORD_DISC_LOADING_TOKEN);
  }
}

const SIGNS_LOADING_TOKEN = 'signs-model-load';

async function addSigns(scene) {
  loadingManager.itemStart(SIGNS_LOADING_TOKEN);
  try {
    const { scene: signs } = await loadModel(modelPath('/models/SIGNS.glb'));
    signs.traverse((obj) => {
      if (!obj.isMesh) return;
      const rawMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const unlit = toUnlitFlat(rawMat);
      rawMat.dispose();
      obj.material = unlit;
      obj.receiveShadow = true;
    });
    scene.add(signs);
  } catch (err) {
    console.error('[signs] failed to load SIGNS.glb:', err);
  } finally {
    loadingManager.itemEnd(SIGNS_LOADING_TOKEN);
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
