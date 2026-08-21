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
// "popping up when you enter any of the explore mode spaces for the first
// time" - set the instant the FIRST title->walk flight starts (startTransition
// below), so a rapid double-click can't queue it twice; the bubble itself
// only actually shows once that flight lands (see showWelcomeBubble() and
// its call site in updateTransition). Session-only (a plain JS flag, not
// localStorage) - reloading the page counts as a fresh "first time" again,
// same lightweight choice already made for other "have you seen this
// once" state in this project.
let hasEnteredWalkModeBefore = false;

const debugPosEl = document.getElementById('debug-pos');
const vinylExitBtn = document.getElementById('vinyl-exit-btn');
vinylExitBtn?.addEventListener('click', () => vinylInteraction?.unlock());

const welcomeBubbleEl = document.getElementById('welcome-bubble');
const WELCOME_BUBBLE_AUTO_DISMISS_MS = 8000;
let welcomeBubbleDismissTimer = null;
function dismissWelcomeBubble() {
  if (!welcomeBubbleEl) return;
  welcomeBubbleEl.classList.remove('visible');
  clearTimeout(welcomeBubbleDismissTimer);
}
function showWelcomeBubble() {
  if (!welcomeBubbleEl) return;
  welcomeBubbleEl.classList.remove('hidden');
  // rAF so the .hidden->.visible swap actually transitions (opacity/
  // transform) instead of snapping in - same reason .hidden and .visible
  // are two separate classes here rather than one, display:none can't be
  // animated, so this has to start from a "display:flex but opacity:0"
  // frame first.
  requestAnimationFrame(() => welcomeBubbleEl.classList.add('visible'));
  clearTimeout(welcomeBubbleDismissTimer);
  welcomeBubbleDismissTimer = setTimeout(dismissWelcomeBubble, WELCOME_BUBBLE_AUTO_DISMISS_MS);
}
// Click the bubble itself to dismiss early - it's not blocking anything
// (pointer-events only turn on once .visible, see style.css), just a
// courtesy for anyone who reads fast and wants it gone sooner.
welcomeBubbleEl?.addEventListener('click', dismissWelcomeBubble);
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
// Portfolio gallery - the flat 2D side of the Portfolio submenu, separate
// from the 3D Explore side (LOCATIONS below) entirely. Maps each
// data-route to the public/portfolio/<slug>/ folder + manifest.json key
// built by the optimize/transcode pass (see that folder's history - 177
// images resized/re-encoded, 894MB of raw phone/screen-recording video
// compressed down to 21MB across 14 clips). Title kept here rather than
// derived from the route string since "3d-modeling" -> "3D Modeling" etc.
// isn't a clean mechanical transform.
const PORTFOLIO_CATEGORIES = {
  'portfolio-illustration': { slug: 'illustration', title: 'Illustration' },
  'portfolio-graphic-design': { slug: 'graphic-design', title: 'Graphic Design' },
  'portfolio-3d-modeling': { slug: '3d', title: '3D Modeling' },
  'portfolio-merchandise-design': { slug: 'merchandise', title: 'Merchandise Design' },
  'portfolio-dynamics': { slug: 'dynamics', title: 'Dynamics' },
};

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
// "lets re order the menu so its records, archive, prints, then packaging.
// i dont like how its not in horizontal order" - matches index.html's
// submenu list order (kept in sync, see the comment above LOCATIONS).
const EXPLORE_ROUTE_ORDER = ['explore-records', 'explore-archive-shop', 'explore-prints-figures', 'explore-packaging'];

// "the transition between the archive and vinyl store goes through the
// wall" - there's no real wall collision anywhere in this project
// (controls.js is explicit about that: just a world-radius/X_MAX/Z_MIN
// clamp, no per-wall geometry), and flyToLocation below has always done a
// straight two-point lerp with controls locked - completely blind to
// anything in between. Between these two specific spots that straight line
// cuts across a wall. Not a general nav-mesh fix (that's the "reverted,
// came out broken" Octree/Capsule road controls.js already warns off of) -
// just a manual bend point for this one pair, taken directly from the
// route you walked in the screen recording (debug overlay read a steady
// x:-6.05 the whole second half, from z:-18.9 up to z:-14.64) - going
// through roughly (-6.05, -18.9) instead of cutting straight from one spot
// to the other keeps the flight on the same side of the wall the whole
// way. Keyed both directions since flyToLocation runs from either end.
const ROUTE_WAYPOINTS = {
  'explore-archive-shop|explore-records': [{ x: -6.05, y: 1.3, z: -18.9 }],
  'explore-records|explore-archive-shop': [{ x: -6.05, y: 1.3, z: -18.9 }],
};

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
  // change there. collapseMainMenu() (not a bare .add('collapsed')) so any
  // submenu left open from the title screen's own copy of this list starts
  // closed the first time you open the walk-mode dropdown too.
  collapseMainMenu();
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

  // Captured now (flight start), not read later at completion - mode is
  // already 'walk' by the time this flight lands regardless of whether it
  // was your first entry or not, so "was this actually the first one" has
  // to be decided here while we still know.
  const showWelcome = !hasEnteredWalkModeBefore;
  hasEnteredWalkModeBefore = true;

  transition = {
    t: 0,
    fromPos, fromQuat,
    toPos, toQuat, toFov,
    hasOrthoPhase: true,
    handoffT: ORTHO_PHASE_FRACTION,
    handoffFov,
    switched: false,
    routeKey,
    showWelcome,
  };

  // Record player click-to-lock (vinylInteraction.js) - see that file for
  // the full writeup. onLocked is the hook for the vinyl animation you're
  // going to provide separately; still logging for now so there's something
  // to see in devtools until that exists, plus now also showing the "back
  // to walkaround" button (top right, see index.html/style.css) per your
  // ask - Escape already exited this view, but nothing on screen told you
  // that was possible, so this makes the same exit visible/clickable.
  vinylInteraction = new VinylInteraction(camera, renderer.domElement, controls, {
    onLocked: () => {
      console.log('[vinyl interaction] locked in - vinyl animation hook goes here');
      vinylExitBtn?.classList.remove('hidden');
    },
    onUnlocked: () => {
      console.log('[vinyl interaction] unlocked, back to normal walk control');
      vinylExitBtn?.classList.add('hidden');
    },
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
function flyToLocation(routeKey, fromRouteKey) {
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

  // See ROUTE_WAYPOINTS above - most pairs have no entry and fly straight
  // (unchanged behavior), a couple of specific pairs bend through a manual
  // point instead of cutting through a wall. fromRouteKey is only passed by
  // the </> Explore-nav arrows (the only caller that reliably knows which
  // spot it's leaving FROM) - falls back to a plain 2-point path otherwise.
  const bend = fromRouteKey && ROUTE_WAYPOINTS[`${fromRouteKey}|${routeKey}`];
  const pathPoints = [fromPos, ...(bend ? bend.map((p) => new THREE.Vector3(p.x, p.y, p.z)) : []), toPos];

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
    pathPoints: pathPoints.length > 2 ? pathPoints : null,
  };
}

// Piecewise-linear position along pathPoints at eased-progress t (0-1),
// parameterized by cumulative segment DISTANCE rather than point count - so
// a short bend segment doesn't get the same time-share as a long straight
// one, which would read as a speed hitch. Only used when a transition
// actually has a bend (see ROUTE_WAYPOINTS/flyToLocation above); the plain
// 2-point case in updateTransition skips this entirely.
function positionAlongPath(pathPoints, t) {
  let total = 0;
  const segLengths = [];
  for (let i = 0; i < pathPoints.length - 1; i++) {
    const d = pathPoints[i].distanceTo(pathPoints[i + 1]);
    segLengths.push(d);
    total += d;
  }
  if (total === 0) return pathPoints[0].clone();
  let remaining = t * total;
  for (let i = 0; i < segLengths.length; i++) {
    if (remaining <= segLengths[i] || i === segLengths.length - 1) {
      const segT = segLengths[i] === 0 ? 0 : THREE.MathUtils.clamp(remaining / segLengths[i], 0, 1);
      return pathPoints[i].clone().lerp(pathPoints[i + 1], segT);
    }
    remaining -= segLengths[i];
  }
  return pathPoints[pathPoints.length - 1].clone();
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

    if (transition.pathPoints) {
      camera.position.copy(positionAlongPath(transition.pathPoints, t));
    } else {
      camera.position.lerpVectors(transition.fromPos, transition.toPos, t);
    }
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
    const shouldShowWelcome = transition.showWelcome; // flyToLocation's transitions never set this - stays undefined/falsy there
    transition = null;
    controls.locked = false; // hand control back to WASD/drag-look, camera is already exactly at the spawn pose
    activateExploreNavIfApplicable(finishedRoute);
    if (shouldShowWelcome) showWelcomeBubble();
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
  // Same "no additional drop downs" reset as collapseMainMenu() below -
  // landing back on the title screen with Portfolio still expanded from
  // wherever you left it in walk mode would be the same stuck-open bug.
  allSubmenus.forEach((el) => el.classList.remove('open'));
  document.getElementById('menu-home-item')?.classList.add('hidden');
  socialLinksEl?.classList.remove('hidden');
  vinylExitBtn?.classList.add('hidden'); // defensive - vinylInteraction.dispose() above didn't fire onUnlocked
  dismissWelcomeBubble(); // in case you hit Home while it was still up
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

const allSubmenus = document.querySelectorAll('#main-menu-list .has-submenu');

// "dont keep the menu open always open it to the regular base subjects. no
// additional drop downs" - closing the list used to leave whichever
// submenu (Portfolio/Explore) you'd last expanded still marked .open, so
// reopening the dropdown later popped straight back to wherever you left
// it instead of the plain base-level list. Every place that collapses the
// list now also resets every submenu closed, so it always reopens fresh.
function collapseMainMenu() {
  mainMenuListEl?.classList.add('collapsed');
  allSubmenus.forEach((el) => el.classList.remove('open'));
}

// Logo click - only does anything in walk mode (title screen already shows
// the list permanently, no toggle needed there). Same collapsed/expanded
// mechanics as the Portfolio/Explore submenus below, just one level up.
document.getElementById('main-menu-logo')?.addEventListener('click', () => {
  if (mode !== 'walk') return;
  if (mainMenuListEl?.classList.contains('collapsed')) {
    mainMenuListEl.classList.remove('collapsed');
  } else {
    collapseMainMenu();
  }
});

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

// Portfolio gallery - fetch-once-cache-forever manifest (built at build
// time by the optimize script, not something that changes at runtime), a
// grid of tiles, and a lightbox for the full-size view. Lives on top of
// whichever mode (title/walk) was already showing - doesn't touch camera,
// scene.fog, or any of the 3D transition machinery above at all.
const portfolioGalleryEl = document.getElementById('portfolio-gallery');
const portfolioGalleryTitleEl = document.getElementById('portfolio-gallery-title');
const portfolioGalleryGridEl = document.getElementById('portfolio-gallery-grid');
const portfolioGalleryCloseBtn = document.getElementById('portfolio-gallery-close');
const portfolioLightboxEl = document.getElementById('portfolio-lightbox');
const portfolioLightboxContentEl = document.getElementById('portfolio-lightbox-content');
const portfolioLightboxCloseBtn = document.getElementById('portfolio-lightbox-close');

let portfolioManifestPromise = null;
function getPortfolioManifest() {
  if (!portfolioManifestPromise) {
    portfolioManifestPromise = fetch('/portfolio/manifest.json').then((r) => r.json());
  }
  return portfolioManifestPromise;
}

function isVideoPath(path) {
  return /\.(mp4|mov|webm)$/i.test(path);
}

function openPortfolioLightbox(path) {
  portfolioLightboxContentEl.innerHTML = '';
  if (isVideoPath(path)) {
    const video = document.createElement('video');
    video.src = path;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    portfolioLightboxContentEl.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = path;
    portfolioLightboxContentEl.appendChild(img);
  }
  portfolioLightboxEl.classList.remove('hidden');
}

function closePortfolioLightbox() {
  portfolioLightboxEl.classList.add('hidden');
  // Stop playback rather than leaving a hidden video running - pause
  // before clearing so there's no stray audio for a frame.
  portfolioLightboxContentEl.querySelector('video')?.pause();
  portfolioLightboxContentEl.innerHTML = '';
}

async function openPortfolioGallery(route) {
  const category = PORTFOLIO_CATEGORIES[route];
  if (!category) return;

  portfolioGalleryTitleEl.textContent = category.title;
  portfolioGalleryGridEl.innerHTML = '';
  portfolioGalleryEl.classList.remove('hidden');

  const manifest = await getPortfolioManifest();
  const items = manifest[category.slug] || [];

  for (const path of items) {
    const tile = document.createElement('div');
    tile.className = 'portfolio-tile';
    if (isVideoPath(path)) {
      tile.classList.add('is-video');
      const video = document.createElement('video');
      video.src = path;
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      tile.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = path;
      img.loading = 'lazy';
      tile.appendChild(img);
    }
    tile.addEventListener('click', () => openPortfolioLightbox(path));
    portfolioGalleryGridEl.appendChild(tile);
  }
}

function closePortfolioGallery() {
  portfolioGalleryEl.classList.add('hidden');
  closePortfolioLightbox();
}

portfolioGalleryCloseBtn?.addEventListener('click', closePortfolioGallery);
portfolioLightboxCloseBtn?.addEventListener('click', closePortfolioLightbox);
// Click the dimmed backdrop (not the media itself) to dismiss the lightbox.
portfolioLightboxEl?.addEventListener('click', (e) => {
  if (e.target === portfolioLightboxEl) closePortfolioLightbox();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!portfolioLightboxEl.classList.contains('hidden')) closePortfolioLightbox();
  else if (!portfolioGalleryEl.classList.contains('hidden')) closePortfolioGallery();
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

    // Portfolio submenu items open the flat gallery overlay instead of
    // flying anywhere in the 3D scene - checked before the LOCATIONS
    // fallthrough below since these routes intentionally have no
    // LOCATIONS entry (they were never meant to be 3D spots).
    //
    // "when youre in portfolio mode and then go back to main menu, it
    // doesnt work until you reload" - collapseMainMenu() was firing
    // unconditionally here, including on the TITLE screen, where the list
    // is meant to stay permanently open/uncollapsed (see the logo-click
    // handler above, which only toggles .collapsed in walk mode - "title
    // screen already shows the list permanently, no toggle needed there").
    // Collapsing it from title mode set #main-menu-list.collapsed
    // (pointer-events: none, see style.css), and nothing on the title
    // screen ever un-collapses it again - the logo click handler no-ops
    // outside walk mode - so the whole corner menu went permanently dead
    // the moment you opened a Portfolio category from the title screen,
    // even after closing the gallery. Only collapse in walk mode, matching
    // the logo handler's own guard.
    if (PORTFOLIO_CATEGORIES[route]) {
      openPortfolioGallery(route);
      if (mode === 'walk') collapseMainMenu();
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
      collapseMainMenu();
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
//
// "arrows should align with the physical direction" - the < button now
// steps FORWARD through EXPLORE_ROUTE_ORDER (+1) and > steps BACKWARD (-1),
// the opposite of what their glyphs/DOM order would suggest on their own.
// That's intentional, not a typo: EXPLORE_ROUTE_ORDER is sorted by
// ascending LOCATIONS.x (records -5.61 -> archive -2.74 -> prints 3.66 ->
// packaging 10.25, left to right in world space), but the camera at each
// spot is turned to roughly FACE the wall/shelf it's framing rather than
// facing down that x-axis - so walking toward a higher-x neighbor reads as
// stepping to your on-screen LEFT from inside that facing, not your right.
// Swapping the bindings (rather than reversing EXPLORE_ROUTE_ORDER itself,
// which would undo the "records, archive, prints, packaging" menu order
// just set to match the horizontal layout) keeps the dropdown/menu order
// and the arrow behavior each matching their own separate "what feels
// right" - the menu list top-to-bottom, the arrows on-screen left/right.
const exploreNavEl = document.getElementById('explore-nav');
document.getElementById('explore-nav-prev')?.addEventListener('click', () => {
  if (currentExploreIndex === -1) return;
  const adjacent = findAdjacentExploreRoute(currentExploreIndex, 1);
  if (adjacent) flyToLocation(adjacent.route, EXPLORE_ROUTE_ORDER[currentExploreIndex]);
});
document.getElementById('explore-nav-next')?.addEventListener('click', () => {
  if (currentExploreIndex === -1) return;
  const adjacent = findAdjacentExploreRoute(currentExploreIndex, -1);
  if (adjacent) flyToLocation(adjacent.route, EXPLORE_ROUTE_ORDER[currentExploreIndex]);
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
// "slightly dynamic" - a slow, subtle lightness breathe on the fog color,
// not a hue change. Base HSL pulled from the color world.js just set
// (0x4c4657) rather than hardcoded again here, so this stays in sync if
// that ever changes. Amplitude bumped 0.04 -> 0.1 per "slightly less
// black, maybe multi colors? like some black some dark grey in the fog" -
// clarified as shades of grey, not literal hue variation, so this stays a
// pure lightness drift (h/s still locked to base). With the fog now black
// (l=0), the sine still swings +/-0.1 but negative lightness just clamps
// back to black, so in practice this reads as breathing between black and
// a clearly-dark-grey (l up to ~0.1) rather than two shades of near-black -
// the "some black, some dark grey" look, just automatic instead of
// hand-picking two colors to alternate between.
const fogBaseHSL = { h: 0, s: 0, l: 0 };
streetFog.color.getHSL(fogBaseHSL);
const FOG_DRIFT_PERIOD = 38; // seconds per full cycle
const FOG_DRIFT_AMOUNT = 0.1; // +/- lightness

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
    if (!transition) {
      // Drift lightness only - hue/saturation stay locked to the base
      // purple-grey so this never reads as a color CHANGE, just a soft
      // breathing in how thick the fog feels.
      const drift = Math.sin((elapsed / FOG_DRIFT_PERIOD) * Math.PI * 2) * FOG_DRIFT_AMOUNT;
      streetFog.color.setHSL(fogBaseHSL.h, fogBaseHSL.s, fogBaseHSL.l + drift);
    }
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
