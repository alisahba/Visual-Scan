# Visual Scan

An image, played by sound. Upload an image (or video, or webcam) and a track
(or a live input). As the music plays, a new image is generated on an empty
canvas, column by column, until the track ends.

Vite + TypeScript + WebGL2, no framework.

```
npm install
npm run dev      # local dev server
npm run build    # static build in dist/ (relative paths, works on GitHub Pages)
```

## Engines

**Map** (default). Sound values are mapped to pixel values.

1. The image's pixels are ranked by brightness, so every tone points to real pixels.
2. The detected pitch picks a tone: high notes take dark pixels, low notes light
   (switchable). When there's no clear note (drums), the brightness of the sound
   stands in, so kicks read low and hi-hats high.
3. A walker picks a pixel of that tone near its last position. Steady notes trace
   smooth paths along same-tone contours; note changes jump to wherever that tone
   lives in the image. Hits turn the walk, rising and falling pitch swerves it.
4. Each canvas column is the image's pixels along the line joining where the walk
   is now to where it has been, so the canvas becomes a new image made only of the
   source's pixels, arranged by the music.

Controls: Walk (Reach, Momentum, Curl, Wander), Line (Span, Extend, Bend, Glide),
Tone (Contrast, Tolerance, High = dark / light). Drag on the source preview to
move the walker.

**Scan**. Slit-scan: a slit crosses the image and the sound moves, bends and
stretches it.

## Everything else

- Canvas: one pass per track (completes when the song ends) or loop
- Drag the canvas: seek (pass) or scratch-paint with the head (loop)
- Export: PNG and video with audio
- Keys: Space play · E engine · C clear · S PNG · R record · F perform · 1–4 presets
- Built-in demo: a drawn image and a synthesised 60-second track
