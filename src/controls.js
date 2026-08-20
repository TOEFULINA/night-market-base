// ---------------------------------------------------------------------------
// First-person walk controls: WASD to move, click-and-drag with the mouse to
// look around on desktop, virtual joystick + drag-to-look on mobile.
//
// Desktop deliberately does NOT use pointer lock (no Escape-to-get-your-
// mouse-back friction) - click and drag the view instead, same mental model
// as the mobile drag-look, just with a mouse. Release the drag and the mouse
// cursor is immediately usable again for clicking UI, no unlock step.
//
// No physics engine here on purpose - Bruno Simon-style rooms use cannon.js
// because objects need to *react* to the player. A walkable market doesn't
// need that; a flat/height-clamped ground plane plus a soft world-radius
// boundary is much cheaper and is plenty for a rough base. Swap in a real
// nav-mesh or collision system later only if you actually need it.
//
// DID try real mesh collision (Octree + Capsule vs. the whole street mesh) -
// reverted, came out broken (not debugged further yet - could be capsule
// dimensions, could be the octree/geometry itself, didn't chase it down).
// worldOctree is still built in world.js (harmless, just an unused spatial
// index sitting there) in case it's worth picking back up later - this file
// just isn't querying it anymore. Back to the plain clamp approach below.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Bumped from 20 - that undersold the actual reachable space. This is a
// circular clamp around the origin, but the model's real footprint is
// roughly a 41x45 rectangle (half-extents ~20.5 x 22.5), so a straight-line
// corner can be up to ~30 units out even though the "radius" needed to
// cover the middle of each wall is only ~20. 20 was stopping you well short
// of the actual corners. No real wall collision here (this is just a
// distance-from-center clamp, not the model's actual geometry), so this is
// still an approximation - if you can now wander past a wall into empty
// space somewhere, that's this radius being too generous in that
// direction, not a floor/collision bug.
const WORLD_RADIUS = 30; // how far the player can wander from center
// The circular radius above is too generous in the +x direction specifically -
// past x~13 (still well inside the 30-unit radius) the street rounds a corner
// into the part of the model that isn't dressed with content. You hit this
// exactly at the bike near the corner (debug overlay read x:12.78, z:-17.64
// right there), so this is a direct clamp on that one axis rather than
// shrinking the shared radius (which would've also pulled in the spawn point,
// itself 24.9 units out). Same "simple approximation, no real collision"
// caveat as the radius - if another direction turns out to need the same
// treatment, add another one of these rather than touching WORLD_RADIUS.
const X_MAX = 12.8;
// Same deal, different direction: the sidewalk railing/fence separating the
// storefront row from the road. First pass at this had the inequality
// backwards - blocked z from going ABOVE -18.9, which actually blocks
// walking INTO the shops (their doorways sit at higher z than the sidewalk
// strip) while leaving the street wide open, exactly backwards from "only
// let me walk into the shops, not the street." Confirmed directly: got
// stuck at z:-18.90 right at a shop threshold, unable to step further in.
// Correct rule is the opposite - block z from going BELOW -18.9 (into the
// street), no cap going up (into a shop).
const Z_MIN = -18.9;
// Dropped again, 1.4 -> 1.3. For reference, eye height for someone 5'2"
// (1.575m) is roughly 1.47-1.48m (eye level typically sits ~4-5in/10-13cm
// below the top of the head) - so 1.3 is already shorter than a literal
// real-world match. Going with what actually feels right in the doorways
// over strict anthropometric accuracy; nudge again if it's still not
// enough.
const EYE_HEIGHT = 1.3;
// Bumped up again - 1.4/3.0 (real-world walk/jog pace) felt too slow to
// actually get around in, especially now that the scene is a compact
// ~41x45 interior rather than a sprawling street where a realistic pace
// made the distance feel meaningful. Prioritizing feel over strict
// real-world accuracy here, same call as the eye-height tuning.
const WALK_SPEED = 2.2;
const RUN_SPEED = 4.5;
const LOOK_SENSITIVITY = 0.0025;

// Spawn point - updated again to the thrift/vinyl storefront spot you
// picked out via the #debug-pos readout (x:-6.53 y:1.30 z:-18.90 yaw:227°,
// grabbed straight from a screenshot of that readout). z sits exactly on
// Z_MIN (-18.9) - that's fine, the clamp above only kicks in BELOW that
// value, so spawning right at the boundary doesn't get snapped anywhere.
const SPAWN_POSITION = { x: -6.53, y: EYE_HEIGHT, z: -18.9 };
const SPAWN_YAW = THREE.MathUtils.degToRad(227);

// Exported so main.js can wire a "Home" menu item that flies back to this
// exact spot via the same flyToLocation()/LOCATIONS mechanism as every other
// destination, instead of needing a special case.
export { SPAWN_POSITION, SPAWN_YAW };

// Footstep head-bob - vertical only, deliberately tiny. Horizontal sway was
// left out on purpose: it'd need to be tracked separately from the actual
// walk position to avoid slowly drifting the camera sideways over time,
// which is extra complexity this "very very very subtle" effect doesn't
// need. Vertical is safe to just overwrite every frame (no drift possible).
const BOB_FREQUENCY_WALK = 10; // step cadence while walking
const BOB_FREQUENCY_RUN = 14; // faster cadence while sprinting
const BOB_AMPLITUDE = 0.02; // meters - keep small, this should be felt, not seen
const BOB_FADE_SPEED = 8; // how quickly the bob fades in/out at start/stop of movement

export class Controls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.isMobile = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    // Set by vinylInteraction.js while the camera is locked into/out of the
    // record-player close-up - update() below early-returns entirely while
    // this is true, so nothing here fights the lock transition's own
    // position/rotation writes. Restored to false (and yaw/pitch re-synced)
    // once vinylInteraction's unlock transition finishes.
    this.locked = false;

    // Set/cleared externally by main.js while standing at an Explore spot -
    // { min, max } in radians, or null for unrestricted look-around. Keeps
    // you from spinning all the way around and staring into whatever's
    // behind the display (empty/unfinished space past the edge of that
    // storefront's set dressing) - see main.js's activateExploreNavIfApplicable/
    // hideExploreNav for where this actually gets set.
    this.yawClamp = null;

    this.move = { forward: false, back: false, left: false, right: false, run: false };
    this.yaw = SPAWN_YAW; // where the camera is currently looking (changes on mouse/touch drag)
    this.pitch = 0;
    // where the player is "standing" facing - only updates while actually
    // moving, frozen otherwise. Things anchored to your position/facing
    // (like the companion) should use this instead of `yaw`, so they don't
    // swing around just because you looked somewhere without walking.
    this.moveHeading = SPAWN_YAW;
    this._bobPhase = 0;
    this._bobIntensity = 0; // eased 0-1, so bob fades in/out instead of snapping

    this.camera.position.set(SPAWN_POSITION.x, SPAWN_POSITION.y, SPAWN_POSITION.z);
    this.camera.rotation.order = 'YXZ';

    if (this.isMobile) {
      this._setupTouch();
    } else {
      this._setupDesktop();
    }
  }

  // Listener callbacks are stored on `this` (not left as inline anonymous
  // functions like before) so dispose() below can actually remove them.
  // This matters now that Home reverses back to the title screen instead of
  // reloading the page (see main.js's startReturnToTitle) - a fresh Controls
  // instance gets constructed every time you re-enter walk mode, and without
  // a real dispose() each round trip would leave a whole extra set of
  // window/document-level mousemove/mouseup/blur/keydown/keyup listeners
  // behind, permanently - each still harmlessly updating that ORPHANED
  // instance's own this.yaw/this.move (never read again since `controls` in
  // main.js points at the newest instance), but that's a real, unbounded
  // listener leak over repeated home/re-enter cycles, not just a style nit.
  _setupDesktop() {
    // "night market" / WASD-instructions overlay used to auto-show here on
    // every walk-mode entry (including repeat Explore-menu round trips via
    // Home's reverse pan) - per your "i dont want this here when i enter
    // explore mode" call, dropped entirely. #intro-overlay/.visible stay
    // defined in style.css/index.html unused rather than deleted, same
    // "unwire don't delete" pattern as the per-room rebakes in world.js, in
    // case you want a one-time first-visit version of this back later.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    this._onMouseDown = (e) => {
      if (e.button !== 0) return; // left-click drag only
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    this._onWindowMouseMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.yaw -= dx * LOOK_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK_SENSITIVITY, -1.2, 1.2);
    };
    this._onWindowMouseUp = () => { dragging = false; };
    // dragged off-window mid-drag - stop rather than leaving it "stuck"
    this._onWindowBlur = () => { dragging = false; };

    this.domElement.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onWindowMouseMove);
    window.addEventListener('mouseup', this._onWindowMouseUp);
    window.addEventListener('blur', this._onWindowBlur);

    const onKey = (down) => (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.move.forward = down; break;
        case 'KeyS': case 'ArrowDown': this.move.back = down; break;
        case 'KeyA': case 'ArrowLeft': this.move.left = down; break;
        case 'KeyD': case 'ArrowRight': this.move.right = down; break;
        case 'ShiftLeft': case 'ShiftRight': this.move.run = down; break;
      }
    };
    this._onKeyDown = onKey(true);
    this._onKeyUp = onKey(false);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  _setupTouch() {
    // See _setupDesktop above - intro overlay dropped from walk-mode entry
    // on this path too.

    // --- virtual joystick (movement) ---
    const zone = document.getElementById('joystick-zone');
    const knob = document.getElementById('joystick-knob');
    this._zone = zone;
    let joyTouchId = null;
    const joyVec = { x: 0, y: 0 };

    this._onZoneTouchStart = (e) => {
      const t = e.changedTouches[0];
      joyTouchId = t.identifier;
    };
    this._onZoneTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyTouchId) continue;
        const rect = zone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = t.clientX - cx;
        const dy = t.clientY - cy;
        const max = rect.width / 2;
        const len = Math.min(Math.hypot(dx, dy), max);
        const ang = Math.atan2(dy, dx);
        joyVec.x = (Math.cos(ang) * len) / max;
        joyVec.y = (Math.sin(ang) * len) / max;
        knob.style.transform = `translate(${joyVec.x * max}px, ${joyVec.y * max}px)`;
      }
      e.preventDefault();
    };
    this._onZoneReset = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyTouchId) continue;
        joyTouchId = null;
        joyVec.x = 0; joyVec.y = 0;
        knob.style.transform = 'translate(0px, 0px)';
      }
    };
    zone.addEventListener('touchstart', this._onZoneTouchStart);
    zone.addEventListener('touchmove', this._onZoneTouchMove, { passive: false });
    zone.addEventListener('touchend', this._onZoneReset);
    zone.addEventListener('touchcancel', this._onZoneReset);
    this._joyVec = joyVec;

    // --- drag anywhere else on screen to look around ---
    let lookTouchId = null;
    let lastX = 0, lastY = 0;

    this._onDomTouchStart = (e) => {
      for (const t of e.changedTouches) {
        if (zone.contains(t.target)) continue; // joystick handles its own touch
        if (lookTouchId !== null) continue;
        lookTouchId = t.identifier;
        lastX = t.clientX; lastY = t.clientY;
      }
    };
    this._onDomTouchMove = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookTouchId) continue;
        const dx = t.clientX - lastX;
        const dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        this.yaw -= dx * LOOK_SENSITIVITY;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK_SENSITIVITY, -1.2, 1.2);
      }
    };
    this._onDomTouchReset = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === lookTouchId) lookTouchId = null;
      }
    };
    this.domElement.addEventListener('touchstart', this._onDomTouchStart);
    this.domElement.addEventListener('touchmove', this._onDomTouchMove, { passive: true });
    this.domElement.addEventListener('touchend', this._onDomTouchReset);
    this.domElement.addEventListener('touchcancel', this._onDomTouchReset);
  }

  // Removes every listener added in _setupDesktop/_setupTouch. Call before
  // dropping a Controls instance (see main.js's startReturnToTitle) - without
  // this, every walk-mode session leaves its window/document-level listeners
  // behind forever since a brand new Controls gets constructed each time you
  // re-enter walk mode.
  dispose() {
    if (this.isMobile) {
      this._zone?.removeEventListener('touchstart', this._onZoneTouchStart);
      this._zone?.removeEventListener('touchmove', this._onZoneTouchMove);
      this._zone?.removeEventListener('touchend', this._onZoneReset);
      this._zone?.removeEventListener('touchcancel', this._onZoneReset);
      this.domElement.removeEventListener('touchstart', this._onDomTouchStart);
      this.domElement.removeEventListener('touchmove', this._onDomTouchMove);
      this.domElement.removeEventListener('touchend', this._onDomTouchReset);
      this.domElement.removeEventListener('touchcancel', this._onDomTouchReset);
    } else {
      this.domElement.removeEventListener('mousedown', this._onMouseDown);
      window.removeEventListener('mousemove', this._onWindowMouseMove);
      window.removeEventListener('mouseup', this._onWindowMouseUp);
      window.removeEventListener('blur', this._onWindowBlur);
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('keyup', this._onKeyUp);
    }
  }

  update(delta) {
    if (this.locked) return; // vinylInteraction.js owns the camera right now

    const speed = this.move.run ? RUN_SPEED : WALK_SPEED;

    // Explore-mode look clamp, if active - clamped on `this.yaw` itself
    // (not just the camera's rotation below) so drag-look/joystick input
    // pushing past the limit doesn't accumulate somewhere it'll "spring
    // back from" once the clamp lifts - it just stops dead at the edge,
    // same as the position clamps further down.
    if (this.yawClamp) {
      this.yaw = THREE.MathUtils.clamp(this.yaw, this.yawClamp.min, this.yawClamp.max);
    }

    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
    const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, this.yaw, 0));

    let inputX = 0;
    let inputY = 0; // positive = move backward, negative = move forward

    if (this.isMobile) {
      inputX = this._joyVec.x;
      inputY = this._joyVec.y;
    } else {
      inputX = Number(this.move.right) - Number(this.move.left);
      inputY = Number(this.move.back) - Number(this.move.forward);
    }

    const inputMagnitude = Math.min(1, Math.hypot(inputX, inputY));
    const isMoving = inputMagnitude > 0.05;

    const move = fwd.multiplyScalar(-inputY).add(right.multiplyScalar(inputX));

    // only updates while actually walking - stays put while you're just
    // looking around stationary. Reverted from an attempt to derive this
    // from the movement vector's direction (via atan2) - that formula
    // didn't match how direction vectors are built from yaw elsewhere in
    // this file (fwd/right above), so it came out 180 degrees off and
    // pointed the companion's anchor the wrong way. This is simpler and
    // correct: just tracks view direction while any movement key is held.
    if (isMoving) this.moveHeading = this.yaw;
    if (move.lengthSq() > 0) {
      if (move.length() > 1) move.normalize();
      move.multiplyScalar(speed * delta);
      this.camera.position.add(move);
    }

    // footstep bob: fade the intensity toward 0 or full strength instead of
    // snapping, so starting/stopping doesn't pop, and only advance the phase
    // while actually moving so it doesn't keep bobbing after you stop.
    const bobFadeAmount = 1 - Math.exp(-BOB_FADE_SPEED * delta);
    this._bobIntensity += ((isMoving ? inputMagnitude : 0) - this._bobIntensity) * bobFadeAmount;
    if (isMoving) {
      this._bobPhase += delta * (this.move.run ? BOB_FREQUENCY_RUN : BOB_FREQUENCY_WALK);
    }
    const bobOffset = Math.sin(this._bobPhase) * BOB_AMPLITUDE * this._bobIntensity;

    // keep the player inside the market and at eye height (+ footstep bob)
    this.camera.position.y = EYE_HEIGHT + bobOffset;
    const distFromCenter = Math.hypot(this.camera.position.x, this.camera.position.z);
    if (distFromCenter > WORLD_RADIUS) {
      const scale = WORLD_RADIUS / distFromCenter;
      this.camera.position.x *= scale;
      this.camera.position.z *= scale;
    }
    if (this.camera.position.x > X_MAX) {
      this.camera.position.x = X_MAX;
    }
    if (this.camera.position.z < Z_MIN) {
      this.camera.position.z = Z_MIN;
    }
  }
}
