import { defineConfig } from 'vite';

// Relative base so the build works from any path (e.g. GitHub Pages project sites).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
