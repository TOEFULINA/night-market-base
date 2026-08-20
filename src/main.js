import * as THREE from 'three';
import { Controls } from './controls.js';
import { buildWorld, streetSceneStatus, streetScene } from './world.js';
import { initLoadingUI } from './loader.js';
import { TitleScreen } from './titleScreen.js';
import { createPostProcessing } from './postprocessing.js';
import { flickerUniforms } from './shading.js';
import { VinylInteraction } from './vinylInteraction.js';

const canvas = document.getElementById('scene');

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  // Vertical FOV. Went 70 -> 55 -> 45. Lower FOV = more "zoomed in" /
  // telephoto - narrower peripheral view, but things read closer and larger
  // and straight lines stop bowing near the edges. 45 is on the tighter end
  // for a walking game (some claustrophobia risk in narrow alleys - if it
  // ever feels too tunnel-vision-y, that's the tradeoff to dial back).
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  // TEMP: bumped from 120 to cover the street scene's raw extent. This is a
  // rough guess, not tuned - once you've seen it running we should pull
  // this back down to whatever the actual visible/usable range is, since a
  // huge far plane means the GPU still has to consider everything within
  // it every frame.
  2500
);
// Layer 1 = "walk-mode-only" geometry (currently just the new ground plane
// and wall+building from TRY6_SCENE.glb, see world.js's TITLE_HIDDEN_NODE_NAMES) -
// enabling it here on top of the default layer 0 means this camera renders
// everything as normal. titleScreen.js's OrthographicCamera deliberately
// does NOT enable layer 1, so those two nodes only ever show up in walk
// mode, never behind the title screen's sign-building view.
camera.layers.enable(1);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// cap pixel ratio - rendering at full 3x retina resolution on a phone is a
// straightforward, easy-to-miss way to tank frame rate for no visible gain.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Real-time shadows, turned on per your call - the flat/shadowless look
// was the actual complaint, and this scene is small/compact enough
// (~41x45 units, not the old sprawling street) that a single sun shadow
// map is a reasonable cost. PCFSoftShadowMap = soft edges (a few samples
// blended) instead of hard-edged PCF - a bit more GPU cost per shadowed
// pixel, but reads far less "video-gamey"/aliased than the hard default.
// See world.js for the actual light's shadow-camera setup (tightly fit to
// the scene bounds, not this file).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// filmic tone mapping - ACES is what keeps bright reflections/highlights
// from just blowing out to flat white. Exposure dropped 1.1 -> 0.85 - the
// scene was reading too bright/washed-out compared to the Blender
// viewport (paired with the light-intensity drops in world.js, not a
// texture/material change, so nothing needs re-baking for this).
// Bumped back up 0.85 -> 1.0 as part of the contrast pass, grounded in your
// actual World panel: Sky Texture Strength is 1.000 (neutral, not turned
// down), and Sun Elevation 183° puts the sun just under the horizon with
// Sun Intensity only 0.100 - i.e. your scene's own punch comes from the
// physically-based sky (Air 0.6 = low scattering = a naturally high-contrast
// bright-horizon/dark-zenith gradient), not from an underexposed render.
// Sitting at 0.85 was stacking extra shadow-crush on top of that already-
// high-contrast source instead of just reproducing it. ACES itself still
// does the highlight rolloff work, so this won't blow anything out.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Nudged down a touch (1.0 -> 0.92) per "just a bit darker" - small enough
// not to fight the contrast-pass reasoning above, just a slight overall dim.
renderer.toneMappingExposure = 0.92;

// Companion character, background NPCs, the toon/flat shading pipeline, and
// the black-outline post-process are all gone per your call to drop the
// stylized look and bring back realism - see world.js for what replaced the
// lighting (real PBR materials left untouched instead of converted to
// flat/toon, plus a proper environment map so they don't render dead flat).
// companion.js/npc.js/post.js and their toon/outline helpers in shading.js
// have been deleted outright (were unwired dead files, not doing anything -
// same for skyline.js after the skybox got pulled). Nothing imports them,
// so this isn't a loading-perf change, just repo cleanup.
// buildWorld needs the renderer now (not just the scene) to generate that
// environment map, which is why renderer construction moved above this call.
const { updateAtmosphere } = buildWorld(scene, renderer);

// --- Title screen / walk mode state machine ---------------------------
// Starts in 'title': orthographic view of the signed corner building (see
// titleScreen.js), signs clickable as menu items. Controls (the first-
// person walk rig) isn't constructed until you actually enter walk mode -
// its constructor immediately wires up the WASD/drag-look intro overlay,
// which shouldn't be showing while the title screen is up.
let mode = 'title';
let controls = null;
let signsBound = false;
let vinylInteraction = null;
let vinylBound = false;

const debugPosEl = document.getElementById('debug-pos');
// Hidden while on the title screen per your ask - it used to double as a
// hover readout there ("title screen - click a sign" / "hovering: X"), but
// that's gone now (still logging to console on click below, just not
// painted in the corner anymore). Shown again once you're in walk mode,
// where it's back to being the x/y/z/yaw debug readout it was originally.
if (debugPosEl) debugPosEl.style.display = 'none';

const titleScreen = new TitleScreen(scene, renderer, {
  onEnter: (signName) => {
    // No real per-sign destination routing yet (static portfolio vs. a
    // specific walk-mode spawn) - every click just enters walk mode at the
    // normal spawn for now, per-sign behavior is a TODO once you've told me
    // the actual sign -> section mapping. Logging which node got clicked
    // (or 'background' for a miss) is the point of this for now - it's how
    // you can walk the panels and report back what maps to what.
    console.log('[title screen] clicked:', signName ?? 'background');
    startTransition();
  },
});

// Snapshot of the ORIGINAL title framing pose, taken right here before
// anything ever touches titleScreen.camera (parallax nudges the look-at
// target slightly every frame, and every title->walk flight repositions it
// outright during the ortho phase). Home (startReturnToTitle below) always
// flies back to this exact literal pose, not a re-derived approximation.
const TITLE_HOME_POS = titleScreen.camera.position.clone();
const TITLE_HOME_QUAT = titleScreen.camera.quaternion.clone();

// Per-route spawn points - grabbed from the #debug-pos readout the same way
// the default spawn in controls.js was (screenshot it, copy x/y/z/yaw).
// Routes not listed here fall back to controls.js's default SPAWN_POSITION/
// SPAWN_YAW inside startTransition() below. EYE_HEIGHT isn't imported here
// (it's private to controls.js) - y is just the literal value from the
// readout, which is always EYE_HEIGHT since that's what the debug overlay
// reads camera.position.y as while standing still.
const LOCATIONS = {
  'explore-archive-shop': { x: -2.74, y: 1.3, z: -18.01, yawDeg: 180 },
  'explore-records': { x: -5.61, y: 1.3, z: -15.25, yawDeg: 141 },
  'explore-prints-figures': { x: 3.66, y: 1.3, z: -18.9, yawDeg: 179 },
  'explore-packaging': { x: 10.25, y: 1.3, z: -18.9, yawDeg: 209 },
};

// Cycling order for the </> Explore-nav arrows - matches index.html's
// submenu order. 'explore-prints-figures' has no LOCATIONS entry yet (not
// wired), so findAdjacentExploreRoute below just steps past it until you've
// given me its coordinates - nothing else needs to change once it's added
// to LOCATIONS above, it'll start showing up in the cycle automatically.
const EXPLORE_ROUTE_ORDER = ['explore-archive-shop', 'explore-records', 'explore-prints-figures', 'explore-packaging'];

// --- Title -> walk camera transition ------------------------------------
// "pan out from orthographic... dynamically moving to the walk point
// fluidly, not just a direct cut." Two phases now, not one - see your call
// that a single perspective-only flight was showing "the model looks tiny
// and all the empty space" right at the start: even with the FOV matched to
// reproduce the ortho camera's apparent zoom AT THAT ONE INSTANT, a
// perspective camera sitting 45+ units back (titleScreen.js's
// CAMERA_DISTANCE) still diverges from a true orthographic projection more
// than it looks like it should at a glance - enough to reveal empty
// background past the edges of the framed building the moment the swap
// happens, before the flight has covered any real distance yet to hide it.
//
// Fix: don't touch the perspective camera at all until we're already most
// of the way there. Phase 1 stays 100% orthographic - the actual
// titleScreen.camera flies (position/rotation) AND zooms in
// (OrthographicCamera.zoom, a genuine distance-invariant zoom since ortho
// projection doesn't care how close the camera physically is) toward a
// handoff pose partway along the journey. Phase 2 only then swaps to the
// perspective camera, starting from that already-zoomed-in handoff framing
// (so the FOV-matching math has way less distortion to hide) and finishing
// the rest of the trip normally. tick()/updateTransition below pick which
// camera actually renders each frame based on transition.hasOrthoPhase/
// transition.switched.
// Bumped 0.45 -> 0.6 per "weird empty space" still showing - spends more of
// the flight orthographic (where there's no perspective distortion to leak
// background past the framed building's edges) before handing off, leaving
// less exposure time in perspective before arriving close to the destination.
const ORTHO_PHASE_FRACTION = 0.6; // portion of the total flight spent in phase 1
const ORTHO_ZOOM_END = 2.5; // how far phase 1 zooms in before handing off - first guess, tune once you've seen it
const TRANSITION_SECONDS = 2.6; // slowed down from 1.6 per your call

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ONE continuous ease across the whole flight, not two glued-together
// halves. The first version of the ortho->perspective flight eased phase 1
// (0->1 over its own span) and phase 2 (0->1 over its own span) SEPARATELY -
// each easeInOutCubic curve decelerates to a dead stop at its own t=1 and
// starts from a dead stop at its own t=0, so gluing two of them back to back
// meant real velocity actually dropped to ~0 right at the ortho/perspective
// handoff, every time - that's the "it stops and switches" hitch you saw.
// Fix: drive position/quaternion/zoom/fov off a SINGLE eased t computed over
// the full TRANSITION_SECONDS span (see updateTransition below); which
// camera is actively rendering is just a question of where in that one
// continuous curve we are (before/after handoffT), not a second animation
// glued on. fromPos/fromQuat are the title camera's pose at flight start;
// toPos/toQuat/toFov are the walk destination. handoffT/handoffFov (ortho-
// phase flights only) are computed once up front so the perspective camera
// can be seeded at exactly the pose/zoom the ortho camera would have reached
// at that instant - continuous position/rotation across the switch, no pop.
// { t, fromPos, fromQuat, toPos, toQuat, toFov, routeKey,
//   hasOrthoPhase, handoffT, handoffFov, switched, fromFov (no-ortho-phase only) }
let transition = null;

// Explore-nav (</> arrows) state - see index.html/style.css for the markup.
// currentExploreIndex is -1 whenever the arrows shouldn't be showing (not
// standing at an Explore spot, or you've moved since arriving at one).
// explorePinnedPos is the exact camera position at the moment you arrived -
// compared every frame against the live camera position (see
// updateExploreNavVisibility below) to detect "moved from the spot at all."
let currentExploreIndex = -1;
let explorePinnedPos = null;
const EXPLORE_NAV_MOVE_EPSILON = 0.05;

// "Lock the amount you can look right/left" - all 4 current Explore spawns
// (180/141/179/209°) sit comfortably inside this 125-234° window, so one
// shared range works for all of them rather than needing a per-location
// value. Applied to controls.yawClamp for as long as the </> arrows are
// showing (same activate/hide lifecycle - see activateExploreNavIfApplicable/
// hideExploreNav below), so it turns off the moment you walk away same as
// they do.
const EXPLORE_YAW_CLAMP = {
  min: THREE.MathUtils.degToRad(125),
  max: THREE.MathUtils.degToRad(234),
};

function startTransition(routeKey) {
  if (mode === 'walk') return;
  mode = 'walk';

  const orthoCam = titleScreen.camera;
  const orthoHeight = orthoCam.top - orthoCam.bottom; // full frustum height at zoom 1
  const baseTarget = orthoCam.userData.baseTarget; // what the title framing is actually centered on
  const fromPos = orthoCam.position.clone();
  const fromQuat = orthoCam.quaternion.clone();

  titleScreen.dispose(); // just removes its own input listeners - safe even though we keep rendering orthoCam through phase 1 below
  // Logo stays put in the corner in every mode now - only the list under it
  // collapses behind a click once you're walking (see the logo's click
  // handler further down). Social links are still title-screen-only, no
  // change there.
  mainMenuListEl?.classList.add('collapsed');
  socialLinksEl?.classList.add('hidden');
  document.getElementById('menu-home-item')?.classList.remove('hidden'); // walk-mode-only item, see index.html
  if (debugPosEl) debugPosEl.style.display = ''; // back on for walk mode's x/y/z/yaw readout

  // Controls' constructor snaps camera.position/rotation straight to its
  // default spawn pose - the flight's END point when no per-route location
  // is given. If `routeKey` matches something in LOCATIONS above, override
  // both the target position AND controls.yaw with that instead (pitch
  // stays 0 either way - none of the captured spots needed a tilt) so
  // controls.js picks up the right facing direction once it unlocks at the
  // end of the flight.
  controls = new Controls(camera, renderer.domElement);
  controls.locked = true;

  const location = routeKey ? LOCATIONS[routeKey] : null;
  let toPos;
  if (location) {
    toPos = new THREE.Vector3(location.x, location.y, location.z);
    controls.yaw = THREE.MathUtils.degToRad(location.yawDeg);
  } else {
    toPos = controls.camera.position.clone();
  }
  const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(controls.pitch, controls.yaw, 0, 'YXZ'));
  const toFov = 45; // matches the PerspectiveCamera's original construction fov, above

  // Position/rotation at the handoff instant, sampled off the SAME eased
  // curve updateTransition will actually drive the flight with (not a flat
  // ORTHO_PHASE_FRACTION lerp) - so the FOV computed below matches exactly
  // where the camera will really be when the switch happens, no pop.
  const easedHandoffT = easeInOutCubic(ORTHO_PHASE_FRACTION);
  const handoffPos = fromPos.clone().lerp(toPos, easedHandoffT);

  // Perspective camera's starting FOV at the handoff - same visible-height-
  // matching trick as before, evaluated at the HANDOFF pose/zoom instead of
  // the original far-away title pose: distance to baseTarget from
  // handoffPos (much closer than fromPos was), and visible height shrunk by
  // ORTHO_ZOOM_END (OrthographicCamera.zoom divides the frustum - higher
  // zoom = smaller visible slice = "zoomed in"). Less distance-to-cover and
  // less zoom mismatch left for the perspective half to hide, which is the
  // actual point.
  const handoffDistance = handoffPos.distanceTo(baseTarget);
  const handoffVisibleHeight = orthoHeight / ORTHO_ZOOM_END;
  const handoffFov = THREE.MathUtils.radToDeg(2 * Math.atan(handoffVisibleHeight / (2 * handoffDistance)));

  orthoCam.position.copy(fromPos);
  orthoCam.quaternion.copy(fromQuat);
  orthoCam.zoom = 1;
  orthoCam.updateProjectionMatrix();

  transition = {
    t: 0,
    fromPos, fromQuat,
    toPos, toQuat, toFov,
    hasOrthoPhase: true,
    handoffT: ORTHO_PHASE_FRACTION,
    handoffFov,
    switched: false,
    routeKey,
  };

  // Record player click-to-lock (vinylInteraction.js) - see that file for
  // the full writeup. onLocked is the hook for the vinyl animation you're
  // going to provide separately; just logging for now so there's something
  // to see in devtools until that exists.
  vinylInteraction = new VinylInteraction(camera, renderer.domElement, controls, {
    onLocked: () => console.log('[vinyl interaction] locked in - vinyl animation hook goes here'),
    onUnlocked: () => console.log('[vinyl interaction] unlocked, back to normal walk control'),
  });
}

// Walk-to-walk flight - used by both the </> Explore-nav arrows AND the
// corner menu now that its items work from inside walk mode too, not just
// from the title screen. Same easing/duration/locked-camera mechanics as
// the title->walk flight above, just starting from wherever the camera
// already is instead of the orthographic title camera, and skipping
// everything that's title-screen-specific (no FOV matching needed -
// already at the normal walking FOV, no menu/dispose cleanup). Only usable
// once already in walk mode and not already mid-flight, hence the guards.
function flyToLocation(routeKey) {
  if (mode !== 'walk' || transition || !controls) return;
  const location = LOCATIONS[routeKey];
  if (!location) return;

  hideExploreNav(); // re-shown by activateExploreNavIfApplicable once this flight lands

  const fromPos = camera.position.clone();
  const fromQuat = camera.quaternion.clone();
  const fromFov = camera.fov;

  controls.locked = true;

  const toPos = new THREE.Vector3(location.x, location.y, location.z);
  const toYaw = THREE.MathUtils.degToRad(location.yawDeg);
  controls.yaw = toYaw;
  controls.pitch = 0;
  const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, toYaw, 0, 'YXZ'));

  // Already in perspective (mid-walk, not coming from the title's ortho
  // camera) - no ortho phase at all, just a single continuous lerp/slerp/fov
  // blend the whole way, same shared field names/logic updateTransition uses
  // for the ortho-phase flights once they've handed off.
  transition = {
    t: 0,
    fromPos, fromQuat, fromFov,
    toPos, toQuat, toFov: fromFov,
    hasOrthoPhase: false,
    routeKey,
  };
}

// Home (walk -> title) - the literal time-reverse of startTransition's
// two-phase flight, not a page reload. Starts in perspective wherever you
// currently are, pans/zooms out through a computed handoff pose, hands off
// to the orthographic title camera for the final leg, and arrives exactly
// on TITLE_HOME_POS/TITLE_HOME_QUAT (zoom 1) - the literal pose snapshotted
// right after TitleScreen was constructed, not a re-derived approximation.
// updateTransition() below reads transition.reverse to know the camera
// hand-off happens perspective-first/ortho-last here, the opposite order
// from a normal title->walk flight, and that the zoom/FOV blends run in the
// opposite direction too (zooming OUT to the wide title framing, not in).
function startReturnToTitle() {
  if (mode !== 'walk' || transition || !controls) return;

  hideExploreNav();

  const orthoCam = titleScreen.camera;
  const orthoHeight = orthoCam.top - orthoCam.bottom;
  const baseTarget = orthoCam.userData.baseTarget;

  const fromPos = camera.position.clone();
  const fromQuat = camera.quaternion.clone();
  const fromFov = camera.fov;

  const toPos = TITLE_HOME_POS.clone();
  const toQuat = TITLE_HOME_QUAT.clone();

  // Perspective runs FIRST this time (handoffT is measured from the START,
  // same as the forward flight's handoffT - just now it marks where
  // perspective HANDS OFF to ortho, rather than where ortho hands off to
  // perspective). Using 1 - ORTHO_PHASE_FRACTION keeps the same 60/40 ortho/
  // perspective time split as the forward flight, just mirrored.
  const handoffT = 1 - ORTHO_PHASE_FRACTION;
  const easedHandoffT = easeInOutCubic(handoffT);
  const handoffPos = fromPos.clone().lerp(toPos, easedHandoffT);
  const handoffDistance = handoffPos.distanceTo(baseTarget);
  const handoffVisibleHeight = orthoHeight / ORTHO_ZOOM_END;
  const handoffFov = THREE.MathUtils.radToDeg(2 * Math.atan(handoffVisibleHeight / (2 * handoffDistance)));

  controls.locked = true;

  transition = {
    t: 0,
    fromPos, fromQuat, fromFov,
    toPos, toQuat, toFov: fromFov, // toFov unused on this path (ortho has no fov), kept for shape consistency
    hasOrthoPhase: true,
    reverse: true,
    handoffT,
    handoffFov,
    switched: false,
    routeKey: null,
  };
}

// Steps through EXPLORE_ROUTE_ORDER from fromIndex in `direction` (+1/-1),
// wrapping around, and skips any route that isn't in LOCATIONS yet (see the
// comment on EXPLORE_ROUTE_ORDER above) - returns null only if NONE of the
// routes have a location yet, which can't happen once more than one does.
function findAdjacentExploreRoute(fromIndex, direction) {
  const n = EXPLORE_ROUTE_ORDER.length;
  for (let step = 1; step <= n; step++) {
    const idx = (((fromIndex + direction * step) % n) + n) % n;
    const route = EXPLORE_ROUTE_ORDER[idx];
    if (LOCATIONS[route]) return { route, idx };
  }
  return null;
}

function showExploreNav() {
  exploreNavEl?.classList.remove('hidden');
}
function hideExploreNav() {
  exploreNavEl?.classList.add('hidden');
  currentExploreIndex = -1;
  explorePinnedPos = null;
  if (controls) controls.yawClamp = null; // give look-around back once you've left the spot
}

// Called once a flight finishes (see updateTransition below) - turns the
// arrows on (and the yaw clamp, see EXPLORE_YAW_CLAMP above) if you just
// landed on an Explore spot, off otherwise (e.g. the title-screen sign
// flight, or Contact/About once those are routed).
function activateExploreNavIfApplicable(routeKey) {
  const idx = EXPLORE_ROUTE_ORDER.indexOf(routeKey);
  if (idx === -1 || !LOCATIONS[routeKey]) {
    hideExploreNav();
    return;
  }
  currentExploreIndex = idx;
  explorePinnedPos = camera.position.clone();
  if (controls) controls.yawClamp = EXPLORE_YAW_CLAMP;
  showExploreNav();
}

// Hides the arrows the moment you've moved at all from the spot you landed
// on - WASD movement, not look-around (rotating in place still counts as
// "at the spot"). Called every frame from tick() while in walk mode.
function updateExploreNavVisibility() {
  if (currentExploreIndex === -1 || transition || !explorePinnedPos) return;
  if (camera.position.distanceTo(explorePinnedPos) > EXPLORE_NAV_MOVE_EPSILON) {
    hideExploreNav();
  }
}

// Call every frame from tick() - no-ops once `transition` is null (either
// never started, or already finished and cleared below). Returns true if
// titleScreen.camera is the one that should render THIS frame, false
// otherwise - tick() uses this return value directly rather than inspecting
// `transition` afterward, since a flight that finishes on this exact frame
// nulls `transition` out below before returning, which would otherwise lose
// track of which camera this final frame actually needs.
//
// Single continuous eased t across the WHOLE flight (see the long comment on
// `transition` above for why - two separately-eased halves glued together
// was what caused the visible "stops and switches" hitch at the ortho/
// perspective handoff). Which camera is actually being driven this frame is
// just a question of where rawT sits relative to handoffT, not a second
// animation restarting from rest.
function updateTransition(delta) {
  if (!transition) return false;

  transition.t += delta / TRANSITION_SECONDS;
  const rawT = Math.min(transition.t, 1);
  const t = easeInOutCubic(rawT);
  const orthoCam = titleScreen.camera;
  let orthoActive;

  if (transition.reverse) {
    // Home: perspective drives the FIRST leg (rawT < handoffT), ortho drives
    // the LAST leg - the mirror image of a normal flight's ortho-first order.
    const easedHandoffT = easeInOutCubic(transition.handoffT);

    if (rawT < transition.handoffT) {
      orthoActive = false;
      camera.position.lerpVectors(transition.fromPos, transition.toPos, t);
      camera.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, t);
      // FOV narrows from the normal walking FOV toward the computed
      // handoff FOV as we approach the switch - opposite direction from a
      // forward flight's perspective leg (which widens toward 45).
      camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.handoffFov, t / easedHandoffT);
      camera.updateProjectionMatrix();
    } else {
      orthoActive = true;
      if (!transition.switched) {
        // One-time handoff - seed orthoCam at exactly the pose/zoom the
        // continuous curve says it should be at right now, so there's no
        // pop when the render camera switches from perspective to ortho.
        transition.switched = true;
        orthoCam.zoom = ORTHO_ZOOM_END;
      }
      orthoCam.position.lerpVectors(transition.fromPos, transition.toPos, t);
      orthoCam.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, t);
      // Zoom ramps back OUT, ORTHO_ZOOM_END -> 1, arriving at the normal
      // (unzoomed) title framing exactly as rawT reaches 1.
      const zoomT = (t - easedHandoffT) / (1 - easedHandoffT);
      orthoCam.zoom = THREE.MathUtils.lerp(ORTHO_ZOOM_END, 1, THREE.MathUtils.clamp(zoomT, 0, 1));
      orthoCam.updateProjectionMatrix();
    }

    if (rawT >= 1) {
      transition = null;
      finishReturnToTitle();
    }
    return orthoActive;
  }

  if (transition.hasOrthoPhase && rawT < transition.handoffT) {
    orthoActive = true;
    const easedHandoffT = easeInOutCubic(transition.handoffT);
    orthoCam.position.lerpVectors(transition.fromPos, transition.toPos, t);
    orthoCam.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, t);
    // Zoom ramps 1 -> ORTHO_ZOOM_END across the SAME eased curve, normalized
    // so it lands exactly on ORTHO_ZOOM_END right as t reaches easedHandoffT
    // (i.e. exactly at the switch), not before or after.
    orthoCam.zoom = THREE.MathUtils.lerp(1, ORTHO_ZOOM_END, t / easedHandoffT);
    orthoCam.updateProjectionMatrix();
  } else {
    orthoActive = false;
    if (transition.hasOrthoPhase && !transition.switched) {
      // One-time handoff - seed the perspective camera at exactly the pose
      // the continuous curve says it should be at right now, so there's no
      // pop at the switch (it just continues the same motion, on a
      // different camera object).
      transition.switched = true;
      orthoCam.zoom = 1; // reset for next time
      orthoCam.updateProjectionMatrix();
    }

    camera.position.lerpVectors(transition.fromPos, transition.toPos, t);
    camera.quaternion.slerpQuaternions(transition.fromQuat, transition.toQuat, t);

    if (transition.hasOrthoPhase) {
      const easedHandoffT = easeInOutCubic(transition.handoffT);
      const fovT = (t - easedHandoffT) / (1 - easedHandoffT);
      camera.fov = THREE.MathUtils.lerp(transition.handoffFov, transition.toFov, THREE.MathUtils.clamp(fovT, 0, 1));
    } else {
      camera.fov = THREE.MathUtils.lerp(transition.fromFov, transition.toFov, t);
    }
    camera.updateProjectionMatrix();
  }

  if (rawT >= 1) {
    const finishedRoute = transition.routeKey;
    transition = null;
    controls.locked = false; // hand control back to WASD/drag-look, camera is already exactly at the spawn pose
    activateExploreNavIfApplicable(finishedRoute);
  }
  return orthoActive;
}

// Runs once a reverse (Home) flight's t hits 1 - full mirror-image of what
// startTransition() sets up when entering walk mode: mode flips back to
// 'title', walk-mode UI hides, title-mode UI (menu list, social links)
// reappears, and controls/vinylInteraction are torn down via their real
// dispose() methods (not just dropped) so their window/document-level
// listeners don't pile up if you go home and re-enter several times.
function finishReturnToTitle() {
  mode = 'title';

  controls?.dispose();
  controls = null;
  vinylInteraction?.dispose();
  vinylInteraction = null;

  titleScreen.rebind();

  mainMenuListEl?.classList.remove('collapsed');
  document.getElementById('menu-home-item')?.classList.add('hidden');
  socialLinksEl?.classList.remove('hidden');
  if (debugPosEl) debugPosEl.style.display = 'none';
}

// Corner nav overlay (PORTFOLIO / EXPLORE / CONTACT / ABOUT) - separate
// from the in-scene sign clicks above, this is the flat HTML/CSS menu from
// your mockup (index.html/style.css). Portfolio and Explore are now
// dropdown parents (index.html's .has-submenu <li> wrapping a .menu-label
// + nested .submenu <ul>) rather than direct links - clicking the label
// just toggles the dropdown open/closed, it doesn't navigate anywhere
// itself anymore. Subsection clicks route through startTransition(routeKey)
// - if that route has an entry in LOCATIONS above, it flies to that exact
// spot; otherwise it just logs, same "tell me the mapping" pattern as the
// unrouted signs above.
const mainMenuEl = document.getElementById('main-menu');
const mainMenuListEl = document.getElementById('main-menu-list');

// Logo click - only does anything in walk mode (title screen already shows
// the list permanently, no toggle needed there). Same collapsed/expanded
// mechanics as the Portfolio/Explore submenus below, just one level up.
document.getElementById('main-menu-logo')?.addEventListener('click', () => {
  if (mode !== 'walk') return;
  mainMenuListEl?.classList.toggle('collapsed');
});

const allSubmenus = document.querySelectorAll('#main-menu-list .has-submenu');
document.querySelectorAll('.menu-label[data-toggle]').forEach((label) => {
  label.addEventListener('click', () => {
    const parent = label.closest('.has-submenu');
    if (!parent) return;
    const wasOpen = parent.classList.contains('open');
    // Only one dropdown open at a time - close every other one before
    // (possibly) opening this one, per your call.
    allSubmenus.forEach((el) => el.classList.remove('open'));
    if (!wasOpen) parent.classList.add('open');
  });
});

document.querySelectorAll('#main-menu-list li[data-route]').forEach((li) => {
  li.addEventListener('click', () => {
    const route = li.dataset.route;

    // Home - reverses the title->walk flight back to the exact original
    // title framing (see startReturnToTitle/finishReturnToTitle above),
    // rather than a page reload. Controls.dispose()/VinylInteraction.dispose()
    // are what make this safe to do repeatedly - without them, each round
    // trip would leave a stacked-up set of orphaned window/document-level
    // input listeners behind.
    if (route === 'home') {
      startReturnToTitle();
      return;
    }

    if (!LOCATIONS[route]) {
      console.log('[main menu] clicked:', route, '- no destination wired yet');
      return;
    }
    if (mode === 'walk') {
      // Already walking - fly straight there instead of the title->walk
      // flight, and close the dropdown behind you same as picking a real
      // destination normally would.
      flyToLocation(route);
      mainMenuListEl?.classList.add('collapsed');
    } else {
      startTransition(route);
    }
  });
});

// Social links (Instagram/Twitter/LinkedIn) - all three now have real hrefs
// (index.html) and just navigate normally, no JS needed.
const socialLinksEl = document.getElementById('social-links');

// Explore-nav (</> arrows) - see flyToLocation/findAdjacentExploreRoute
// above for the actual cycling logic. Buttons themselves stay in the DOM at
// all times; #explore-nav's .hidden class (toggled by show/hideExploreNav)
// is what controls visibility.
const exploreNavEl = document.getElementById('explore-nav');
document.getElementById('explore-nav-prev')?.addEventListener('click', () => {
  if (currentExploreIndex === -1) return;
  const adjacent = findAdjacentExploreRoute(currentExploreIndex, -1);
  if (adjacent) flyToLocation(adjacent.route);
});
document.getElementById('explore-nav-next')?.addEventListener('click', () => {
  if (currentExploreIndex === -1) return;
  const adjacent = findAdjacentExploreRoute(currentExploreIndex, 1);
  if (adjacent) flyToLocation(adjacent.route);
});

// Bloom pass - see postprocessing.js for the why. Constructed with the
// perspective camera; renderPass.camera gets swapped to titleScreen.camera
// in tick() below while in title mode, same composer/bloom settings either
// way.
const post = createPostProcessing(renderer, scene, camera);

initLoadingUI();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  titleScreen.onResize();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let elapsed = 0; // accumulated from the same clamped delta tick() uses, so the atmosphere's uTime doesn't jump if a tab-switch stalls a frame

// world.js's fog is tuned for the walkable area (near=32 clear, far=55 to
// hide the horizon seam) - that's ~30 units from a player standing near the
// center. The title camera sits CAMERA_DISTANCE units (45, see
// titleScreen.js) off the building on a diagonal, so its actual distance to
// the building is well past 55 - the whole thing was rendering almost pure
// fog color, which is what "nothing is visible" was actually showing.
// Captured once here (buildWorld sets scene.fog synchronously, before this
// runs) and toggled off for the title camera's render, back on for walk
// mode's.
const streetFog = scene.fog;

// Debug position readout, back per your ask - for grabbing an exact spawn
// point in FURNISHEDSCENE915.glb's coordinate space (the current spawn is
// just a rough edge-of-bounding-box guess). See the comment in index.html -
// delete the #debug-pos div (index.html + style.css) and this block once
// you've picked a spot and don't need it anymore. Doubles as the title-
// screen hover readout above while mode === 'title'.
function updatePositionDebug() {
  if (!debugPosEl || !controls) return;
  const p = controls.camera.position;
  const yawDeg = THREE.MathUtils.radToDeg(controls.yaw).toFixed(0);
  let text = `x: ${p.x.toFixed(2)}\ny: ${p.y.toFixed(2)}\nz: ${p.z.toFixed(2)}\nyaw: ${yawDeg}°`;
  text += `\nstreet: ${streetSceneStatus.state} ${streetSceneStatus.detail}`;
  debugPosEl.textContent = text;
}

function tick() {
  const delta = Math.min(clock.getDelta(), 0.1); // clamp so tab-switch stalls don't teleport the player
  elapsed += delta;
  flickerUniforms.uTime.value = elapsed; // drives every emissive sign's flicker shader at once, see shading.js

  // Bind the title screen's menu-sign raycast targets as soon as the street
  // mesh is in the scene - can't do this at construction time above since
  // the street loads async (see world.js) and the sign nodes don't exist
  // until then.
  if (!signsBound && streetSceneStatus.state === 'loaded') {
    titleScreen.bindSigns(streetScene);
    signsBound = true;
  }
  // Same lazy-bind pattern for the record player - vinylInteraction only
  // exists once you're in walk mode, and (like the signs above) can't
  // resolve its target node until the street mesh has actually loaded.
  if (vinylInteraction && !vinylBound && streetSceneStatus.state === 'loaded') {
    vinylInteraction.bindTarget(streetScene);
    vinylBound = true;
  }

  // Orbs/smoke/stars - moved out of the walk-only branch so the stars
  // actually twinkle on the title screen too (that's specifically what got
  // asked for), not just once you're in walk mode. Orbs/smoke tag along for
  // free - updating their uniforms/puff positions is cheap regardless of
  // whether they're in view from the title camera's tight crop.
  updateAtmosphere?.(elapsed, delta);

  if (mode === 'walk') {
    // Fog off for the DURATION of the flight, not just title mode - same
    // underlying issue as the original "nothing is visible" title-screen
    // bug (see streetFog comment below): the flight starts at the title
    // camera's position, which is well past fog's far=55 distance from the
    // nearby geometry, so turning on the normal walk fog immediately (as
    // this used to do) washed the whole first part of the flight out in
    // solid fog color before clearing as the camera got close - that's
    // "that fog thing." Only switches back to the real fog once
    // `transition` clears (flight actually finished).
    scene.fog = transition ? null : streetFog;
    // updateTransition() returns whether titleScreen.camera should render
    // THIS frame - read directly from the return value rather than
    // inspecting `transition` afterward, since a Home flight that finishes
    // on this exact frame nulls `transition` (and mode/controls along with
    // it, via finishReturnToTitle) before returning, which would otherwise
    // make the very last frame of the flight render with the WRONG camera.
    const orthoActive = updateTransition(delta);
    controls?.update(delta); // null for one frame if a Home flight just finished above - no-ops itself while locked either way
    vinylInteraction?.update(delta); // no-ops unless a lock-in/out transition is in progress
    updateExploreNavVisibility(); // hides the </> arrows the moment you move away from an Explore spot
    updatePositionDebug();

    post.tiltShiftPass.enabled = orthoActive;
    post.renderPass.camera = orthoActive ? titleScreen.camera : camera;
  } else {
    scene.fog = null;
    post.tiltShiftPass.enabled = true;
    titleScreen.update(delta);
    post.renderPass.camera = titleScreen.camera;
  }
  post.composer.render();

  requestAnimationFrame(tick);
}

tick();
