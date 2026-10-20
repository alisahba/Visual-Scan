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

All three map sound to the image. Paint is the default.

**Paint**. The image is the canvas, and the sound paints over it in place.

1. The image's pixels are ranked by brightness, so every tone points to real pixels.
2. The detected pitch picks a tone: high notes take dark pixels, low notes light
   (switchable). Pitch is equalised against the track's own range, so every tone
   in the image gets visited over a song. Drums with no clear note use the
   brightness of the sound instead.
3. A walker picks a nearby pixel of that tone and joins it to the last pick with a
   stroke. Strokes snap to a pixel grid that starts coarse (big pixels) and halves
   step by step to fine detail over the pass.
4. The line moves with the track's energy (loudness against its own recent
   average): it rests in breakdowns and races in drops. The walk favours parts it
   hasn't painted.
5. Each kind of hit leaves its own mark: **kick** = a leap and a solid block,
   **snare** = a fan of lines, **hi-hat** = sparks of same-tone pixels. With Guides
   on, hits are outlined where they land and a strip at the bottom shows the last
   8 seconds of kicks, snares, hats and tone.

Tones are ranked by the image's range of values (weighted by the square root of
pixel counts), so a big flat background doesn't swallow half the notes.

Ink: **Colour** (gradient between the two picked pixels), **Clone** (the stroke
carries a strip of the image from where the walk just was), **Smear** (drags
the canvas's own colours). Drag on the canvas to steer the walk.

**Thread**. Each canvas column is the image's pixels along the line joining
where the walk is now to where it has been.

**Scan**. Slit-scan: a slit crosses the image and the sound moves, bends and
stretches it.

## Default media

On startup the app loads `public/demo/daffodil.jpg` and `public/demo/acid-dream.mp3`
if they exist. They are third-party files, so `public/demo/` is gitignored and
not part of the public build; without them the demo button renders a synthesised
track instead.

## Everything else

- Canvas: one pass per track (completes when the song ends) or loop
- Drag the canvas: seek (pass) or scratch-paint with the head (loop)
- Export: PNG and video with audio
- Panel: drag its edge to resize (double-click resets), P hides it, section headers fold
- Keys: Space play · E engine · C clear · S PNG · R record · F perform · P panel · 1–4 presets
- Built-in demo: a drawn image and a synthesised 60-second track
