# Visual Scan

Music × image experiments in the browser. Vite + TypeScript + WebGL2, no framework.

```
npm install
npm run dev      # local dev server
npm run build    # static build in dist/ (relative paths, works on GitHub Pages)
```

## Current state

Checkpoint 1 is a slit-scan engine: a write-head crosses the canvas while the
track plays, copying a slit from the source image that the audio bends and moves.

- Sources: image, video, webcam
- Sound: track file or live input (mic / line-in)
- Canvas: one pass per track, or loop
- Export: PNG and video (with audio)
- Keys: Space play · C clear · S PNG · R record · F perform · 1–4 presets
