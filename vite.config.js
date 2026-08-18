import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so it deploys cleanly to GitHub Pages (matches ROOM's setup)
  base: './',
  build: {
    // don't inline big binary assets (models/textures) as base64 -
    // that bloats the JS bundle and defeats caching. Keep them as
    // separate files the browser can cache/stream independently.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
