// ---------------------------------------------------------------------------
// Interactable affordance - "add a cute video game effect to clickable things
// so ppl know to interact with them. like a flash or glow or twinkle."
//
// This is a SPARKLE system, not a glow/outline system, and that choice is
// deliberate. The two obvious alternatives both break against how this scene
// is actually built:
//
//   - Emissive pulse. Mobile runs everything unlit (world.js swaps every
//     material to MeshBasicMaterial - see the IS_MOBILE branch there), and
//     MeshBasicMaterial has no emissive channel at all. So an emissive
//     animation would be invisible on exactly the platform that most needs
//     the hint, since a phone has no hover state to discover things with.
//
//   - Scaled-up BackSide shell (the classic selection outline). Needs closed,
//     solid geometry to read correctly. The vinyl WALL is effectively a flat
//     display panel, and a back-face shell on flat geometry just renders an
//     offset copy poking out from behind it.
//
// Sparkles sidestep both: they never touch the object's material or geometry,
// so they look identical lit or unlit, on any mesh shape, on any platform.
// They also cost almost nothing - one shared 64px canvas texture, a handful of
// additive sprites, and they're culled entirely (group.visible = false, so
// three skips the whole subtree) whenever you're too far away to care.
//
// Placement is derived from the mesh's own world bounding box at runtime
// rather than from hand-entered coordinates. Draco strips accessor min/max
// from the FILE (which is why UV ranges can't be read offline), but three
// computes bounding boxes from the decoded position attribute in memory, so
// Box3.setFromObject is exact here and stays correct if you ever move the
// object in Blender.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const IS_MOBILE = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// Four-point twinkle star, drawn once and shared by every sprite. Canvas
// rather than a file so there's no extra request on the critical path and
// nothing else to keep in sync in public/.
let sparkleTexture = null;
function getSparkleTexture() {
  if (sparkleTexture) return sparkleTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const mid = size / 2;

  // Soft core so the star has a bright centre rather than four bare spikes.
  const glow = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.42);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.5, 'rgba(255,243,214,0.55)');
  glow.addColorStop(1, 'rgba(255,243,214,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Four tapered spikes. Drawn as triangles meeting at the centre - the
  // pinched-waist look of a game-UI sparkle, not a plus sign.
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  const arm = mid * 0.96;
  const waist = mid * 0.13;
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(mid, mid);
    ctx.rotate((i * Math.PI) / 2);
    ctx.beginPath();
    ctx.moveTo(0, -arm);
    ctx.lineTo(waist, 0);
    ctx.lineTo(0, arm * 0.06);
    ctx.lineTo(-waist, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  sparkleTexture = new THREE.CanvasTexture(c);
  sparkleTexture.colorSpace = THREE.SRGBColorSpace;
  // NearestFilter on mobile to match the deliberate DS-era pixel look the
  // rest of the scene uses (see loader.js's applyPixelFiltering) - a smoothly
  // filtered sparkle would be the one soft-edged thing on screen.
  if (IS_MOBILE) {
    sparkleTexture.magFilter = THREE.NearestFilter;
    sparkleTexture.minFilter = THREE.NearestFilter;
  }
  return sparkleTexture;
}

const SPARKLE_COUNT = IS_MOBILE ? 4 : 6;

export class Interactables {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.entries = [];
    this.group = new THREE.Group();
    this.group.name = 'interactable-sparkles';
    // renderOrder + depthWrite:false keeps sparkles from punching holes in
    // anything drawn after them; depthTest stays ON so a sparkle behind the
    // counter is correctly hidden by it rather than floating through walls.
    this.group.renderOrder = 10;
    scene.add(this.group);
    this._tmpBox = new THREE.Box3();
    this._tmpVec = new THREE.Vector3();
  }

  /**
   * Register one clickable thing.
   * @param {object} spec
   * @param {string} spec.key            unique id, for debugging
   * @param {string[]} spec.meshNames    glTF-sanitized node names (see world.js's sanitizeGltfName)
   * @param {number} [spec.range]        camera distance at which sparkles are fully on
   * @param {number} [spec.spread]       how far outside the bounding box sparkles drift, in metres
   */
  register(spec) {
    this.entries.push({
      key: spec.key,
      meshNames: spec.meshNames,
      range: spec.range ?? 7,
      spread: spec.spread ?? 0.25,
      bound: false,
      anchor: null,
      sprites: [],
    });
  }

  /**
   * Resolve every registered entry against the loaded street scene and build
   * its sprites. Safe to call repeatedly - each entry binds at most once.
   * Called lazily from tick() the same way titleScreen.bindSigns and
   * vinylInteraction.bindTarget are, since none of these nodes exist until
   * the street GLB finishes loading.
   */
  bind(street) {
    if (!street) return;
    for (const entry of this.entries) {
      if (entry.bound) continue;
      const meshes = entry.meshNames
        .map((n) => street.getObjectByName(n))
        .filter((o) => o && o.isMesh);
      if (meshes.length === 0) continue; // not loaded yet, or renamed by a Blender join - try again next frame

      // Union of every named mesh's world bounds - one sparkle cloud over the
      // whole display rather than one per sub-mesh.
      this._tmpBox.makeEmpty();
      for (const m of meshes) this._tmpBox.expandByObject(m);
      if (this._tmpBox.isEmpty()) continue;

      const center = this._tmpBox.getCenter(new THREE.Vector3());
      const size = this._tmpBox.getSize(new THREE.Vector3());
      entry.anchor = center;

      // Sprite size scales with the object so a whole wall of records and a
      // single record player each get proportionate sparkles, clamped so
      // neither extreme goes silly.
      const scale = THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 0.09, 0.07, 0.2);

      const material = new THREE.SpriteMaterial({
        map: getSparkleTexture(),
        color: 0xfff0c8,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0,
      });

      for (let i = 0; i < SPARKLE_COUNT; i++) {
        const sprite = new THREE.Sprite(material.clone());
        sprite.scale.setScalar(scale);
        // Scattered over the object's own bounding box, biased toward the
        // front face so they read against the object rather than inside it.
        sprite.userData.base = new THREE.Vector3(
          center.x + (Math.random() - 0.5) * (size.x + entry.spread),
          center.y + (Math.random() - 0.5) * (size.y + entry.spread),
          center.z + (Math.random() - 0.5) * (size.z + entry.spread)
        );
        // Staggered phase + slightly different speeds so they twinkle
        // independently instead of blinking in unison.
        sprite.userData.phase = Math.random() * Math.PI * 2;
        sprite.userData.speed = 1.6 + Math.random() * 1.4;
        sprite.userData.bob = 0.04 + Math.random() * 0.05;
        sprite.userData.baseScale = scale;
        sprite.position.copy(sprite.userData.base);
        this.group.add(sprite);
        entry.sprites.push(sprite);
      }
      entry.bound = true;
    }
  }

  /**
   * @param {number} elapsed seconds since start - shared with the sign flicker
   *                 and film grain so everything animates off one clock.
   */
  update(elapsed) {
    if (this.entries.length === 0) return;
    const camPos = this.camera.position;

    for (const entry of this.entries) {
      if (!entry.bound) continue;
      const dist = camPos.distanceTo(entry.anchor);
      // Fade band rather than a hard cutoff, so sparkles bloom in as you
      // approach instead of popping. Fully on at `range`, gone by range * 1.6.
      const outer = entry.range * 1.6;
      const proximity = THREE.MathUtils.clamp((outer - dist) / (outer - entry.range), 0, 1);

      for (const sprite of entry.sprites) {
        if (proximity <= 0) {
          sprite.visible = false;
          continue;
        }
        sprite.visible = true;
        const { base, phase, speed, bob, baseScale } = sprite.userData;
        // sin^4 rather than plain sin: mostly dark with a brief bright peak,
        // which reads as a twinkle. A raw sine reads as a slow throb.
        const t = Math.sin(elapsed * speed + phase);
        const twinkle = Math.pow(Math.max(t, 0), 4);
        sprite.material.opacity = twinkle * proximity;
        // Scale pulses along with opacity - a sparkle that only fades looks
        // like a dimming lamp; one that grows as it brightens reads as a pop.
        sprite.scale.setScalar(baseScale * (0.55 + 0.65 * twinkle));
        // Gentle drift so the cloud isn't frozen in place between blinks.
        sprite.position.y = base.y + Math.sin(elapsed * 0.8 + phase) * bob;
      }
    }
  }

  dispose() {
    for (const entry of this.entries) {
      for (const sprite of entry.sprites) sprite.material.dispose();
      entry.sprites.length = 0;
      entry.bound = false;
    }
    this.group.removeFromParent();
  }
}
