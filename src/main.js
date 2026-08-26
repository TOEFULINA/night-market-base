import * as THREE from 'three';
import { Controls } from './controls.js';
import { buildWorld, streetSceneStatus, streetScene, albumCoverPlanes, recordDiscRef } from './world.js';
import { initLoadingUI, initKtx2Loader } from './loader.js';
import { TitleScreen } from './titleScreen.js';
import { createPostProcessing, grainUniforms } from './postprocessing.js';
import { flickerUniforms } from './shading.js';
import { VinylInteraction } from './vinylInteraction.js';

const canvas = document.getElementById('scene');

const scene = new THREE.Scene();

// Declared up here (not down by the renderer where the rest of the mobile
// gating lives) since the camera's FOV needs it too, and the camera is
// constructed first.
const IS_MOBILE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
// Vertical FOV. Went 70 -> 55 -> 45 on desktop. "camera FOV on phone should
// be bigger" - 45 was tuned for a mouse-controlled desktop view; held a foot
// or so from your face, a phone screen makes the same FOV read as more
// zoomed-in/claustrophobic than the equivalent desktop framing, especially
// in the narrower shop aisles. Wider on mobile only - desktop's 45 is
// unchanged.
const CAMERA_FOV = IS_MOBILE ? 62 : 45;

const camera = new THREE.PerspectiveCamera(
  CAMERA_FOV,
  window.innerWidth / window.innerHeight,
  0.1,
  // Was a flat 2500 with a "TEMP... pull this back down once you've seen it
  // running" note. Measured the real extents rather than guessing again:
  // mobile scene geometry reaches ~28 units from origin, the star shell sits
  // at radius 140 (atmosphere.js's STAR_RADIUS), and the player stays inside
  // WORLD_RADIUS=30 - so the furthest anything can ever be from the camera is
  // ~170. 250 clears that with real margin while being 10x tighter than 2500,
  // which buys back a lot of depth-buffer precision (z-fighting headroom) and
  // lets frustum culling discard more.
  //
  // Mobile ONLY. Desktop's DOF shader linearizes depth using uCameraFar (see
  // postprocessing.js), so changing far there would move where the distance
  // blur kicks in - i.e. it'd visibly change the desktop look, which you
  // asked to leave alone. Mobile has DOF off entirely now, so there's nothing
  // for this to interact with there.
  IS_MOBILE ? 250 : 2500
);
// Layer 1 = "walk-mode-only" geometry (currently just the new ground plane
// and wall+building from TRY6_SCENE.glb, see world.js's TITLE_HIDDEN_NODE_NAMES) -
// enabling it here on top of the default layer 0 means this camera renders
// everything as normal. titleScreen.js's OrthographicCamera deliberately
// does NOT enable layer 1, so those two nodes only ever show up in walk
// mode, never behind the title screen's sign-building view.
camera.layers.enable(1);

// Mobile crash root-cause part 2: the GLB texture swap (see world.js's
// IS_MOBILE/modelPath) cut decoded texture VRAM from ~1GB to ~270MB, but
// the actual Safari crash ("A problem repeatedly occurred") still happened
// right as loading hit 100% - i.e. the exact moment everything gets
// uploaded to the GPU AND the composer/shadow-map render targets below get
// allocated for the first time. Those render targets are framebuffer
// memory, completely separate from texture VRAM, and none of them were
// scaled down for mobile before now - antialias MSAA buffers, the full
// EffectComposer ping-pong pair, and a 2048x2048 shadow map, all sized off
// devicePixelRatio. Cutting all three for mobile specifically. (IS_MOBILE
// itself is declared up by the camera now, not here - see its comment.)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_MOBILE, powerPreference: 'high-performance' });
// cap pixel ratio - rendering at full 3x retina resolution on a phone is a
// straightforward, easy-to-miss way to tank frame rate for no visible gain.
// Capped further to 1x on mobile - every full-screen render target below
// (composer buffers, shadow map, depth target) scales with this squared,
// so 2x -> 1x is a 4x cut in framebuffer memory on top of the texture cut.
// "i actually love the pixely edges on the mesh... like nintendo DS, so early
// video game. we can make it even more of that if it helps" - and it does help,
// which is the nice part: this is a deliberate look AND the single cheapest
// perf lever available. Rendering below 1.0 means the GPU shades fewer pixels,
// and fill cost scales with pixel COUNT (area), so 0.65 renders about 42% of
// the pixels of 1.0. The chunky stair-stepped mesh edges you like are the
// aliasing that falls out of that low internal resolution, then gets upscaled
// to the screen - style.css sets image-rendering:pixelated on #scene for
// mobile so the upscale stays hard-edged and blocky instead of being smoothed
// into mush by the browser's default bilinear filtering.
// Lower = chunkier + faster. Desktop is untouched.
const MOBILE_PIXEL_SCALE = 0.5;
renderer.setPixelRatio(IS_MOBILE ? MOBILE_PIXEL_SCALE : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Real-time shadows, turned on per your call - the flat/shadowless look
// was the actual complaint, and this scene is small/compact enough
// (~41x45 units, not the old sprawling street) that a single sun shadow
// map is a reasonable cost. PCFSoftShadowMap = soft edges (a few samples
// blended) instead of hard-edged PCF - a bit more GPU cost per shadowed
// pixel, but reads far less "video-gamey"/aliased than the hard default.
// See world.js for the actual light's shadow-camera setup (tightly fit to
// the scene bounds, not this file).
// Disabled entirely on mobile - a 2048x2048 depth render target was one of
// the uncounted framebuffer costs above, and the scene's baked textures
// already carry their own lighting/shadow information, so this is a real
// but comparatively minor visual tradeoff for not crashing.
renderer.shadowMap.enabled = !IS_MOBILE;
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

// KTX2/Basis textures need the GPU probed once up front so the transcoder
// knows which compressed format to decode into (BC7/ASTC/ETC - varies by
// device). loader.js has always exported this, but nothing ever called it,
// which means any .ktx2-textured glb would have failed to load. Harmless
// while every model is still plain JPEG/PNG - KTX2Loader only engages for
// images that are actually .ktx2 - so it's safe to wire up ahead of the
// encoded files existing.
initKtx2Loader(renderer);

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
let coverPlanesBound = false;
let recordDiscBound = false;
// "popping up when you enter any of the explore mode spaces for the first
// time" - set the instant the FIRST title->walk flight starts (startTransition
// below), so a rapid double-click can't queue it twice; the bubble itself
// only actually shows once that flight lands (see showWelcomeBubble() and
// its call site in updateTransition). Session-only (a plain JS flag, not
// localStorage) - reloading the page counts as a fresh "first time" again,
// same lightweight choice already made for other "have you seen this
// once" state in this project.
let hasEnteredWalkModeBefore = false;

const vinylExitBtn = document.getElementById('vinyl-exit-btn');
vinylExitBtn?.addEventListener('click', () => vinylInteraction?.unlock());
const vinylDebugPosEl = document.getElementById('vinyl-debug-pos'); // temporary - see index.html's comment on this element
const debugPosEl = document.getElementById('debug-pos'); // back per your ask, see index.html's comment on this element
const touchControlsEl = document.getElementById('touch-controls'); // mobile joystick - see updateTouchControlsVisibility() below

// Vinyl sample booth - "i want to be able to play songs and swap out the
// cover. like a booth where u can sample." Filler content for now ("can
// you set it up with fillers, ill provide clips and stuff") - synthesized
// placeholder tones + generated placeholder cover images, same file
// naming scheme real ones would use, so swapping in real content later is
// just replacing these files and updating title/artist text, no code
// changes needed.
// Real tracks - titles/artists parsed from the uploaded filenames ("song
// name - artist" per your correction). Covers still point at the filler
// placeholders (cover-1..4.jpg, cycling) until the real cover art arrives -
// swap those paths in per-track once it does. Audio trimmed to a 30s max
// clip (ffmpeg -t 30, re-encoded AAC 128k) - a few of the shorter ones
// (8 Feet Tall, Idiot, Put Up, Smoke You Out) were already under 30s so
// they're kept at their full original length instead of padded out.
// One note: you sent two files for the same song ("TELL ME NOW - DESS DIOR
// & BELLY GANG .m4a", 26s, and "Tell Me Now - Dess Dior & Belly Gang
// Kushington.m4a", 31s) - used the second/longer one since its artist
// credit looked more complete ("Kushington" spelled out); flag if that's
// the wrong pick and I'll swap in the other one instead.
const VINYL_TRACKS = [
  { title: '8 Feet Tall', artist: 'ErisThePlanet & Rico Nasty', cover: '/covers/8-feet-tall.jpg', audio: '/audio/sample-1.m4a' },
  { title: 'Burning Rubber', artist: 'Jordan Ward & Joony', cover: '/covers/burning-rubber.jpg', audio: '/audio/sample-2.m4a' },
  { title: 'Classy', artist: 'Joony & Tony Shhnow', cover: '/covers/classy.jpg', audio: '/audio/sample-3.m4a' },
  { title: 'Geezer', artist: 'ErisThePlanet', cover: '/covers/geezer.jpg', audio: '/audio/sample-4.m4a' },
  { title: 'Idiot', artist: 'Estelle Allen', cover: '/covers/idiot.jpg', audio: '/audio/sample-5.m4a' },
  { title: 'JJK', artist: 'Yuki Chiba & MGK', cover: '/covers/jjk.jpg', audio: '/audio/sample-6.m4a' },
  { title: 'Need It', artist: 'Joony', cover: '/covers/need-it.jpg', audio: '/audio/sample-7.m4a' },
  { title: 'No Chill', artist: 'Joony', cover: '/covers/no-chill.jpg', audio: '/audio/sample-8.m4a' },
  { title: 'OOOOOO', artist: 'Joony', cover: '/covers/oooooo.jpg', audio: '/audio/sample-9.m4a' },
  { title: 'Pimpin', artist: 'Joony, Larry June & Isaiah Falls', cover: '/covers/pimpin.jpg', audio: '/audio/sample-10.m4a' },
  { title: 'Put Up', artist: 'Anycia & Quavo', cover: '/covers/put-up.jpg', audio: '/audio/sample-11.m4a' },
  { title: 'Smoke You Out', artist: 'Anycia & Kalan.FrFr', cover: '/covers/smoke-you-out.jpg', audio: '/audio/sample-12.m4a' },
  { title: 'Tell Me Now', artist: 'Dess Dior & Belly Gang Kushington', cover: '/covers/tell-me-now.jpg', audio: '/audio/sample-13.m4a' },
  { title: 'Wassup', artist: 'Key! & DRAM', cover: '/covers/wassup.jpg', audio: '/audio/sample-14.m4a' },
  { title: 'We Got That', artist: 'Black Moss', cover: '/covers/we-got-that.jpg', audio: '/audio/sample-15.m4a' },
  { title: 'Zendaya', artist: 'Chris Patrick', cover: '/covers/zendaya.jpg', audio: '/audio/sample-16.m4a' },
  { title: 'Zombie', artist: 'Estelle Allen', cover: '/covers/zombie.jpg', audio: '/audio/sample-17.m4a' },
];

const vinylBoothEl = document.getElementById('vinyl-booth');
const vinylBoothTitleEl = document.getElementById('vinyl-booth-title');
const vinylBoothArtistEl = document.getElementById('vinyl-booth-artist');
const vinylBoothPlayBtn = document.getElementById('vinyl-booth-play');
const vinylBoothAudioEl = document.getElementById('vinyl-booth-audio');
let vinylTrackIndex = 0;

// "these are going to serve as the cover" - the floating 2D UI cover card
// is gone (see world.js's albumCoverPlanes writeup); cover art now lands
// as a texture directly on the two mesh planes sitting at the record
// player. One shared loader/cache so flipping back and forth between the
// same few filler tracks doesn't refetch the image every time.
const coverTextureLoader = new THREE.TextureLoader();
const coverTextureCache = new Map();
function loadCoverTexture(url) {
  if (coverTextureCache.has(url)) return coverTextureCache.get(url);
  const tex = coverTextureLoader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  // "UVs are rotated and mirrored, should be turned once counterclockwise
  // and mirrored" - the ALBUM_COVERS.glb planes' own UVs come in off from
  // whatever orientation Blender's plane primitive uses by default. Fixing
  // it on the texture (rotate around its own center, then flip U) instead
  // of touching the mesh UVs directly - keeps this self-contained to
  // cover art specifically, doesn't risk the plane geometry itself.
  tex.wrapS = THREE.RepeatWrapping; // needed for the negative repeat.x flip below
  tex.center.set(0.5, 0.5);
  tex.rotation = (3 * Math.PI) / 2; // "rotate counterclockwise twice" more on top of the first 90° - 270° total
  tex.repeat.x = -1; // mirror horizontally
  coverTextureCache.set(url, tex);
  return tex;
}
// "current" plane shows the track actually loaded; "next" previews
// whatever loadVinylTrack(index+1) would land on, so the booth's ">"
// button isn't a total surprise.
function applyCoverPlaneTextures() {
  const currentTrack = VINYL_TRACKS[vinylTrackIndex];
  const nextTrack = VINYL_TRACKS[(vinylTrackIndex + 1) % VINYL_TRACKS.length];
  if (albumCoverPlanes.current) albumCoverPlanes.current.material.map = loadCoverTexture(currentTrack.cover);
  if (albumCoverPlanes.next) albumCoverPlanes.next.material.map = loadCoverTexture(nextTrack.cover);
  if (albumCoverPlanes.current) albumCoverPlanes.current.material.needsUpdate = true;
  if (albumCoverPlanes.next) albumCoverPlanes.next.material.needsUpdate = true;
}

// Loads a track into the booth UI (title/artist/audio src + the two cover
// mesh planes) and optionally starts it playing. `replayDrop` is false for
// the very first track (the record already dropped as part of approaching/
// locking in, see vinylInteraction.js's _lockIn) and true for every
// subsequent swap (a "new record" going on, so it drops again).
function loadVinylTrack(index, { replayDrop = true, autoplay = true } = {}) {
  vinylTrackIndex = ((index % VINYL_TRACKS.length) + VINYL_TRACKS.length) % VINYL_TRACKS.length;
  const track = VINYL_TRACKS[vinylTrackIndex];

  vinylBoothTitleEl.textContent = track.title;
  vinylBoothArtistEl.textContent = track.artist;
  applyCoverPlaneTextures();

  if (replayDrop) vinylInteraction?.replayDrop();

  vinylBoothAudioEl.src = track.audio;
  if (autoplay) {
    vinylBoothAudioEl.play().catch(() => {}); // autoplay can be blocked in some contexts - not worth surfacing an error over, the play button still works
  }
  updateVinylPlayButton();
}

function updateVinylPlayButton() {
  vinylBoothPlayBtn.innerHTML = vinylBoothAudioEl.paused ? '&#9654;' : '&#10074;&#10074;';
}

document.getElementById('vinyl-booth-prev')?.addEventListener('click', () => loadVinylTrack(vinylTrackIndex - 1));
document.getElementById('vinyl-booth-next')?.addEventListener('click', () => loadVinylTrack(vinylTrackIndex + 1));
vinylBoothPlayBtn?.addEventListener('click', () => {
  if (vinylBoothAudioEl.paused) vinylBoothAudioEl.play().catch(() => {});
  else vinylBoothAudioEl.pause();
});
vinylBoothAudioEl?.addEventListener('play', updateVinylPlayButton);
vinylBoothAudioEl?.addEventListener('pause', updateVinylPlayButton);
// "can we have the single vinyl on top of the player spin while music
// plays too" - vinylInteraction.js owns the actual per-frame rotation
// (setSpinning just flips a flag it reads in its own update() loop);
// 'ended' covers a clip finishing on its own without a manual pause.
vinylBoothAudioEl?.addEventListener('play', () => vinylInteraction?.setSpinning(true));
vinylBoothAudioEl?.addEventListener('pause', () => vinylInteraction?.setSpinning(false));
vinylBoothAudioEl?.addEventListener('ended', () => vinylInteraction?.setSpinning(false));

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
// Hidden while on the title screen - shown again once you're in walk mode,
// where it's the x/y/z/yaw/pitch debug readout.
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
  // "About Me" camera framing - debug-HUD coordinates from your two
  // screenshots looking up at ME.glb sitting on top of Loki: first pass
  // gave position/yaw (x:-15.13, y:1.30, z:-18.90, yaw:170°), second pass
  // (after pitch got added to the HUD - see updatePositionDebug) confirmed
  // the same spot within a few cm and added pitch:17°. Same
  // LOCATIONS/flyToLocation path every other menu destination uses, so
  // clicking "About" flies here the same way Explore items do.
  about: { x: -15.16, y: 1.3, z: -18.87, yawDeg: 170, pitchDeg: 17 },
  // Close-up on the vinyl wall display - "i want the camera to snap to this
  // wall display" - debug-HUD coordinates off your screenshot standing right
  // in front of it (x:-6.93, y:1.30, z:-13.57, yaw:270°, pitch:0°). Not an
  // Explore-menu stop, just a flyToLocation target for the click-to-zoom
  // interactive below (RECORD_WALL_NODE_NAMES) - not in EXPLORE_ROUTE_ORDER,
  // so activateExploreNavIfApplicable's </> arrows correctly stay hidden here.
  'record-wall-display': { x: -6.93, y: 1.3, z: -13.57, yawDeg: 270 },
};

// Real per-destination URLs - "i want diff places like portfolio pages to
// open in diff pages like url.com/graphic-design" instead of everything
// living only in in-memory JS state with one URL for the whole site.
// Portfolio categories reuse PORTFOLIO_CATEGORIES' own `slug` field
// directly (already existed for the /portfolio/<slug>/ manifest lookup) -
// this object only needs to cover everything else. 'home' is the title
// screen itself, mapped to the site root. 'contact' has no LOCATIONS entry
// yet (not wired - see README's "known gaps"), but gets a path here too so
// it starts working automatically the moment it IS wired, same as how
// EXPLORE_ROUTE_ORDER already tolerates a not-yet-wired entry above.
const ROUTE_PATHS = {
  home: '/',
  about: '/about',
  contact: '/contact',
  'explore-archive-shop': '/archive-shop',
  'explore-records': '/records',
  'explore-prints-figures': '/prints-figures',
  'explore-packaging': '/packaging',
};

function pathForRoute(route) {
  if (PORTFOLIO_CATEGORIES[route]) return `/${PORTFOLIO_CATEGORIES[route].slug}`;
  return ROUTE_PATHS[route] || null;
}

// Reverse of the above - what route (if any) does a URL path landed on
// (either typed directly or via browser back/forward) correspond to.
function routeForPath(pathname) {
  const slug = pathname.replace(/^\/|\/$/g, '');
  if (!slug) return 'home';
  const portfolioMatch = Object.entries(PORTFOLIO_CATEGORIES).find(([, v]) => v.slug === slug);
  if (portfolioMatch) return portfolioMatch[0];
  const otherMatch = Object.entries(ROUTE_PATHS).find(([, v]) => v === `/${slug}`);
  return otherMatch ? otherMatch[0] : null;
}

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
  hideAboutOverlay(); // defensive - can't actually be open yet on the title screen, but keep every flight's start state consistent

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
  if (debugPosEl && !IS_MOBILE) debugPosEl.style.display = ''; // back on for walk mode's x/y/z/yaw readout - dev-only tool, no reason to show visitors on mobile

  // Controls' constructor snaps camera.position/rotation straight to its
  // default spawn pose - the flight's END point when no per-route location
  // is given. If `routeKey` matches something in LOCATIONS above, override
  // both the target position AND controls.yaw/pitch with that instead so
  // controls.js picks up the right facing direction once it unlocks at the
  // end of the flight. pitchDeg is optional per LOCATIONS entry (defaults
  // to 0/dead level) - see flyToLocation's matching comment.
  controls = new Controls(camera, renderer.domElement);
  controls.locked = true;

  const location = routeKey ? LOCATIONS[routeKey] : null;
  let toPos;
  if (location) {
    toPos = new THREE.Vector3(location.x, location.y, location.z);
    controls.yaw = THREE.MathUtils.degToRad(location.yawDeg);
    controls.pitch = THREE.MathUtils.degToRad(location.pitchDeg ?? 0);
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
  //
  // "do NOT give the WASD notification if im going straight to about me.
  // about me is just a fixed camera not a walkaround" - 'about' never
  // counts as "your first walkaround" here (both for showing the bubble
  // THIS flight and for marking hasEnteredWalkModeBefore), so if About
  // happens to be the very first thing you click from the title screen,
  // the real WASD bubble still shows the first time you land somewhere
  // you can actually walk around, whenever that ends up being.
  const showWelcome = routeKey !== 'about' && !hasEnteredWalkModeBefore;
  if (routeKey !== 'about') hasEnteredWalkModeBefore = true;

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
  // the full writeup. onLocked now opens the sample booth (VINYL_TRACKS
  // above) instead of just logging - loads track 0 WITHOUT replaying the
  // drop (it already dropped once as part of the approach/lock-in itself,
  // see vinylInteraction.js's _lockIn). Also still showing the "back to
  // walkaround" button (top right, see index.html/style.css) per your
  // ask - Escape already exited this view, but nothing on screen told you
  // that was possible, so this makes the same exit visible/clickable.
  // Fresh instance above means a fresh (null) target - vinylBound gates the
  // tick loop's bindTarget() call (see below), so without resetting it here
  // every re-entry into walk mode after the first would silently skip
  // rebinding forever: the flag would already read true from the FIRST
  // entry, even though THIS instance has never had bindTarget() called on
  // it. Exactly the "works once, dead after you go back" bug - the record
  // player becomes permanently unclickable the moment you leave and
  // re-enter walk mode, since target stays null with no code path left to
  // fix it.
  vinylBound = false;
  recordDiscBound = false; // same reasoning as vinylBound above, for bindDisc()
  vinylInteraction = new VinylInteraction(camera, renderer.domElement, controls, {
    onLocked: () => {
      vinylExitBtn?.classList.remove('hidden');
      vinylDebugPosEl?.classList.remove('hidden');
      vinylBoothEl?.classList.remove('hidden');
      loadVinylTrack(0, { replayDrop: false });
    },
    onUnlocked: () => {
      vinylExitBtn?.classList.add('hidden');
      vinylDebugPosEl?.classList.add('hidden');
      vinylBoothEl?.classList.add('hidden');
      vinylBoothAudioEl.pause();
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
  hideAboutOverlay(); // re-shown below once this flight lands, only if the destination is 'about'

  const fromPos = camera.position.clone();
  const fromQuat = camera.quaternion.clone();
  const fromFov = camera.fov;

  controls.locked = true;

  const toPos = new THREE.Vector3(location.x, location.y, location.z);
  const toYaw = THREE.MathUtils.degToRad(location.yawDeg);
  // pitchDeg is optional per LOCATIONS entry - defaults to 0 (dead level)
  // for every spot that never specified one, same as this always hardcoded
  // to 0 before. See LOCATIONS' 'about' entry for why this needed adding:
  // "i need to be looking head angled exactly, not just the position."
  const toPitch = THREE.MathUtils.degToRad(location.pitchDeg ?? 0);
  controls.yaw = toYaw;
  controls.pitch = toPitch;
  const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(toPitch, toYaw, 0, 'YXZ'));

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

// Click-to-zoom display spots - click specific scene geometry to fly the
// camera in for a closer look, same flyToLocation() flight the Explore menu
// stops use. Lands with a free camera (flyToLocation's flight always ends
// with controls.locked = false, see updateTransition), so none of these need
// a lock-in/exit-button state machine like the vinyl booth - walking away
// again is just normal WASD.
//
// meshNames works when the clickable thing is one (or a couple) consolidated
// meshes - the vinyl wall's ~30 records are baked into a single
// VinylWall_Cylinder.023 mesh (same crate-shelf convention used everywhere
// else in this scene), so 3 node names cover the whole display. Node names
// already glTF-sanitized (dots stripped, see world.js's sanitizeGltfName).
// Resolved lazily off `streetScene` (see world.js) on the first click attempt
// rather than every frame - same idea as titleScreen.js's bindSigns, just
// click-triggered instead of per-tick, since this list never changes once
// the street mesh has loaded. (A `meshNames: null` "proximity" mode - raycast
// the whole scene, gate on distance alone - also went through this system
// briefly for a shelf whose books turned out to be dozens of separately
// auto-named meshes with nothing to group them by; removed per your ask, but
// resolveClickZoomMeshes below still supports it if that ever comes back.)
const CLICK_ZOOM_SPOTS = [
  { routeKey: 'record-wall-display', range: 6, meshNames: ['VinylWall_Cylinder023', 'VinylShelf_Cube001', 'VinylShelf_Cube180'] },
];
const clickZoomMeshCache = new Map(); // routeKey -> resolved meshes, only used by the meshNames strategy
const clickZoomRaycaster = new THREE.Raycaster();
const clickZoomPointer = new THREE.Vector2();

function resolveClickZoomMeshes(spot) {
  if (!spot.meshNames) return streetScene ? [streetScene] : null; // proximity mode - raycast everything
  if (clickZoomMeshCache.has(spot.routeKey)) return clickZoomMeshCache.get(spot.routeKey);
  if (!streetScene) return null;
  const found = spot.meshNames.map((name) => streetScene.getObjectByName(name)).filter((obj) => obj && obj.isMesh);
  if (found.length === 0) return null; // street may not have finished loading yet - try again next click
  if (found.length < spot.meshNames.length) {
    const missing = spot.meshNames.filter((name) => !streetScene.getObjectByName(name));
    console.warn(`[click zoom: ${spot.routeKey}] some meshNames did not resolve to meshes:`, missing);
  }
  clickZoomMeshCache.set(spot.routeKey, found);
  return found;
}

renderer.domElement.addEventListener('click', (e) => {
  if (mode !== 'walk' || controls?.locked !== false || !streetScene) return; // not walking freely - mid-flight, vinyl-locked, or still on the title screen

  const rect = renderer.domElement.getBoundingClientRect();
  clickZoomPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  clickZoomPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  clickZoomRaycaster.setFromCamera(clickZoomPointer, camera);

  for (const spot of CLICK_ZOOM_SPOTS) {
    const target = LOCATIONS[spot.routeKey];
    const dist = camera.position.distanceTo(new THREE.Vector3(target.x, target.y, target.z));
    if (dist > spot.range) continue; // too far away to "walk up and look" at this one - cheaper than raycasting first

    const meshes = resolveClickZoomMeshes(spot);
    if (!meshes || meshes.length === 0) continue;
    // Recursive only in proximity mode (meshes === [streetScene], a whole
    // subtree) - the named-mesh lists are already the exact leaf meshes.
    const hits = clickZoomRaycaster.intersectObjects(meshes, !spot.meshNames);
    if (hits.length === 0) continue;

    flyToLocation(spot.routeKey);
    return;
  }
});

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
  hideAboutOverlay();

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
    // About Me overlay - shows once the flight actually lands on 'about',
    // same "wait for arrival" timing as the welcome bubble/explore-nav
    // above, not fired the instant you click the menu item.
    if (finishedRoute === 'about') showAboutOverlay();
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
  vinylExitBtn?.classList.add('hidden'); // defensive - vinylInteraction.dispose() above didn't fire onUnlocked
  dismissWelcomeBubble(); // in case you hit Home while it was still up
  if (debugPosEl) debugPosEl.style.display = 'none';
}

// Corner nav overlay (PORTFOLIO / EXPLORE / CONTACT / ABOUT) - separate
// from the in-scene sign clicks above, this is the flat HTML/CSS menu from
// your mockup (index.html/style.css). Portfolio and Explore are dropdown
// parents (index.html's .has-submenu <li> wrapping a .menu-label + nested
// .submenu <ul>). "i also want the menu drop downs to only show up on
// hover" - these used to be click-to-toggle (a JS-driven .open class),
// now pure CSS :hover (see style.css's `.has-submenu:hover .submenu`
// rule) - no JS involved in opening/closing them at all anymore, they
// just follow the mouse in and back out. Subsection clicks still route
// through startTransition(routeKey) same as before - if that route has an
// entry in LOCATIONS above, it flies to that exact spot; otherwise it
// just logs, same "tell me the mapping" pattern as the unrouted signs
// above.
const mainMenuEl = document.getElementById('main-menu');
const mainMenuListEl = document.getElementById('main-menu-list');

function collapseMainMenu() {
  mainMenuListEl?.classList.add('collapsed');
}

// Touch devices: tap a dropdown parent to open it.
//
// The submenus above are opened purely by CSS :hover, which simply doesn't
// exist on a phone. iOS fakes it - the first tap on an element with a :hover
// rule applies that state, and it only clears when you tap somewhere else -
// so the menu half-works in a way that feels broken rather than obviously
// broken. Worse, that emulated hover means the first tap on PORTFOLIO gets
// swallowed opening the submenu, so it reads as an unresponsive menu.
//
// Explicit .open class on touch instead, toggled here and styled in the
// mobile media query in style.css. Desktop still uses :hover and never adds
// this class, so nothing changes there.
if (IS_MOBILE) {
  for (const label of document.querySelectorAll('#main-menu-list .menu-label')) {
    label.addEventListener('click', (e) => {
      const li = label.closest('.has-submenu');
      if (!li) return;
      // Stop this from also counting as a click on the menu behind it.
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = li.classList.contains('open');
      // Only one submenu open at a time - two expanded lists don't fit on a
      // phone screen next to each other.
      for (const other of document.querySelectorAll('#main-menu-list .has-submenu.open')) {
        other.classList.remove('open');
      }
      if (!wasOpen) li.classList.add('open');
    });
  }
  // Tapping any actual destination closes the dropdown behind it.
  for (const item of document.querySelectorAll('#main-menu-list li[data-route]')) {
    item.addEventListener('click', () => {
      for (const other of document.querySelectorAll('#main-menu-list .has-submenu.open')) {
        other.classList.remove('open');
      }
    });
  }
}

// Logo click - only does anything in walk mode (title screen already shows
// the list permanently, no toggle needed there).
document.getElementById('main-menu-logo')?.addEventListener('click', () => {
  if (mode !== 'walk') return;
  if (mainMenuListEl?.classList.contains('collapsed')) {
    mainMenuListEl.classList.remove('collapsed');
  } else {
    collapseMainMenu();
  }
});

// Portfolio gallery - fetch-once-cache-forever manifest (built at build
// time by the optimize script, not something that changes at runtime), a
// grid of tiles, and a lightbox for the full-size view. Lives on top of
// whichever mode (title/walk) was already showing - doesn't touch camera,
// scene.fog, or any of the 3D transition machinery above at all.
const portfolioGalleryEl = document.getElementById('portfolio-gallery');
const portfolioGalleryTitleEl = document.getElementById('portfolio-gallery-title');
const portfolioGalleryGridEl = document.getElementById('portfolio-gallery-grid');
const portfolioLightboxEl = document.getElementById('portfolio-lightbox');
const portfolioLightboxContentEl = document.getElementById('portfolio-lightbox-content');
const portfolioLightboxCloseBtn = document.getElementById('portfolio-lightbox-close');

let portfolioManifestPromise = null;
function getPortfolioManifest() {
  if (!portfolioManifestPromise) {
    // "reduce load times between portfolio and across everything on mobile" -
    // manifest-mobile.json points at public/portfolio-mobile/, a
    // pre-shrunk copy (images capped ~700px/JPEG q68, dynamics clips
    // downscaled+recompressed) built by build_mobile_portfolio.py.
    // 96MB of images -> 8MB, 17MB of dynamics video -> 2.6MB. Desktop keeps
    // fetching the original full-res manifest, untouched.
    const manifestPath = IS_MOBILE ? '/portfolio/manifest-mobile.json' : '/portfolio/manifest.json';
    portfolioManifestPromise = fetch(manifestPath).then((r) => r.json());
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

// Fisher-Yates - unbiased shuffle (unlike `sort(() => Math.random() - 0.5)`,
// which skews toward certain orderings since comparator-based sorts don't
// call the comparison function evenly across all pairs). In-place on a
// COPY of the manifest array, never the manifest itself - getPortfolioManifest()
// caches that promise/array for the whole session, so mutating it directly
// would leave every later gallery open working off an already-shuffled (and
// increasingly re-shuffled) array instead of the original fetched order.
function shuffled(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Grid thumbnails vs full-size originals.
//
// The grid used to point every tile at the full-resolution original - up to
// ~3.8MB each, ~50 per category. File size isn't even the main cost: the
// browser decodes each one to raw RGBA to display it, so a 2000px image holds
// ~16MB of memory regardless of how well the file compressed. Fifty of those
// is what pushed the tab into Safari's "reloaded because it was using
// significant memory" territory on DESKTOP, not just mobile.
//
// public/portfolio-mobile/ already holds a ~700px copy of every asset (built
// for the mobile manifest), and 700px is far more than a 320px-wide grid tile
// needs - so the grid reads from there on every device now, and only the
// LIGHTBOX loads the original. You still get full quality when you actually
// open something; you just stop paying for 50 of them at once.
//
// Idempotent on purpose: mobile's manifest already points at portfolio-mobile,
// so this has to no-op there rather than mangling the path a second time.
function thumbPath(path) {
  if (path.startsWith('/portfolio-mobile/')) return path;
  if (!path.startsWith('/portfolio/')) return path;
  const moved = path.replace('/portfolio/', '/portfolio-mobile/');
  // build_mobile_portfolio.py re-encodes every still as .jpg; clips keep
  // their original .mp4 name.
  return isVideoPath(moved) ? moved : moved.replace(/\.[^./]+$/, '.jpg');
}

async function openPortfolioGallery(route) {
  const category = PORTFOLIO_CATEGORIES[route];
  if (!category) return;

  portfolioGalleryTitleEl.textContent = category.title;
  portfolioGalleryGridEl.innerHTML = '';
  portfolioGalleryEl.classList.remove('hidden');
  document.body.classList.add('portfolio-open');

  const manifest = await getPortfolioManifest();
  // Randomized per "i want it to be in randomized order" - reshuffled
  // fresh every time the gallery's opened, not just once per page load.
  const items = shuffled(manifest[category.slug] || []);

  for (const path of items) {
    const tile = document.createElement('div');
    tile.className = 'portfolio-tile';
    if (isVideoPath(path)) {
      tile.classList.add('is-video');
      const video = document.createElement('video');
      video.src = thumbPath(path);
      // mobile: don't even preload metadata for every clip the instant the
      // gallery opens - 'none' means nothing fetches until the tile is
      // actually tapped. Desktop keeps 'metadata' as before.
      video.preload = IS_MOBILE ? 'none' : 'metadata';
      video.muted = true;
      video.playsInline = true;
      tile.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = thumbPath(path);
      img.loading = 'lazy';
      // Tells the browser the tile's real rendered width up front, so it can
      // pick a cheaper decode size instead of decoding at full resolution and
      // scaling down afterwards.
      img.sizes = '320px';
      img.decoding = 'async';
      tile.appendChild(img);
    }
    // Lightbox gets the ORIGINAL, not the thumbnail - full quality is the
    // whole point of opening one, and it's a single image rather than fifty.
    tile.addEventListener('click', () => openPortfolioLightbox(path));
    portfolioGalleryGridEl.appendChild(tile);
  }
}

function closePortfolioGallery() {
  portfolioGalleryEl.classList.add('hidden');
  closePortfolioLightbox();
  // "keep the menu option in top left but open it to the right instead of
  // down while on portfolio pages" - see style.css's body.portfolio-open
  // rules (dark text + raised z-index so #main-menu reads over the white
  // gallery, submenu opens sideways instead of down).
  document.body.classList.remove('portfolio-open');
}

portfolioLightboxCloseBtn?.addEventListener('click', closePortfolioLightbox);
// Click the dimmed backdrop (not the media itself) to dismiss the lightbox.
portfolioLightboxEl?.addEventListener('click', (e) => {
  if (e.target === portfolioLightboxEl) closePortfolioLightbox();
});

// About Me overlay - see index.html's comment on #about-overlay for why
// this is a translucent panel over the live 3D view rather than a full
// takeover page like the portfolio gallery above. showAboutOverlay() is
// only ever called from updateTransition once the 'about' flight actually
// lands (see that call site); hideAboutOverlay() is called both from the
// close button/Escape below AND defensively at the start of every other
// flight (startTransition/flyToLocation/startReturnToTitle) so it can't
// linger on screen while you fly somewhere else.
// Contact overlay - flat panel, no 3D flight (see index.html's #contact-overlay
// comment). Opened/closed straight from navigateToRoute below.
const contactOverlayEl = document.getElementById('contact-overlay');
const contactOverlayCloseBtn = document.getElementById('contact-overlay-close');

function showContactOverlay() {
  contactOverlayEl?.classList.remove('hidden');
}
function hideContactOverlay() {
  contactOverlayEl?.classList.add('hidden');
}
contactOverlayCloseBtn?.addEventListener('click', () => {
  hideContactOverlay();
  navigateToRoute(mode === 'walk' ? 'explore-archive-shop' : 'home');
});

const aboutOverlayEl = document.getElementById('about-overlay');
const aboutOverlayScrollEl = document.getElementById('about-overlay-scroll');
const aboutOverlayCloseBtn = document.getElementById('about-overlay-close');
const aboutBackToTopBtn = document.getElementById('about-back-to-top');

function showAboutOverlay() {
  aboutOverlayEl?.classList.remove('hidden');
  // Horizontal corner menu on this page too - see body.about-open in
  // style.css ("portfolio would be right of the logo... ONLY on
  // portfolio and about me tho").
  document.body.classList.add('about-open');
}
function hideAboutOverlay() {
  aboutOverlayEl?.classList.add('hidden');
  document.body.classList.remove('about-open');
}
aboutOverlayCloseBtn?.addEventListener('click', hideAboutOverlay);
// "Back 2 Top" from the original page - this overlay is one scrolling
// column (see #about-overlay's overflow-y in style.css), not paginated,
// so this just scrolls the overlay itself back to 0 rather than the whole
// document (which never scrolls - everything else in this app is
// fixed/full-viewport).
aboutBackToTopBtn?.addEventListener('click', () => {
  aboutOverlayScrollEl?.scrollTo({ top: 0, behavior: 'smooth' });
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!portfolioLightboxEl.classList.contains('hidden')) closePortfolioLightbox();
  else if (!portfolioGalleryEl.classList.contains('hidden')) closePortfolioGallery();
  else if (!aboutOverlayEl?.classList.contains('hidden')) hideAboutOverlay();
  else if (!contactOverlayEl?.classList.contains('hidden')) hideContactOverlay();
});

// Single dispatcher for "go to this route", used by menu clicks, browser
// back/forward (popstate), and the initial deep-link check near
// initLoadingUI() below - previously this logic only lived inline inside
// the click listener, which meant back/forward and direct URL loads had
// no way to trigger the exact same behavior a click would.
// `pushHistory: false` is for cases where the URL already changed on its
// own (popstate) or hasn't loaded yet (initial deep link) - pushing again
// there would either fight the browser's own history navigation or push a
// redundant duplicate entry before the page has even rendered once.
function navigateToRoute(route, { pushHistory = true } = {}) {
  // "when you select something else from the menu the portfolio page
  // should automatically close" - anything that ISN'T itself opening a
  // portfolio category (Home, an Explore spot, Contact, About, or a
  // different top-level item entirely) should close the gallery first,
  // otherwise it just sits there on top (z-index 16-18) while whatever
  // else was clicked tries to happen underneath/behind it. Picking a
  // different Portfolio category is excluded on purpose - that already
  // updates the same open gallery in place via openPortfolioGallery,
  // no reason to close-then-reopen it.
  if (!PORTFOLIO_CATEGORIES[route] && !portfolioGalleryEl.classList.contains('hidden')) {
    closePortfolioGallery();
  }
  // Same idea for Contact - navigating anywhere else dismisses it.
  if (route !== 'contact') hideContactOverlay();

  if (pushHistory) {
    const path = pathForRoute(route);
    if (path && window.location.pathname !== path) {
      history.pushState({ route }, '', path);
    }
  }

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

  // Contact - same deal as the portfolio categories above: a flat overlay with
  // no LOCATIONS entry, so it has to be handled before the "no destination
  // wired yet" fallthrough below rather than after it.
  if (route === 'contact') {
    showContactOverlay();
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
}

document.querySelectorAll('#main-menu-list li[data-route]').forEach((li) => {
  li.addEventListener('click', () => navigateToRoute(li.dataset.route));
});

// External links in the menu (currently just "Loot" -> toefu.nyc). These use
// data-href rather than data-route deliberately: there's no LOCATIONS entry
// and nothing in the 3D scene to fly to, so routing them through
// navigateToRoute would just hit its "no destination wired yet" branch.
// noopener/noreferrer on the opened window for the usual reason - without it
// the new tab gets a handle back to this one via window.opener.
document.querySelectorAll('#main-menu-list li[data-href]').forEach((li) => {
  li.addEventListener('click', () => {
    window.open(li.dataset.href, '_blank', 'noopener,noreferrer');
  });
});

// Browser back/forward - re-run whatever route the URL now points at,
// without pushing a NEW history entry (the browser already moved us to
// this entry, pushState-ing again here would fight that). event.state is
// whatever we stored in the pushState call that created this entry (see
// navigateToRoute above); falls back to parsing the URL itself for the
// very first entry (the initial page load, which never went through
// pushState) or if state ever ends up missing for some other reason.
window.addEventListener('popstate', (event) => {
  const route = event.state?.route || routeForPath(window.location.pathname) || 'home';
  navigateToRoute(route, { pushHistory: false });
});

// Deep-link entry - "url.com/graphic-design" should land you directly in
// that gallery, not just be reachable by clicking through the menu after
// the fact. Portfolio categories don't touch the 3D scene at all (own
// manifest.json fetch, plain DOM overlay) so this fires immediately, before
// the ~50MB TRY7_SCENE.glb even starts loading behind it - no reason to
// force a full loading-screen wait just to see a flat image gallery.
// About/Contact/Explore spots DO need the real 3D scene (an actual camera
// flight through real geometry), so those are deferred to the
// initLoadingUI() onComplete callback further below instead.
const initialRoute = routeForPath(window.location.pathname);
if (initialRoute && PORTFOLIO_CATEGORIES[initialRoute]) {
  openPortfolioGallery(initialRoute);
}

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

// Second half of the deep-link handling above - About/Contact/Explore
// routes need the real 3D scene (camera flight through real geometry), so
// those wait until the scene actually finishes loading instead of firing
// immediately like the portfolio-category branch does.
initLoadingUI(() => {
  if (initialRoute && LOCATIONS[initialRoute]) {
    navigateToRoute(initialRoute, { pushHistory: false });
  }
});

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
// Pulled back 0.1 -> 0.06 per "make the fog darker" - the drift's peak
// (near-black -> dark-grey) was the one thing still pushing this away from
// black on a regular cycle; narrowing it keeps the same breathing effect
// but spends more of each cycle sitting close to true black.
const FOG_DRIFT_AMOUNT = 0.06; // +/- lightness

// Debug position readout, back per your ask - for grabbing an exact spawn
// point / reference coordinates while placing new interactives. See the
// comment in index.html - delete the #debug-pos div (index.html + style.css)
// and this block once you're done using it.
function updatePositionDebug() {
  if (!debugPosEl || !controls || IS_MOBILE) return; // dev-only tool - stays hidden and skips the per-frame work on mobile
  const p = controls.camera.position;
  const yawDeg = THREE.MathUtils.radToDeg(controls.yaw).toFixed(0);
  const pitchDeg = THREE.MathUtils.radToDeg(controls.pitch).toFixed(0);
  let text = `x: ${p.x.toFixed(2)}\ny: ${p.y.toFixed(2)}\nz: ${p.z.toFixed(2)}\nyaw: ${yawDeg}°\npitch: ${pitchDeg}°`;
  text += `\nstreet: ${streetSceneStatus.state} ${streetSceneStatus.detail}`;
  debugPosEl.textContent = text;
}

// "dont show the walkaround button UNLESS im in an explore page" - the
// joystick (#touch-controls, wired up in controls.js's _setupTouch) was
// showing on mobile in every state - title screen, locked into the vinyl
// booth, mid-flight, even with the About/Portfolio overlays covering the
// whole screen - since .mobile-only's CSS media query shows it unconditionally
// and nothing in JS ever toggled it. "Explore page" here means genuinely
// free-walking: mode is 'walk', controls exist and aren't locked (covers
// both the vinyl booth AND mid-flight in one check, since both set
// controls.locked = true), and neither full-screen overlay is open.
function updateTouchControlsVisibility() {
  if (!IS_MOBILE || !touchControlsEl) return;
  const aboutHidden = !aboutOverlayEl || aboutOverlayEl.classList.contains('hidden');
  const portfolioHidden = !portfolioGalleryEl || portfolioGalleryEl.classList.contains('hidden');
  const contactHidden = !contactOverlayEl || contactOverlayEl.classList.contains('hidden');
  // "still there on main menu" - this was the walk-mode dropdown menu (tap to
  // open a list of destinations), not the title screen - mode is still 'walk'
  // while that menu is open, so the old check missed it. mainMenuListEl only
  // has 'collapsed' removed while the dropdown is expanded.
  const menuClosed = !mainMenuListEl || mainMenuListEl.classList.contains('collapsed');
  const show = mode === 'walk' && !!controls && !controls.locked && aboutHidden && portfolioHidden && contactHidden && menuClosed;
  touchControlsEl.classList.toggle('hidden', !show);
}

function tick() {
  const delta = Math.min(clock.getDelta(), 0.1); // clamp so tab-switch stalls don't teleport the player
  elapsed += delta;
  flickerUniforms.uTime.value = elapsed; // drives every emissive sign's flicker shader at once, see shading.js
  grainUniforms.uTime.value = elapsed; // re-rolls the film grain pattern every frame, see postprocessing.js

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
  // Cover mesh planes load from their own tiny standalone GLB (world.js's
  // albumCoverPlanes), independently of the street scene/vinylBound above -
  // sync whatever track loadVinylTrack last set (or the default, index 0,
  // if it hasn't fired yet) the moment both planes are ready, in case
  // onLocked's loadVinylTrack(0) call raced ahead of this tiny file's load.
  if (!coverPlanesBound && albumCoverPlanes.current && albumCoverPlanes.next) {
    applyCoverPlaneTextures();
    coverPlanesBound = true;
  }
  // Record disc - same lazy-bind pattern, own standalone file (world.js's
  // recordDiscRef), independent of the street scene/vinylBound above. Also
  // gated on vinylInteraction actually existing (same as vinylBound above,
  // not just coverPlanesBound below) - it only exists once you're in walk
  // mode, and marking this bound without it existing yet would skip the
  // real bindDisc() call forever once it finally does. See
  // vinylInteraction.js's bindDisc() for why this replaced the old
  // getObjectByName(Counter_Cube.001) lookup.
  if (vinylInteraction && !recordDiscBound && recordDiscRef.mesh) {
    vinylInteraction.bindDisc(recordDiscRef.mesh);
    recordDiscBound = true;
  }

  // Unconditional (not nested in the mode === 'walk' branch below) - needs
  // to run on the title screen too, so the joystick starts out correctly
  // hidden there instead of showing by default until the first walk-mode
  // frame ever runs.
  updateTouchControlsVisibility();

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
    // Temporary - live camera position while locked in, so you can read a
    // number straight off the screen instead of me guessing at
    // LOCK_CAMERA_OFFSET again. Only updates while the readout is actually
    // visible (locked in) - see index.html's comment on #vinyl-debug-pos.
    if (vinylInteraction?.locked && vinylDebugPosEl) {
      const p = camera.position;
      vinylDebugPosEl.textContent = `x ${p.x.toFixed(2)}\ny ${p.y.toFixed(2)}\nz ${p.z.toFixed(2)}`;
    }
    updateExploreNavVisibility(); // hides the </> arrows the moment you move away from an Explore spot
    updatePositionDebug();

    post.tiltShiftPass.enabled = orthoActive;
    // Distance blur - walk mode's perspective camera only, and only once
    // it's actually rendering (not mid-flight while the ortho camera's
    // still active during a title->walk flight's first phase) - "far
    // away" doesn't mean anything meaningful relative to the orthographic
    // title camera. depthPrepassPass/dofPass toggle together, see
    // postprocessing.js's DepthPrepassPass writeup for why they're two
    // passes instead of one.
    // ...except on mobile, where DOF is off entirely (see postprocessing.js's
    // IS_MOBILE notes) - depthPrepassPass re-renders the WHOLE scene a second
    // time every frame just to fill a depth texture, which on a ~600-mesh
    // scene means roughly double the draw calls per frame. That's the single
    // biggest remaining render-side cost on mobile, and it lines up with the
    // "Rendering" (not Script) categorization in the Safari timeline.
    post.depthPrepassPass.enabled = !orthoActive && !IS_MOBILE;
    post.dofPass.enabled = !orthoActive && !IS_MOBILE;
    post.renderPass.camera = orthoActive ? titleScreen.camera : camera;
  } else {
    scene.fog = null;
    post.tiltShiftPass.enabled = true;
    post.depthPrepassPass.enabled = false;
    post.dofPass.enabled = false;
    titleScreen.update(delta);
    post.renderPass.camera = titleScreen.camera;
  }
  post.composer.render();

  requestAnimationFrame(tick);
}

tick();
