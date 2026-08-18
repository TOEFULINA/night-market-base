Drop your exported .glb sculpts here (e.g. record-stall.glb, lantern.glb).

Export checklist from Blender:
- Enable Draco compression in the glTF export panel (geometry compression - loader.js already decodes it)
- Bake your lighting/shading into a single diffuse texture per object where possible, rather than exporting separate normal/roughness/metalness maps - keeps both file size and material complexity down
- Keep texture resolution proportional to how close the player gets - 2K max for hero/close-up props, 512-1024 for background clutter
- Apply all transforms and join what you can before export - fewer objects/materials = fewer draw calls

Then load them from src/world.js using loadModel() from src/loader.js:

  import { loadModel } from './loader.js';
  const { scene: stall } = await loadModel('/models/record-stall.glb');
  stall.position.set(4, 0, -2);
  scene.add(stall);
