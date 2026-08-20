// ---------------------------------------------------------------------------
// Title screen: an orthographic view of the big signed corner building,
// each sign panel clickable as a menu item. Matches the concept sketch you
// shared (Blender screenshot, User Orthographic view of that building with
// "GRAPHIC DESIGN ILLUSTRATION", "GAMERS", "CAMP", etc. baked on as
// individual sign panels, "CLICK LABELS TO VIEW STATIC PORTFOLIO OR WINDOW
// SHOP" baked right onto one of them).
//
// Two things in here are BEST GUESSES, not confirmed, flagged so they're
// easy to find and fix:
//
// 1. MENU_SIGN_NODE_NAMES - found by spatially clustering TRY4_SCENE.glb's
//    nodes (everything roughly x:[-17,-8] y:[2,21] z:[-17,-13] - a tall
//    building with panels stacked at ~2.5-unit floor spacing, which lines
//    up with the screenshot). I can tell WHERE the panels are, not WHAT'S
//    painted on each one - that needs your eyes or Blender's outliner
//    (click a sign, its name shows in Blender's header like "Box11674" did
//    in your screenshot). The click handler below logs whatever you click
//    to the debug-pos readout (bottom of screen) specifically so you can
//    walk the panels in-browser and tell me "panel X -> GAMERS section" etc.
//
// 2. BUILDING_BOUNDS / camera framing - measured off the same node cluster,
//    but I can't see the actual render, so the crop/angle is a starting
//    guess. CAMERA_* constants below are the ones to nudge once you've
//    actually looked at it.
//
// Sign -> destination mapping (which section each sign should route to,
// static portfolio vs. drop into walk mode at a specific vendor) isn't
// built yet - every sign click currently just enters walk mode at the
// normal spawn and logs the sign's node name. Wire real per-sign routing
// into `resolveDestination()` below once you've got the mapping figured
// out.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

export const MENU_SIGN_NODE_NAMES = [
  // top of the building - biggest/most prominent panels
  'Box011_2', 'Object1405101166',
  'S_japansignAB_015', 'Object121_1',
  'Object120',
  // stacked floor panels, top to bottom (paired left/right at each floor)
  'Plane097_1', 'Plane098_1',
  'Plane095_1', 'Plane096_2',
  'Plane093_2', 'Plane094_1',
  'Plane091_1', 'Plane092_2',
  'Plane089_1', 'Plane090_1',
  'Plane087_1', 'Plane088_1',
];

// Measured directly off TRY4_SCENE.glb (world-space transform walk over the
// node cluster above) - not eyeballed.
const BUILDING_BOUNDS = {
  min: new THREE.Vector3(-17, 2, -17),
  max: new THREE.Vector3(-8, 21, -13),
};

// Camera framing - starting guess, tune once you can see it render.
// Positioned diagonally off the building's corner (matches the 3/4
// orthographic angle in your Blender screenshot, rather than a flat head-on
// elevation - a pure head-on view would foreshorten whichever face isn't
// square to the camera, same reason your screenshot isn't a straight-on shot).
const CAMERA_DISTANCE = 45; // how far back along the diagonal - doesn't affect framing (orthographic), just needs to clear other geometry
const CAMERA_HEIGHT_OFFSET = 6; // lift above building center so it reads slightly from above, like the screenshot
// "Aperture"/zoom for an orthographic camera - this margin IS the zoom
// knob (there's no focal length to change, the frustum height is what
// controls how much fits on screen). Bumped 1.15 -> 1.45 per your call that
// the sign sits too tight/high and you want more of the storefronts below
// visible - bigger margin = taller frustum = more of the building (and the
// street-level shops under it) fits in frame, at the cost of the sign
// itself reading a bit smaller. Eased back in slightly, 1.45 -> 1.3, per
// your screenshot with the dotted selection box - measured that box at
// roughly 90% of the full frame's height, so scaling the margin down by
// about that much should land close to what you outlined.
// Zoomed in again per your next dotted-box screenshot - that box measured
// ~90% of both the frame's width AND height this time (roughly centered,
// no real pan needed), so scaled the margin down by the same ~1.11x:
// 1.3 -> 1.17.
const FRUSTUM_MARGIN = 1.17;
// Shifts what the camera is CENTERED ON upward, separate from
// CAMERA_HEIGHT_OFFSET above (that only tilts the viewing angle - lookAt()
// keeps the target point screen-centered no matter how high the camera
// itself sits, so it does nothing for cropping). "DESIGN" at the top of the
// tall sign was getting cut off - the frustum's vertical middle needed to
// move up, not just the camera. Trades a few units of headroom at the
// bottom (mostly plain wall/street down there, less important) for a few
// more at the top. Dialed back 4 -> 2.5 -> 1.2 across two rounds - each fix
// cut the OTHER end a bit too close (2.5 still clipped the street-level
// storefronts at the bottom), so easing toward the middle each time rather
// than jumping straight to a guess.
const FRAME_CENTER_Y_OFFSET = 1.2;
// Horizontal pan, same idea as the Y offset above but sideways - there was
// a visible gap of empty background on the left edge (nothing framed
// there), meaning the window was centered a bit too far left of the
// building. Positive shifts the framed window right (pulls more real
// geometry into that left-edge gap; crops a little more off the right,
// which had room to spare).
const FRAME_CENTER_X_OFFSET = 2;
// Which diagonal corner to view from - flipped from the first guess (+1,+1)
// after you reported seeing a plain windowed back wall instead of the
// signed face. -1,-1 looks from the opposite corner instead. If this is
// STILL the wrong face/building, this offset isn't the actual problem -
// see the comment on MENU_SIGN_NODE_NAMES/BUILDING_BOUNDS above about
// getting a real anchor point instead of iterating on this blind.
const CAMERA_CORNER = new THREE.Vector2(-1, -1);

// Mouse-parallax, "like the Apple wallpaper depth effect" - a tiny eased
// offset applied to the look-at target (NOT the camera position - see the
// long comment on TitleScreen.update() below for why a rotation was the
// right call here, not a translation) along the camera's own screen-right/
// screen-up axes as the pointer moves.
//
// "make the title screen parallax more noticeable" - was 0.35, tuned back
// then per "barely any"/"felt more than seen." Bumped to 1.0 (~3x the
// shift) - at the ~60+ unit look-at distance that's still under a 1-degree
// tilt, so it stays a depth cue rather than a swing, just a clearly visible
// one now instead of near-subliminal. Eased half-life left alone (0.15s)
// since that's response SPEED, not amount - "more noticeable" was about
// the offset being too small, not too slow to catch up.
const PARALLAX_STRENGTH = 1.0; // max look-at target shift (world units) at pointer extremes
const PARALLAX_EASE_HALF_LIFE = 0.15; // seconds to close ~half the remaining gap to the target offset

function buildingCenter() {
  return BUILDING_BOUNDS.min.clone().add(BUILDING_BOUNDS.max).multiplyScalar(0.5);
}

function createOrthoCamera(renderer) {
  const size = renderer.getSize(new THREE.Vector2());
  const aspect = size.x / size.y;
  const height = (BUILDING_BOUNDS.max.y - BUILDING_BOUNDS.min.y) * FRUSTUM_MARGIN;
  const width = height * aspect;

  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 300);

  const center = buildingCenter();
  const frameTarget = center.clone();
  frameTarget.y += FRAME_CENTER_Y_OFFSET;
  const cameraPos = new THREE.Vector3(
    frameTarget.x + CAMERA_CORNER.x * CAMERA_DISTANCE,
    frameTarget.y + CAMERA_HEIGHT_OFFSET,
    frameTarget.z + CAMERA_CORNER.y * CAMERA_DISTANCE
  );

  // Horizontal pan (FRAME_CENTER_X_OFFSET) - computed as a real "screen
  // right" vector (cross of the view direction and world-up) rather than
  // guessed as a raw x/z offset, since the camera's diagonal angle means
  // screen-right isn't aligned to either world axis. Applied to BOTH the
  // camera position and the look-at target by the same amount, which keeps
  // the view DIRECTION identical (a true parallel pan) instead of
  // re-aiming/orbiting around frameTarget.
  const viewDir = frameTarget.clone().sub(cameraPos).normalize();
  const screenRight = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize();
  const pan = screenRight.multiplyScalar(FRAME_CENTER_X_OFFSET);
  frameTarget.add(pan);
  cameraPos.add(pan);

  camera.position.copy(cameraPos);
  camera.lookAt(frameTarget);

  // Stashed for the mouse-parallax update loop below - the "base" (no
  // parallax offset) position/target, plus the screen-right/up axes to pan
  // along. View direction is fixed once framing is set, so these axes only
  // need computing once here rather than every frame.
  const screenUp = new THREE.Vector3().crossVectors(screenRight, viewDir).normalize();
  camera.userData.basePosition = cameraPos.clone();
  camera.userData.baseTarget = frameTarget.clone();
  camera.userData.screenRight = screenRight.clone();
  camera.userData.screenUp = screenUp;

  return camera;
}

export class TitleScreen {
  constructor(scene, renderer, { onEnter, onHoverChange } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.onEnter = onEnter; // (signName | null) => void - called on click; null = clicked empty space
    this.onHoverChange = onHoverChange; // (signName | null) => void - called when hover target changes

    this.camera = createOrthoCamera(renderer);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.signMeshes = [];
    this.hovered = null;
    this._boundOnce = false;

    // Mouse-parallax state - this.pointer (below, updated by
    // _onPointerMove) already tracks the raw normalized pointer position
    // for raycasting; _parallax is the EASED version of that, chased toward
    // this.pointer each frame in update() rather than snapping straight to
    // it, and _lookTarget is just a scratch Vector3 reused every frame
    // instead of allocating a new one.
    this._parallax = new THREE.Vector2(0, 0);
    this._lookTarget = new THREE.Vector3();

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onClick = this._onClick.bind(this);
    renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    renderer.domElement.addEventListener('click', this._onClick);
  }

  // Called every frame from main.js's tick while mode === 'title' only -
  // this is deliberately title-screen-only, not something that should
  // follow into walk mode's first-person camera.
  //
  // This is a ROTATION (camera.position never moves - only the look-at
  // target shifts, tilting the view angle), not a translation, per your
  // ask for "a subtle camera angle look" rather than movement. Worth
  // explaining why, since it's a bit counterintuitive: with an orthographic
  // camera there's no perspective foreshortening, so translating the camera
  // sideways shifts EVERY point on screen by the exact same amount no
  // matter how near or far it is - it reads as sliding a flat photograph,
  // not real depth/parallax. Rotating instead (position fixed, tilt the
  // view direction) actually DOES mix depth back in - because the screen
  // position of a point depends on projecting it onto the camera's
  // right/up axes, and rotating those axes shifts far points by more than
  // near ones for the same tilt angle. So rotation is not only what you
  // asked for, it's also the version that actually produces a real
  // depth-parallax cue here - translation was the one giving up on that.
  update(delta) {
    // Framerate-independent exponential ease toward the raw pointer
    // position - closes roughly half the remaining gap every
    // PARALLAX_EASE_HALF_LIFE seconds regardless of frame rate, instead of
    // a fixed per-frame lerp factor that would speed up/slow down with fps.
    const ease = 1 - Math.pow(0.5, delta / PARALLAX_EASE_HALF_LIFE);
    this._parallax.x += (this.pointer.x - this._parallax.x) * ease;
    this._parallax.y += (this.pointer.y - this._parallax.y) * ease;

    const { baseTarget, screenRight, screenUp } = this.camera.userData;
    this._lookTarget
      .copy(baseTarget)
      .addScaledVector(screenRight, this._parallax.x * PARALLAX_STRENGTH)
      .addScaledVector(screenUp, this._parallax.y * PARALLAX_STRENGTH);
    this.camera.lookAt(this._lookTarget);
  }

  // Call every frame from main.js's tick, guarded by streetSceneStatus - see
  // the call site there. Cheap no-op once already bound (the isMesh filter
  // below just re-checks a short array).
  bindSigns(street) {
    if (this._boundOnce) return;
    this._boundOnce = true;

    this.signMeshes = MENU_SIGN_NODE_NAMES
      .map((name) => street.getObjectByName(name))
      .filter((obj) => obj && obj.isMesh);

    if (this.signMeshes.length < MENU_SIGN_NODE_NAMES.length) {
      const missing = MENU_SIGN_NODE_NAMES.filter((name) => !street.getObjectByName(name));
      console.warn('[title screen] some MENU_SIGN_NODE_NAMES did not resolve to meshes:', missing);
    }

    // Clone each sign's material before doing any hover tinting - these
    // materials came out of the main traverse loop's toUnlitFlat pass in
    // world.js, and several material names in this project turned out to be
    // shared across many unrelated nodes (VynilMaterial.002/BoxMaterial.002/
    // etc, see world.js's LIT_EXCEPTION_MATERIAL_NAMES comments for the
    // history there). Tinting a shared material in place would light up
    // every OTHER object using it too, not just the hovered sign - cloning
    // here keeps each sign's hover state fully independent no matter what
    // it turns out to share with.
    for (const mesh of this.signMeshes) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone();
    }
  }

  _setPointerFromEvent(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _raycastSign() {
    if (this.signMeshes.length === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.signMeshes, false);
    return hits.length > 0 ? hits[0].object : null;
  }

  _onPointerMove(e) {
    this._setPointerFromEvent(e);
    const hit = this._raycastSign();
    if (hit === this.hovered) return;

    this._setHoverTint(this.hovered, false);
    this.hovered = hit;
    this._setHoverTint(this.hovered, true);
    this.renderer.domElement.style.cursor = hit ? 'pointer' : '';
    this.onHoverChange?.(hit?.name ?? null);
  }

  _onClick(e) {
    this._setPointerFromEvent(e);
    const hit = this._raycastSign();
    this.onEnter?.(hit?.name ?? null);
  }

  // Simple brightness bump on hover - these are unlit MeshBasicMaterial
  // (baked signs, see toUnlitFlat in shading.js), so there's no lighting
  // response to fake a highlight with; nudging emissiveIntensity/color is
  // the cheap equivalent. Falls back to nudging .color directly if the
  // material has no emissive map (toUnlitFlat only sets emissiveIntensity
  // when the source material actually had emissive data).
  _setHoverTint(mesh, isHovered) {
    if (!mesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (!mat.userData._baseColor) {
        mat.userData._baseColor = mat.color.clone();
      }
      mat.color.copy(mat.userData._baseColor).multiplyScalar(isHovered ? 1.4 : 1);
    }
  }

  // Resize hook - call from main.js's window resize listener alongside the
  // perspective camera's own aspect update.
  onResize() {
    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = size.x / size.y;
    const height = (BUILDING_BOUNDS.max.y - BUILDING_BOUNDS.min.y) * FRUSTUM_MARGIN;
    const width = height * aspect;
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
    this.renderer.domElement.removeEventListener('click', this._onClick);
    this.renderer.domElement.style.cursor = '';
  }

  // Re-adds the listeners dispose() removed - for when Home (main.js's
  // startReturnToTitle) reverses back to the title screen instead of a full
  // page reload. _onPointerMove/_onClick are still the same bound function
  // references from the constructor (dispose only removes them, doesn't
  // null them out), so this is just addEventListener again - safe to call
  // even if already bound since DOM listeners de-dupe identical
  // type+listener pairs automatically.
  rebind() {
    this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    this.renderer.domElement.addEventListener('click', this._onClick);
  }
}
