import { defineConfig } from 'vite';

// Relative base so the build works from any path (e.g. GitHub Pages project sites).
// `--mode artifact` inlines every asset so scripts/artifact.mjs can fold the
// build into one self-contained HTML page.
export default defineConfig(({ mode }) => ({
  base: './',
  build:
    mode === 'artifact'
      ? {
          target: 'es2022',
          outDir: 'dist-artifact',
          assetsInlineLimit: 50_000_000,
          cssCodeSplit: false,
          modulePreload: { polyfill: false },
        }
      : { target: 'es2022' },
}));
