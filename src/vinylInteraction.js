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
const RECORD_PLAYER_CENTER = new THREE.Vector3(-5.72, 0.87, -11.46);
const LOCK_CAMERA_OFFSET = new THREE.Vector3(0, 0.5, -1.0);
// Max distance (world units) from the player to the record player for a
// click to register - keeps a lucky raycast from triggering this from
// across the map/through walls, since this only checks the ray hit the
// mesh, not that anything is actually blocking the line of sight.
const INTERACT_RANGE = 4;
const LOCK_TRANSITION_SECONDS = 0.7;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class VinylInteraction {
  constructor(camera, domElement, controls, { onLocked, onUnlocked } = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = controls;
    this.onLocked = onLocked; // () => void - fires once fully locked in; hook the future vinyl animation here
    this.onUnlocked = onUnlocked; // () => void - fires once back to normal walk control

    this.target = null; // resolved RecordPlayer_Cube.070 mesh, set by bindTarget()
    this.locked = false;

    this._lockPos = RECORD_PLAYER_CENTER.clone().add(LOCK_CAMERA_OFFSET);
    this._lockQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(this._lockPos, RECORD_PLAYER_CENTER, camera.up)
    );

    this._savedPos = new THREE.Vector3();
    this._savedQuat = new THREE.Quaternion();
    this._savedYaw = 0;
    this._savedPitch = 0;

    this._transitioning = false;
    this._transitionReverse = false;
    this._transitionT = 0;
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
      console.warn(`[vinyl interaction] ${RECORD_PLAYER_NODE_NAME} not found in TRY4_SCENE - skipping`);
      return;
    }
    this.target = mesh;
  }

  // Note: this fires on the browser's native 'click' event, which doesn't
  // distinguish "clicked" from "released after a look-drag" - controls.js's
  // drag-to-look uses the same domElement. In practice this only matters if
  // a drag happens to END with the cursor sitting exactly on the record
  // player's tiny on-screen footprint, which is unlikely enough not to be
  // worth the extra bookkeeping a real click-vs-drag threshold would need.
  _onClick(e) {
    if (!this.target || this.locked || this._transitioning) return;
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.target, false);
    if (hits.length === 0) return;
    if (this.camera.position.distanceTo(RECORD_PLAYER_CENTER) > INTERACT_RANGE) return;
    this._lockIn();
  }

  _onKeyDown(e) {
    if (e.code === 'Escape' && this.locked && !this._transitioning) this._unlock();
  }

  _lockIn() {
    this.locked = true;
    this.controls.locked = true; // controls.js's update() early-returns while this is set, see there
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
