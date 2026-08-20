// ---------------------------------------------------------------------------
// Cheap ambient "life" layer for the night market - floating light orbs
// drifting up through the street (paper-lantern/ember read) plus a few soft
// ground-level smoke puffs. Built deliberately light on draw calls and CPU
// work, per the project's optimization gap:
//  - The orbs are ONE THREE.Points draw call, animated entirely in the
//    vertex shader off a single uTime uniform - no per-particle JS work
//    per frame no matter how many orbs there are.
//  - The smoke is a small, fixed number of billboard sprites (see
//    SMOKE_EMITTER_POSITIONS) updated in plain JS, which is fine because
//    the count stays small on purpose - this is a look, not a real sim.
//
// This is a NEW system, not a revival of the old lamp-glow sprite hack that
// used to live in world.js (see the big comment near the bottom of that
// file for why it got removed). That hack broke because it hung sprites off
// merged-mesh node positions read via getWorldPosition() - once meshes got
// merged by material in Blender, "the lamp material's node" could suddenly
// mean a much bigger/different chunk of geometry, so the sprite ended up in
// the wrong place. Everything here uses its own hand-authored positions -
// nothing is derived from a GLB node transform, so it can't inherit that bug.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// "make the volumetric fog black" - was a light grey/lavender (205,200,215),
// matching the purple-grey street fog's tone. Straight black now instead.
function makeSmokeTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.5)');
  gradient.addColorStop(0.5, 'rgba(0,0,0,0.2)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// --- Floating light orbs ---------------------------------------------------
// Warm amber/ember tones (matching the sun/hemisphere palette in world.js),
// with a scattering of cool magenta ones for variety. Spread across the
// walkable area (ORB_XZ_RADIUS stays inside WORLD_RADIUS=30 from
// controls.js) at a height band that reads above head-level but below
// rooftops (scene bounds were measured at y -5.3..28.5 when TRY4_SCENE.glb
// was wired in).
const ORB_COUNT = 90;
const ORB_XZ_RADIUS = 24;
const ORB_Y_MIN = 3;
const ORB_Y_MAX = 16;

const ORB_VERTEX_SHADER = `
  uniform float uTime;
  attribute float aSeed;
  attribute float aSpeed;
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec3 p = position;
    float riseSpan = ${(ORB_Y_MAX - ORB_Y_MIN).toFixed(1)};
    // slow continuous rise, wraps back to the bottom of the band once an
    // orb tops out - each orb offset by aSpeed/aSeed so they don't move
    // in lockstep
    float y = mod((p.y - ${ORB_Y_MIN.toFixed(1)}) + uTime * aSpeed, riseSpan) + ${ORB_Y_MIN.toFixed(1)};
    p.x += sin(uTime * 0.3 + aSeed * 6.2831) * 0.6;
    p.z += cos(uTime * 0.25 + aSeed * 6.2831) * 0.6;
    p.y = y + sin(uTime * 0.6 + aSeed * 6.2831) * 0.3;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    // approximate perspective size attenuation - 200.0 is just a tuned
    // constant for "reads as a small glowing orb at normal walking
    // distance", not a physical unit
    gl_PointSize = aSize * (200.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const ORB_FRAGMENT_SHADER = `
  uniform sampler2D uMap;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    if (tex.a < 0.02) discard;
    gl_FragColor = vec4(vColor, 1.0) * tex;
  }
`;

function createLightOrbs() {
  const positions = new Float32Array(ORB_COUNT * 3);
  const colors = new Float32Array(ORB_COUNT * 3);
  const seeds = new Float32Array(ORB_COUNT);
  const speeds = new Float32Array(ORB_COUNT);
  const sizes = new Float32Array(ORB_COUNT);

  const warmA = new THREE.Color(0xffb066);
  const warmB = new THREE.Color(0xff8c5c);
  const cool = new THREE.Color(0xb98cff);

  for (let i = 0; i < ORB_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * ORB_XZ_RADIUS; // sqrt so density is even across the disc, not bunched at center
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = ORB_Y_MIN + Math.random() * (ORB_Y_MAX - ORB_Y_MIN);
    positions[i * 3 + 2] = Math.sin(angle) * r;

    const roll = Math.random();
    const c = roll < 0.2 ? cool : roll < 0.6 ? warmA : warmB;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;

    seeds[i] = Math.random();
    speeds[i] = 0.15 + Math.random() * 0.25;
    // occasional bigger "hero" orb among mostly small ones
    sizes[i] = Math.random() < 0.15 ? 1.4 + Math.random() * 0.8 : 0.4 + Math.random() * 0.6;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uMap: { value: makeGlowTexture() },
    },
    vertexShader: ORB_VERTEX_SHADER,
    fragmentShader: ORB_FRAGMENT_SHADER,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  // positions are spread across the whole walkable radius, not clustered
  // near the origin - three.js's default frustum-cull bounding sphere is
  // computed from the geometry, so this is technically unnecessary, but
  // explicit here since it's a custom vertex shader moving points outside
  // their authored positions (the cull check wouldn't know about that).
  points.frustumCulled = false;
  return points;
}

// --- Ground-level smoke -----------------------------------------------------
// A handful of soft billboard sprites per emitter, staggered on a looping
// life cycle - not a real particle sim, just enough puffs to read as smoke.
// Cheap enough to update in plain JS since the total count stays small.
//
// Placeholder positions spread loosely along the street - not tied to any
// actual stall/chimney geometry in TRY4_SCENE.glb (nothing here reads node
// positions, on purpose - see the file header). Move these to sit over your
// actual food-stall/grill spots whenever you've got exact coordinates for
// them.
const SMOKE_EMITTER_POSITIONS = [
  [-10, 0.2, 2],
  [-3, 0.2, -6],
  [4, 0.2, 4],
  [10, 0.2, -3],
];
const PUFFS_PER_EMITTER = 5;

function createSmoke() {
  const group = new THREE.Group();
  const texture = makeSmokeTexture();
  const puffs = [];

  for (const [x, y, z] of SMOKE_EMITTER_POSITIONS) {
    for (let i = 0; i < PUFFS_PER_EMITTER; i++) {
      // each puff gets its own material instance so opacity can animate
      // independently - texture itself is still shared/reused, so this is
      // just a handful of small material objects, not extra GPU memory.
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(0.2);
      group.add(sprite);
      puffs.push({
        sprite,
        origin: new THREE.Vector3(x, y, z),
        life: Math.random(), // 0..1, staggered so puffs don't spawn in sync
        speed: 0.1 + Math.random() * 0.06,
        drift: (Math.random() - 0.5) * 0.5,
        maxScale: 1.4 + Math.random() * 1.2,
      });
    }
  }

  return { group, puffs };
}

function updateSmoke(puffs, delta) {
  for (const puff of puffs) {
    puff.life += puff.speed * delta;
    if (puff.life > 1) puff.life -= 1;
    const t = puff.life; // 0 = spawn, 1 = fully dissipated
    puff.sprite.position.y = puff.origin.y + t * 3.5;
    puff.sprite.position.x = puff.origin.x + puff.drift * t;
    puff.sprite.scale.setScalar(0.2 + t * puff.maxScale);
    // fast fade-in, slow fade-out - reads more like real smoke dispersing
    // than a symmetric triangle fade would
    puff.sprite.material.opacity = t < 0.15 ? (t / 0.15) * 0.35 : 0.35 * (1 - (t - 0.15) / 0.85);
  }
}

// --- Twinkling stars --------------------------------------------------------
// Real animated stars, replacing the star dots that used to be baked
// directly into world.js's sky gradient canvas - a static canvas texture
// can't animate, and redrawing/re-uploading that whole texture every frame
// just to fake a twinkle would be wasteful. This is the same trick as the
// light orbs above: one Points draw call, brightness animated per-star
// entirely in the fragment shader off a single shared uTime uniform, no
// per-star JS work per frame.
//
// Positioned on a big sphere shell (radius 140) rather than baked into a
// flat background image - real depth means buildings correctly occlude
// stars behind them via the normal z-buffer, and there's no scale/
// magnification risk like the old skyline texture had, since each star
// is a fixed-size point sprite, not a stretched image. Restricted to the
// upper hemisphere (y > 0.2 in the unit-sphere sample) so none spawn below
// the horizon where they'd never be visible anyway.
const STAR_COUNT = 300;
const STAR_RADIUS = 140;

const STAR_VERTEX_SHADER = `
  uniform float uTime;
  attribute float aSeed;
  attribute float aSpeed;
  varying float vBrightness;
  void main() {
    // twinkle only (no movement - these are meant to read as fixed/distant)
    vBrightness = 0.55 + 0.45 * sin(uTime * aSpeed + aSeed * 6.2831);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 1.6;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAGMENT_SHADER = `
  varying float vBrightness;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d) * vBrightness;
    gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
  }
`;

function createStars() {
  const positions = new Float32Array(STAR_COUNT * 3);
  const seeds = new Float32Array(STAR_COUNT);
  const speeds = new Float32Array(STAR_COUNT);

  for (let i = 0; i < STAR_COUNT; i++) {
    // rejection-sample a random point on the unit sphere, restricted to the
    // upper hemisphere - simpler and less distorted than deriving from
    // spherical angles directly
    let x, y, z;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
    } while (x * x + y * y + z * z > 1 || y < 0.2);
    const len = Math.hypot(x, y, z) || 1;
    positions[i * 3] = (x / len) * STAR_RADIUS;
    positions[i * 3 + 1] = (y / len) * STAR_RADIUS;
    positions[i * 3 + 2] = (z / len) * STAR_RADIUS;

    seeds[i] = Math.random() * 1000;
    speeds[i] = 0.3 + Math.random() * 1.4; // varied twinkle rates so they don't pulse in lockstep
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Points(geometry, material);
}

export function createAtmosphere(scene) {
  const orbs = createLightOrbs();
  scene.add(orbs);

  const { group: smokeGroup, puffs } = createSmoke();
  scene.add(smokeGroup);

  const stars = createStars();
  scene.add(stars);

  return {
    update(elapsed, delta) {
      orbs.material.uniforms.uTime.value = elapsed;
      stars.material.uniforms.uTime.value = elapsed;
      updateSmoke(puffs, delta);
    },
  };
}
