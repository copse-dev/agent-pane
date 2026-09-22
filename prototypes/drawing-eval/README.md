# Drawing tool evaluation

Side-by-side test bed for framework-free drawing libraries that could let a
person draw to an agent from the canvas or an artefact. Everything loads from
jsdelivr, so no install step; serve the folder over HTTP (the pages use ES
modules, which `file://` blocks):

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory prototypes/drawing-eval
```

Then open <http://127.0.0.1:8765/>.

| Page | Library | Licence | Size | Notes |
| --- | --- | --- | --- | --- |
| `drauu.html` | drauu 1.0.0 | MIT | ~1,300 lines | SVG DOM is the model; stylus mode is perfect-freehand; no selection, pan or zoom |
| `js-draw.html` | js-draw 1.33.0 | MIT | ~31k lines, 496 KB bundle | Infinite canvas, pen with pressure and stabilisation, partial eraser, select, text, SVG load/save |
| `freehand.html` | perfect-freehand 1.2.3 | MIT | ~300 lines | tldraw's ink algorithm alone; the page adds ~120 lines of pointer and undo glue |
| `freehand-rough.html` | perfect-freehand + rough.js 4.6.6 | MIT | +170 KB | Same ink, re-rendered through rough.js for the Excalidraw look, plus rough shapes |

`index.html` frames all four. Every page has a **Send to agent** button which
posts `{ svg, png, meta }` to the parent via `bridge.js`; the index shows the
payload, its size, and the raster so you can judge what a text model and a
vision model would each receive.

Discarded without a page: tldraw (React peer dependency, and its licence
forbids production use without a key), Excalidraw (React), Fabric and Konva
(canvas scene graphs, the drawing tools would all be ours to build).
