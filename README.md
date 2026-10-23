# DXF Viewer

A single-file, read-only **DXF** viewer with exact measurement tools.

- It runs in any current Chromium-based browser or Firefox on Windows, macOS and Linux.
- It has **no dependencies and makes no network requests**: parser, renderer (WebGL2) and geometry are all inside `dxf-viewer.html`, so it works offline from `file://`.
- Files never leave your machine.

```
open dxf-viewer.html            # macOS
xdg-open dxf-viewer.html        # Linux
start dxf-viewer.html           # Windows
```

Drop a `.dxf` file on the window, or use **Open**. **Load sample drawing** opens a small built-in bracket with holes, slots, a spline, a hatch, a dimension and PCB-style traces. You can also open a file by URL: `dxf-viewer.html?file=https://…/part.dxf` (the server must allow CORS).

## Measurement tools

Every result is computed from the **true geometry in the file**: lines, circular arcs, polyline bulges, ellipses and NURBS. The on-screen tessellation is never used. Results are listed in the right panel, can be deleted, and can be copied as text or CSV.

| Tool | Key | What it measures |
|---|---|---|
| Inspect | `I` | Click an entity to see its properties: layer, colour, linetype, lineweight, handle, block reference, and full geometry (endpoints, length, R/Ø, sweep, arc length, chord, area/centroid of closed entities, spline degree). A dimension shows its measured value. **Shift+click** adds to the selection and shows totals (count, total length, total area). |
| Distance | `D` | Two snapped points give the distance, ΔX, ΔY and angle. |
| Path | `L` | A chain of points gives each segment and the total. Finish with Enter, a double-click or a right-click; Backspace removes the last point. |
| Area | `A` | Click an **edge** of a closed contour for its exact area, perimeter and centroid. The contour can be built from separate lines and arcs that only touch end to end, e.g. a laser outline. Click **inside** a region for its net area: the innermost closed contour minus the contours directly inside it (holes, slots). An open contour is highlighted so you can find the gap. |
| Polygon | `P` | Click corners for the area, perimeter and centroid. Close the polygon by clicking the first point, Enter or a double-click. |
| Angle | `G` | Click two lines for the angle between them (plus its supplement, and the gap if they are parallel). Alternatively, click a vertex and then two points. |
| Radius | `R` | Click an arc, a circle, a polyline arc segment or an ellipse. You get R, Ø, centre, sweep, arc length and chord; an ellipse shows both semi-axes and its rotation. |
| Min distance | `M` | Click two entities for the shortest distance between them, with witness points. Circles also show the centre distance; parallel lines show the perpendicular gap and the angle. Two clicks on the **same** entity measure between the two clicked segments, e.g. the wall thickness across one outline. |
| Coordinate | `C` | Click a snapped point to label its X, Y. |

**Snaps** (AutoCAD-style, each can be switched on or off in the *Snaps* menu):
- **Point snaps:** endpoint, midpoint (by arc length), centre, quadrant, intersection, node / insertion point.
- **Snaps relative to the previous point:** perpendicular and tangent.
- **Nearest point on a curve.**
- A glyph and a label show which snap is active.
- **Tab** cycles through overlapping candidates, **Shift** constrains to horizontal or vertical (ortho), and **Alt** suspends snapping.

**Units:**
- The drawing unit comes from `$INSUNITS`. Unitless files are assumed to be mm or in, from `$MEASUREMENT`, and the *Drawing* menu overrides this.
- *Show* converts every label to mm, cm, m, µm, in, mil, ft or ft-in.
- Precision applies everywhere. Angles can be shown in degrees, D°M′S″ or radians.

## Info panel (for CNC, laser and PCB work)

- Extents: width and height (stock size), min and max; version, units and encoding.
- **Contours:** the number of closed and open contours and open ends. It can mark the open ends in the drawing and lists the smallest gaps between ends; click a gap to zoom to it.
- **Hole table:** full circles grouped by diameter, with counts. Click a row to highlight those holes.
- **Length by layer:** total geometry length per layer, i.e. cut or trace length.

Dimension, leader and viewport geometry is excluded from contours, regions and these totals.

## Viewing

- **Mouse:** drag pans (left or middle button), the wheel zooms at the cursor, and a two-finger pinch works on touch screens.
- **Zoom window:** `W`, or Ctrl/Cmd+drag. **Fit:** `F`.
- **Layers:** a toggle per layer; double-click a name to isolate it. Layers that are off or frozen in the file start hidden.
- **Layouts:** model space, plus paper-space layouts. Model content is drawn through rectangular, unrotated viewports.
- **Toggles:** Lineweights, Linetypes (dash patterns), Text, Fills (hatches, solids, wide polylines).
- **Theme:** auto, dark or light. ACI colour 7 is white on dark and black on light. Very light colours are darkened slightly on the light background.

## Supported DXF content

- **Files:** ASCII and **binary** DXF, R12 to 2018. Text is UTF-8 or the `$DWGCODEPAGE` code page, for example ANSI_1251.
- **Entities:**
  - LINE, CIRCLE, ARC, ELLIPSE, POINT
  - LWPOLYLINE and POLYLINE: bulges, constant and per-vertex width (drawn filled), 3D polylines, polyface and polygon meshes as edges
  - SPLINE: control points, rational weights, closed/periodic, and fit-point-only
  - TEXT, MTEXT (formatting codes stripped, word wrap), ATTRIB/ATTDEF
  - INSERT: nested blocks, non-uniform and mirrored scales, MINSERT arrays
  - DIMENSION (through its block), LEADER, basic MULTILEADER
  - SOLID, TRACE, 3DFACE
  - HATCH: polyline and line/arc/ellipse/spline edge loops, holes, solid fill and pattern lines
  - XLINE/RAY (clipped to the extents), VIEWPORT, IMAGE/WIPEOUT (as frames)
- **Colours:** BYLAYER/BYBLOCK colour, linetype and lineweight, and true colour.
- **Coordinate systems:** OCS (the arbitrary-axis algorithm, so arcs with extrusion −Z are mirrored correctly).
- **Unsupported entity types** are counted and listed in the Info panel.

## Accuracy and limitations

- **Exact results:** lines, arcs, circles and polyline bulges have closed-form lengths, areas and centroids. Intersections and distances between lines and arcs are analytic.
- **Numeric results:** ellipse and spline lengths and areas use adaptive Gauss–Legendre quadrature, and their intersections and minimum distances use subdivision plus Newton refinement. The unit tests check about 1e-9.
- **Block transforms** are applied exactly. A circle in a non-uniformly scaled block becomes an ellipse.
- **Contour joining tolerance:** endpoints closer than 1e-6 × the drawing diagonal are joined. The value is shown in the Info panel.
- **Fit-point-only splines** (no control points in the file) are interpolated with cubic end conditions. AutoCAD computes its own control points for these, so lengths can differ by a fraction of a percent; ezdxf's result differs from ours by 0.5% in the tests.
- **Plan view only:** 3D entities are shown projected onto XY, and Z is not measured.
- **Text** uses system fonts: SHX fonts map to sans-serif, and text widths are approximate. MTEXT columns, fields, stacked fractions and inline style changes are simplified.
- **Paper space** viewports render model content only when they are rectangular and unrotated; per-viewport layer freezing is ignored.
- **Large coordinates:** rendering uses 32-bit floats relative to the drawing centre. Extreme zoom on very large coordinates (beyond about 7 significant digits) can jitter on screen, while measurements stay in 64-bit.
- **Rendering:**
  - Lines are instanced quads.
  - Circular arcs are drawn analytically in a fragment shader, so they are smooth at any zoom.
  - Fills use an even-odd scanline trapezoid decomposition.
  - A synthetic 210,000-entity drawing parses and tessellates in about 0.3 s in Node and loads in under 1 s in Chrome. A full redraw takes about 16 ms on an Apple M4 Pro GPU, measured including a synchronous pixel readback.

## Tests

```
cd tests
npm install            # puppeteer-core (no browser download) and dxf-parser (an independent reader used as an oracle)
npm test               # unit tests of the geometry core, run against fixtures/expected.json and dxf-parser
npm run e2e            # headless Chrome drives the real UI with mouse clicks; screenshots land in tests/out/
```

- **Unit tests** extract the geometry core straight from `dxf-viewer.html` (the `<script id="core-src">` block), so they test exactly the code the page runs. They check:
  - per-layer lengths, extents and entity counts against **ezdxf**
  - entity counts on 22 real-world files against **dxf-parser**
  - exact areas, regions, hole tables, gaps, snaps, block transforms, binary and code-page reading
- **The E2E run** needs Chrome (set `$CHROME` if it isn't in a standard location). It checks every tool through real clicks with snapping, units, layers, theme colours, linetypes, zoom window, paper space, the phone layout, and that the page makes **no network requests**.
- **Fixtures** (`tests/fixtures/*.dxf` and `expected.json`) are generated by `make-fixtures.py` with [ezdxf](https://ezdxf.mozman.at/) 1.4.5:

  ```
  npm run fixtures   # needs uv; in a sandbox set UV_CACHE_DIR=$TMPDIR/uv-cache
  ```

  They cover:
  - a plate with holes and a slot
  - block transforms
  - splines and ellipses
  - hatches
  - an R12 PCB export
  - inch and unitless files, text, code page 1251, paper space, and binary DXF
- **Real-world samples** in `tests/fixtures/real/` come from the test suites of [bjnortier/dxf](https://github.com/bjnortier/dxf), [dxf-parser](https://github.com/gdsestimating/dxf-parser) and [three-dxf](https://github.com/gdsestimating/three-dxf), under their MIT licences (see `tests/fixtures/real/NOTICE.md`).

## License

[MIT](LICENSE) © 2026 Dmitrii Lebed. Third-party sample files in `tests/fixtures/real/` keep their own MIT notices.
