// ---------------------------------------------------------------------------
// Model/texture loading pipeline.
//
// This is the piece that mattered most for ROOM's 70MB problem: raw .glb
// exports and uncompressed textures. Two things fix that at the loader level:
//
// 1. DRACOLoader compresses mesh geometry (positions/normals/UVs) - typically
//    a 5-10x reduction on geometry with no visible quality loss. Export your
//    Blender sculpts with Draco compression on (glTF export panel has the
//    checkbox), this loader already knows how to decode it. Confirmed this
//    is already doing its job on TRY4_SCENE.glb - geometry is only ~2.6MB of
//    the file's 90.7MB total. The other ~87MB (96%) is texture bytes (533
//    JPEG/PNG images), which is where all the size actually lives.
//
// 2. KTX2Loader (Basis Universal) compresses textures into a GPU-native
//    format instead of shipping raw PNG/JPG. Wired up below now (needs
//    initKtx2Loader(renderer) called once with the renderer, same reason
//    buildWorld needs the renderer - Basis has to pick a transcode target
//    format based on what the GPU actually supports).
//
//    This is a different fix than just "smaller download": JPEG/PNG get
//    decoded to a full uncompressed RGBA bitmap in GPU memory at load time
//    no matter how well-compressed the file is - a 1536px texture is ~9MB
//    of VRAM once decoded, times 533 images, regardless of whether the file
//    on disk is JPEG or PNG. KTX2/Basis textures stay block-compressed ON
//    the GPU (no full decode step), typically ~4-6x less VRAM for the same
//    visible resolution - that's the actual lever for "runs better, room to
//    add more," not just a smaller download.
//
//    Can't produce the .ktx2-compressed GLB from inside this environment -
//    that needs the gltf-transform CLI's Basis encoder, which needs npm
//    package access this sandbox's network policy blocks. Run this on your
//    own machine (regular npm access, no sandbox restriction) from the
//    RAW/highest-quality source export, not the already-JPEG-compressed
//    TRY4_SCENE.glb currently in public/models (re-compressing an already-
//    lossy JPEG into Basis compounds artifacts instead of just shrinking
//    the file):
//
//      npx @gltf-transform/cli etc1s TRY4_RAW_SOURCE.glb TRY4_SCENE.glb \
//        --quality 255 --power-of-two
//
//    (`--power-of-two` resizes textures up/down to the nearest power-of-two
//    edge length if they aren't already, which Basis requires internally -
//    won't touch anything already at a pow2 size like 1536... actually 1536
//    isn't pow2, so this WILL resample to 2048 or 1024. If you want to stay
//    exactly at 1536, export square power-of-two bakes from Blender instead
//    - 2048 - before running this, or use `uastc` mode instead of `etc1s`,
//    which doesn't have the pow2 requirement but compresses less.)
//    Drop the resulting file in as public/models/TRY4_SCENE.glb once it
//    looks right - loader.js below already knows how to decode it.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

const manager = new THREE.LoadingManager();
// Exported so world.js can manually extend what this manager tracks (see
// its itemStart/itemEnd use around addStreetScene) - LoadingManager's
// onLoad/loading-screen-hide only knows about Loader calls that actually
// go through it; folding in work that ISN'T itself a loadModel() call (like
// "wait for the rebake swaps to finish too, not just the base file") needs
// this exposed rather than kept private to this file.
export { manager as loadingManager };

const dracoLoader = new DRACOLoader(manager);
// Google-hosted decoder, no need to vendor the binaries yourself.
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

export const gltfLoader = new GLTFLoader(manager);
gltfLoader.setDRACOLoader(dracoLoader);

export const ktx2Loader = new KTX2Loader(manager);
ktx2Loader.setTranscoderPath('https://unpkg.com/three@0.169.0/examples/jsm/libs/basis/');
gltfLoader.setKTX2Loader(ktx2Loader);

// Needs a renderer instance to detect which compressed-texture formats the
// GPU actually supports, so Basis knows what to transcode into - call this
// once, early, before any model that might contain .ktx2 textures loads.
// Harmless to call even while every model in public/models/ is still plain
// JPEG/PNG (KTX2Loader only gets used for images that are actually .ktx2).
export function initKtx2Loader(renderer) {
  ktx2Loader.detectSupport(renderer);
}

// Loading-screen redesign per "use the same menu icon in the middle on a
// white background... standalone percentage number in helvetica instead of
// a loading bar" - #loading-bar/#loading-label swapped for a single
// #loading-percent element (the wobble on #loading-logo is pure CSS, see
// style.css, nothing to drive from here). Still just text content updates
// on the same manager.onProgress tick, same shape as the old bar-width one.
export function initLoadingUI(onComplete) {
  const percent = document.getElementById('loading-percent');
  const screen = document.getElementById('loading-screen');

  manager.onProgress = (url, loaded, total) => {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    if (percent) percent.textContent = `${pct}%`;
  };

  manager.onLoad = () => {
    screen?.classList.add('hidden');
    onComplete?.();
  };
}

/**
 * Load a glb and return { scene, gltf }. Use this once you're dropping in
 * your own sculpts, e.g.:
 *
 *   const { scene } = await loadModel('/models/record-stall.glb');
 *   scene.position.set(4, 0, -2);
 *   world.add(scene);
 */
export function loadModel(path) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      path,
      (gltf) => resolve({ scene: gltf.scene, gltf }),
      undefined,
      reject
    );
  });
}
