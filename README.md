# night-market-base

A walkable, first-person 3D portfolio site — not an orbit/diorama viewer. Built with Vite + vanilla Three.js (no React/game engine). You start on an orthographic title screen framed on a signed corner building, then fly into a first-person walk around a night-market street scene, with a few storefronts ("Explore" spots) you can jump straight to from a menu.

**Live concept:** an art/fashion 3D portfolio site where visitors walk through a market street instead of scrolling a page.

## Run it

    npm install
    npm run dev

Then open the local URL Vite prints.

- **Desktop:** click a sign on the title screen (or a menu item) to enter, then WASD + click-and-drag to look, Shift to run.
- **Mobile:** tap to enter, left joystick to walk, drag anywhere else to look.

## How it works

- **Title screen** (`src/titleScreen.js`) — an orthographic camera framed on the signed building, each sign panel clickable. Subtle mouse-parallax on the camera angle.
- **Corner menu** (`index.html` / `src/main.js`) — Portfolio / Explore / Contact / About, always top-left. On the title screen it's fully expanded; once you're walking, the logo becomes a click-to-toggle dropdown for the same menu, plus a Home item that reloads back to the title screen.
- **Title → walk transition** — a two-phase camera flight: the orthographic title camera flies and zooms in most of the way first (hides perspective-projection distortion/empty background reveal), then hands off to the real perspective camera to finish the approach. Driven by a single continuously-eased curve across the whole flight so there's no stutter at the handoff.
- **Walk mode** (`src/controls.js`) — first-person WASD + drag-look (desktop) or joystick + drag-look (mobile). No physics engine — a flat ground plane plus a soft world-radius/wall clamp instead of real collision.
- **Explore locations** — four fixed storefront spots (archive shop, records, prints/action figures, packaging) wired into `LOCATIONS` in `main.js`. Arriving at one shows `<`/`>` arrows to cycle to the next/previous spot and clamps how far you can look left/right (keeps you facing the dressed set instead of staring into empty space); both go away the instant you move.
- **Vinyl store record-player interaction** (`src/vinylInteraction.js`) — click the record player to lock the camera into a close-up view.
- **Rendering** (`src/world.js`, `src/shading.js`, `src/atmosphere.js`, `src/postprocessing.js`) — real-time shadows, ACES filmic tone mapping, an environment map for PBR materials, bloom, a tilt-shift pass (used for the orthographic title framing), fog, and a floating light-orb/smoke atmosphere layer. Several storefronts are "rebakes" — a base scene (`TRY4_SCENE.glb`) with individual rooms swapped in from separately-exported/optimized `.glb` files at load time (`addStreetScene()` in `world.js`).

## Structure

    src/
      main.js            camera/renderer setup, title<->walk state machine, menu wiring, render loop
      world.js            scene assembly: lighting, fog, loads + assembles the street/market scene and room rebakes
      controls.js          first-person walk (desktop + mobile)
      titleScreen.js        orthographic title camera + sign click/hover
      vinylInteraction.js   record-player click-to-lock camera interaction
      atmosphere.js         floating light-orb / smoke particle layer
      shading.js            unlit/flat material shader helpers (baked-lighting look), sign flicker
      postprocessing.js     bloom + tilt-shift composer passes
      loader.js             shared GLTFLoader/DRACOLoader + loading-manager wiring
    public/
      models/               exported .glb scene + room-rebake files (Draco-compressed, texture-optimized)
      logo.png
    blender/
      consolidate_materials.py   Blender-side script to merge duplicate materials / cut draw-call count

## Known gaps / not wired up yet

- Portfolio submenu items (Graphic Design, Illustration, Merchandise Design, Dynamics, 3D Modeling), Contact, and About don't have real destinations yet — clicking them just logs to the console.
- Per-sign routing on the title screen isn't built — every sign currently enters walk mode at the default spawn.
- `public/models/TRY4_SCENE.glb` is ~87MB; this repo doesn't use Git LFS, so a fresh clone is a fairly large download. Worth moving to LFS (or a CDN) if that becomes a problem.

## Notes on the asset pipeline

Textures are resized/recompressed and geometry is Draco-compressed before landing in `public/models/` — none of that touches your original Blender modeling/materials/geometry, it's a post-export optimization pass. `blender/consolidate_materials.py` is a separate, optional Blender-side script for cutting draw-call count (merges duplicate materials, then joins objects sharing a material) if a scene ever gets heavy enough to need it.
