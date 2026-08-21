// ---------------------------------------------------------------------------
// Record player interaction (vinyl store back room) - click the record
// player in walk mode to lock the first-person camera into a fixed close-up
// view of it. This is just the camera-lock scaffold - you said you'd
// provide the actual vinyl interaction animation separately, so there's no
// animation/interaction logic here yet. See the onLocked callback below
// (wired from main.js) for where that plugs in once you have it: it fires
// once the lock-in transition finishes and the camera is holding steady on
// the record player.
//
// Node identity confirmed directly via a world-transform GLB walk (same
// method used throughout world.js's rebake swaps, not assumed from the name
// alone): RecordPlayer_Cube.070 is the only node with "record"+"player" in
// its name anywhere in TRY4_SCENE.glb. World AABB min(-5.93, 0.82, -11.62)
// max(-5.5, 0.92, -11.3) - a tiny prop (~0.4 x 0.1 x 0.3 units). Its parent
// room (RecordStoreWalls_Cube.005) spans x[-8.83,-5.01] z[-15.76,-11.14],
// and RecordStoreDoor_Cube sits at z~-15.9-15.6 - so the record player, at
// z~-11.46, is about as far from the door as that room gets, hard against
// the back-right corner. Matches "back area" exactly.
//
// LOCK_CAMERA_OFFSET below is NOT visually confirmed - I can't render, so
// this is a reasoned guess (pulled back toward the door/open floor side,
// away from both walls per the AABB numbers above) rather than a random
// one, but still just a first draft. Tune once you've actually clicked it
// and seen the framing, same as every other blind camera constant in this
// project.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Sanitized name, not the raw glTF name - Three.js's GLTFLoader strips
// '.', '[', ']', ':', '/' out of every node name it loads (reserved for its
// animation track-path syntax, applied unconditionally regardless of
// whether the file has animations - see sanitizeGltfName's writeup in
// world.js, where this exact bug was actually caught and diagnosed: the
// literal glTF JSON name 'RecordPlayer_Cube.070' never exists at runtime,
// the live scene graph only ever has 'RecordPlayer_Cube070'). This means
// bindTarget() below has likely never actually resolved a target since
// this feature was first built - the isMesh check would have looked
// correct in review but the name lookup itself was always failing first.
export const RECORD_PLAYER_NODE_NAME = 'RecordPlayer_Cube070';
// The record disc itself used to be looked up here by name
// (Counter_Cube.001, inside TRY7_SCENE.glb) - replaced by a standalone
// RECORD_DISC.glb fed in via bindDisc() below, see world.js's
// recordDiscRef and its writeup for why ("heres one with the unwarped
// mesh and origins").
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const RECORD_PLAYER_CENTER = new THREE.Vector3(-5.72, 0.87, -11.46);
const LOCK_CAMERA_OFFSET = new THREE.Vector3(0, 0.78, -0.34);
// "did i ask for you to turn the camera? no. dont." - putting a nonzero x
// on LOCK_CAMERA_OFFSET above rotates the view, since _lockQuat below
// always aims at a fixed target: moving the CAMERA sideways while the
// target stays put changes the angle between them, not just the position.
// To shift the framing sideways with the exact same angle as before, both
// the camera AND what it's aimed at need to move together by the same
// amount - a dolly, not a pan. LOCK_LOOK_TARGET is that aim point,
// separate from RECORD_PLAYER_CENTER (which stays the model's real
// position, still used for the click-range check below) so this is a
// pure "look slightly to the side of the actual object" framing choice,
// not a change to what's considered "the record player" for interaction
// purposes.
const LOCK_LOOK_TARGET = new THREE.Vector3(-5.7, 0.87, -11.46);
// Max distance (world units) from the player to the record player for a
// click to register - keeps a lucky raycast from triggering this from
// across the map/through walls, since this only checks the ray hit the
// mesh, not that anything is actually blocking the line of sight.
const INTERACT_RANGE = 4;
const LOCK_TRANSITION_SECONDS = 0.7;
// "when you click on the record player, i want it to not just have the
// record appear, but animate like its being put onto it" - was an instant
// this.recordDisc.visible = true with zero motion. Now it starts lifted
// DISC_DROP_HEIGHT above its actual resting transform (the position/
// rotation the record already has in the GLB - that part was never wrong,
// just revealed with no motion behind it) and eases down onto the player
// over DISC_DROP_SECONDS, running alongside the camera's zoom-in rather
// than blocking it - by the time the lock-in transition finishes, the
// record's already settled, so you're not left waiting on two separate
// animations back to back.
const DISC_DROP_HEIGHT = 0.35; // world units the record starts above its resting spot
const DISC_DROP_SECONDS = 0.55; // finishes a bit before LOCK_TRANSITION_SECONDS so it's settled, not still falling, once the zoom lands

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Decelerating settle (fast start, slow finish) - reads like a hand
// lowering the record and easing off just before it touches down, not a
// physics drop that would still be speeding up at contact.
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export class VinylInteraction {
  constructor(camera, domElement, controls, { onLocked, onUnlocked } = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = controls;
    this.onLocked = onLocked; // () => void - fires once fully locked in; hook the future vinyl animation here
    this.onUnlocked = onUnlocked; // () => void - fires once back to normal walk control

    this.target = null; // resolved RecordPlayer_Cube.070 mesh, set by bindTarget()
    this.recordDisc = null; // resolved Counter_Cube.001 (the vinyl record) mesh, set by bindTarget()
    this.locked = false;

    this._lockPos = LOCK_LOOK_TARGET.clone().add(LOCK_CAMERA_OFFSET);
    this._lockQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(this._lockPos, LOCK_LOOK_TARGET, camera.up)
    );

    this._savedPos = new THREE.Vector3();
    this._savedQuat = new THREE.Quaternion();
    this._savedYaw = 0;
    this._savedPitch = 0;

    this._transitioning = false;
    this._transitionReverse = false;
    this._transitionT = 0;

    this._discRestY = 0; // set for real once bindTarget resolves the disc
    this._discDropping = false;
    this._discDropT = 0;
    // "can we have the single vinyl on top of the player spin while music
    // plays too" - toggled by main.js's audio play/pause listeners via
    // setSpinning(), actually applied per-frame in update() below.
    this._spinning = false;
    this._transFromPos = new THREE.Vector3();
    this._transFromQuat = new THREE.Quaternion();
    this._transToPos = new THREE.Vector3();
    this._transToQuat = new THREE.Quaternion();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._onClick = this._onClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    domElement.addEventListener('click', this._onClick);
    document.addEventListener('keydown', this._onKeyDown);
  }

  // Call once the street mesh is loaded, same lazy-bind pattern as
  // titleScreen.js's bindSigns - see the call site in main.js's tick.
  bindTarget(street) {
    if (this.target) return;
    const mesh = street.getObjectByName(RECORD_PLAYER_NODE_NAME);
    if (!mesh || !mesh.isMesh) {
      console.warn(`[vinyl interaction] ${RECORD_PLAYER_NODE_NAME} not found in TRY7_SCENE - skipping`);
      return;
    }
    this.target = mesh;
  }

  // Separate lazy-bind from bindTarget above - the disc now loads from its
  // own standalone RECORD_DISC.glb (world.js's recordDiscRef), not looked
  // up inside the big street scene, so it resolves on its own timeline.
  // "heres one with the unwarped mesh and origins" - this new export's
  // origin is already correctly centered at the source, so (unlike the
  // old Counter_Cube.001 lookup this replaces) there's no runtime
  // recentering needed here anymore.
  bindDisc(mesh) {
    if (this.recordDisc || !mesh?.isMesh) return;
    this.recordDisc = mesh;
    this._discRestY = mesh.position.y; // its real, correct resting height - the drop animation lerps back to this, never past it
    // Same race the old Counter_Cube.001 lookup never had to worry about
    // (that one was already sitting in the always-loaded street scene) -
    // this standalone GLB can finish loading AFTER the player has already
    // clicked in. _lockIn() only reveals+drops if this.recordDisc was set
    // at that exact moment; if binding lands late, that call already ran
    // and no-oped, so catch up here instead of leaving it invisible until
    // the next lock/unlock cycle.
    if (this.locked) {
      this.recordDisc.visible = true;
      this._startDiscDrop();
    } else {
      this.recordDisc.visible = false; // hidden until locked in
    }
  }

  // Note: this fires on the browser's native 'click' event, which doesn't
  // distinguish "clicked" from "released after a look-drag" - controls.js's
  // drag-to-look uses the same domElement. In practice this only matters if
  // a drag happens to END with the cursor sitting exactly on the record
  // player's tiny on-screen footprint, which is unlikely enough not to be
  // worth the extra bookkeeping a real click-vs-drag threshold would need.
  _onClick(e) {
    // Temporary - "once you exit you can't get back in, nothing happens at
    // all" - every early-return path here is a silent no-op with no visible
    // signal, so there's no way to tell WHICH guard is blocking re-entry
    // without seeing it live. Logging every branch (not just failures) so
    // the very first line printed tells us whether this handler is even
    // firing at all. Remove once the real cause is found.
    if (!this.target) { console.warn('[vinyl click] blocked: this.target not resolved'); return; }
    if (this.locked) { console.warn('[vinyl click] blocked: still marked locked'); return; }
    if (this._transitioning) { console.warn('[vinyl click] blocked: still marked transitioning'); return; }
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.target, false);
    if (hits.length === 0) { console.warn('[vinyl click] blocked: raycast missed the record player mesh'); return; }
    const dist = this.camera.position.distanceTo(RECORD_PLAYER_CENTER);
    if (dist > INTERACT_RANGE) { console.warn(`[vinyl click] blocked: out of range (${dist.toFixed(2)} > ${INTERACT_RANGE})`); return; }
    console.warn('[vinyl click] all checks passed, locking in');
    this._lockIn();
  }

  _onKeyDown(e) {
    if (e.code === 'Escape' && this.locked && !this._transitioning) this._unlock();
  }

  // Public entry point for the "back to walkaround" button in main.js -
  // same guard as the Escape-key path above, just reachable from a click
  // instead of a keyboard shortcut.
  unlock() {
    if (this.locked && !this._transitioning) this._unlock();
  }

  _lockIn() {
    this.locked = true;
    this.controls.locked = true; // controls.js's update() early-returns while this is set, see there
    // "shown when the record player is clicked on" - reveal immediately on
    // click, not once the zoom-in transition finishes, so it's there the
    // whole time you're approaching rather than popping in after the fact.
    // Starts lifted DISC_DROP_HEIGHT above its resting spot and eases down
    // over the drop below, instead of just popping in at rest.
    if (this.recordDisc) {
      this.recordDisc.visible = true;
      this._startDiscDrop();
    }
    this._savedYaw = this.controls.yaw;
    this._savedPitch = this.controls.pitch;
    this._savedPos.copy(this.camera.position);
    this._savedQuat.copy(this.camera.quaternion);

    this._transFromPos.copy(this.camera.position);
    this._transFromQuat.copy(this.camera.quaternion);
    this._transToPos.copy(this._lockPos);
    this._transToQuat.copy(this._lockQuat);
    this._transitioning = true;
    this._transitionReverse = false;
    this._transitionT = 0;
  }

  // Shared by _lockIn() (the initial approach) and replayDrop() below (a
  // swap to a new track in the sample booth) - same lifted-then-eased-down
  // motion either way, just triggered at two different moments.
  _startDiscDrop() {
    this.recordDisc.position.y = this._discRestY + DISC_DROP_HEIGHT;
    this._discDropping = true;
    this._discDropT = 0;
  }

  // Public entry point for the vinyl booth (main.js) - "the vinyl drops
  // down" each time you swap to a new album, same physical motion as the
  // very first approach, not just on the initial lock-in. No-ops while not
  // locked in (nothing to animate) or the disc failed to resolve.
  replayDrop() {
    if (!this.locked || !this.recordDisc) return;
    this._startDiscDrop();
  }

  // Public entry point for main.js's audio play/pause listeners - just
  // sets a flag, actual per-frame rotation happens in update() below so
  // it stays in sync with the same delta-time clock as everything else
  // here instead of running its own rAF loop.
  setSpinning(spinning) {
    this._spinning = spinning;
  }

  _unlock() {
    this._transFromPos.copy(this.camera.position);
    this._transFromQuat.copy(this.camera.quaternion);
    this._transToPos.copy(this._savedPos);
    this._transToQuat.copy(this._savedQuat);
    this._transitioning = true;
    this._transitionReverse = true;
    this._transitionT = 0;
  }

  // Call every frame from main.js's tick while mode === 'walk', AFTER
  // controls.update(delta) - controls.update() no-ops while locked, this is
  // what drives the camera instead during both the transition and the held
  // lock.
  update(delta) {
    // Runs independently of the camera transition below - it's shorter
    // (DISC_DROP_SECONDS < LOCK_TRANSITION_SECONDS) and started at the same
    // moment in _lockIn(), so it's always done well before the early-return
    // below would ever cut it off, but keeping it out of that guard means
    // it can't silently get skipped if the durations ever change relative
    // to each other.
    if (this._discDropping && this.recordDisc) {
      this._discDropT += delta / DISC_DROP_SECONDS;
      const dt = easeOutCubic(Math.min(this._discDropT, 1));
      this.recordDisc.position.y = THREE.MathUtils.lerp(this._discRestY + DISC_DROP_HEIGHT, this._discRestY, dt);
      if (this._discDropT >= 1) this._discDropping = false;
    }

    // "can we have the single vinyl on top of the player spin while music
    // plays too" - spins around the disc's own up axis at a real 33rpm
    // turntable's rate (33.33 rev/min -> /60 for rev/sec -> *2π for
    // radians/sec) while setSpinning(true) is in effect (main.js toggles
    // this off the audio element's play/pause events). Runs independently
    // of the drop/transition blocks above and below - happy to keep
    // spinning through a track swap's drop animation or even the
    // lock/unlock camera transition, same as a real record would.
    if (this._spinning && this.recordDisc) {
      // "wrong axis" - was `rotation.y +=`, which spins around the MESH's
      // own local Y, whatever that happens to mean after its baked-in
      // placement rotation (evidently not "flat like a turntable record"
      // here - looked like it was tumbling/flipping instead). Switched to
      // rotateOnWorldAxis with the actual world-up vector, which spins it
      // flat around the vertical regardless of whatever the mesh's own
      // local axes are oriented like - matches how a real record spins
      // on a turntable no matter how the source file's local space is
      // set up.
      this.recordDisc.rotateOnWorldAxis(WORLD_UP, delta * ((33 + 1 / 3) / 60) * Math.PI * 2);
    }

    if (!this._transitioning) return;
    this._transitionT += delta / LOCK_TRANSITION_SECONDS;
    const t = easeInOutCubic(Math.min(this._transitionT, 1));

    this.camera.position.lerpVectors(this._transFromPos, this._transToPos, t);
    this.camera.quaternion.slerpQuaternions(this._transFromQuat, this._transToQuat, t);

    if (this._transitionT >= 1) {
      this._transitioning = false;
      if (this._transitionReverse) {
        this.locked = false;
        this.controls.locked = false;
        // restore yaw/pitch so controls.js's next update() picks up
        // rotation.y/x from exactly where the slerp left off, no pop
        this.controls.yaw = this._savedYaw;
        this.controls.pitch = this._savedPitch;
        // Hide the record again only once the pan-away transition has
        // actually finished, not the instant Escape/unlock() is pressed -
        // otherwise it'd visibly vanish mid-frame while still on screen.
        if (this.recordDisc) this.recordDisc.visible = false;
        this.onUnlocked?.();
      } else {
        this.onLocked?.();
      }
    }
  }

  dispose() {
    this.domElement.removeEventListener('click', this._onClick);
    document.removeEventListener('keydown', this._onKeyDown);
  }
}
