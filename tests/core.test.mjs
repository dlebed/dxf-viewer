// Unit tests for the geometry core embedded in ../dxf-viewer.html.
// The core is extracted from its <script type="text/plain" id="core-src"> block, so these tests run exactly
// the code the page runs. Expected values come from fixtures/expected.json (written by make-fixtures.py:
// constructed values plus ezdxf's independent geometry) and from dxf-parser for the real-world files.
//
//   cd tests && npm install && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import DxfParser from 'dxf-parser';
import ACI_ORACLE from 'dxf-parser/dist/AutoCadColorIndex.js';

const html = fs.readFileSync(new URL('../dxf-viewer.html', import.meta.url), 'utf8');
const src = /<script type="text\/plain" id="core-src">([\s\S]*?)<\/script>/.exec(html)[1];
const C = new Function(src + '\nreturn CORE;')();
const FIX = new URL('./fixtures/', import.meta.url);
const EXPECTED = JSON.parse(fs.readFileSync(new URL('expected.json', FIX), 'utf8'));
const bytesOf = (name) => new Uint8Array(fs.readFileSync(new URL(name, FIX)));
const load = (name) => C.loadDxf(bytesOf(name));
const close = (actual, expected, tol, msg = '') => assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ± ${tol}, got ${actual}`);
const closePt = (a, b, tol, msg = '') => { close(a[0], b[0], tol, `${msg} x`); close(a[1], b[1], tol, `${msg} y`); };
const entsOn = (S, layer) => S.entities.filter((e) => e.layer === layer);
const primsOf = (S, ent) => S.prims.slice(ent.p0, ent.p1);
const curveLength = (S, layer) => S.prims.filter((p) => C.isCurve(p) && S.entities[p.e].layer === layer).reduce((s, p) => s + C.primLength(p), 0);

// ---------------------------------------------------------------- colours
test('ACI colour table matches dxf-parser', () => {
  for (let i = 1; i < 256; i++) if (i !== 7) assert.equal(C.ACI[i], ACI_ORACLE[i], `ACI ${i}`);
  assert.equal(C.aciRgb(7), C.FG);
});

// ---------------------------------------------------------------- oracle: every synthetic fixture
for (const [name, exp] of Object.entries(EXPECTED)) {
  test(`${name}: entity counts, per-layer length and extents match ezdxf`, () => {
    const doc = load(name);
    const { tok } = C.readTokens(bytesOf(name));
    const raw = C.parseDxf(tok).entities.filter((e) => !e.paper);
    const counts = {};
    for (const e of raw) counts[e.type] = (counts[e.type] || 0) + 1;
    assert.deepEqual(counts, exp.counts);
    assert.equal(doc.insunits, exp.insunits);
    const S = doc.spaces[0];
    for (const [layer, len] of Object.entries(exp.layerLength)) {
      // a fit-point-only spline is interpolated by us and by ezdxf with different end conditions
      const tol = layer === 'SPL_FIT' ? 0.01 * len : 1e-7 * Math.max(1, len);
      close(curveLength(S, layer), len, tol, `${name} layer ${layer} length`);
    }
    if (exp.extents) { // centreline extents (the viewer's own extents also include fills and stroke widths)
      const e = exp.extents, d = Math.hypot(e[2] - e[0], e[3] - e[1]), b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of S.prims) if (C.isCurve(p)) { b[0] = Math.min(b[0], p.bb[0]); b[1] = Math.min(b[1], p.bb[1]); b[2] = Math.max(b[2], p.bb[2]); b[3] = Math.max(b[3], p.bb[3]); }
      for (let k = 0; k < 4; k++) close(b[k], e[k], (name === 'curves.dxf' ? 1e-3 : 1e-6) * d, `${name} extents[${k}]`);
    }
  });
}

// ---------------------------------------------------------------- reading
test('binary DXF parses to the same model as ASCII', () => {
  const a = load('plate.dxf'), b = load('plate-bin.dxf');
  assert.equal(b.binary, true);
  assert.equal(a.spaces[0].prims.length, b.spaces[0].prims.length);
  a.spaces[0].prims.forEach((p, i) => {
    const q = b.spaces[0].prims[i];
    assert.equal(p.k, q.k);
    for (const key of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'a0', 'da']) if (key in p) close(q[key], p[key], 1e-12, `prim ${i} ${key}`);
  });
});

test('code page: ANSI_1251 text is decoded', () => {
  const doc = load('cp1251.dxf');
  assert.equal(doc.encoding, 'windows-1251');
  const t = doc.spaces[0].entities.find((e) => e.text);
  assert.equal(t.text.lines[0], EXPECTED['cp1251.dxf'].values.text);
});

test('real-world files load, and entity counts agree with dxf-parser', () => {
  const dir = new URL('real/', FIX);
  const shared = new Set(['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'TEXT', 'MTEXT', 'INSERT', 'SPLINE', 'ELLIPSE', 'POINT', 'SOLID', '3DFACE', 'DIMENSION', 'ATTDEF']);
  let compared = 0;
  for (const f of fs.readdirSync(dir)) {
    const bytes = new Uint8Array(fs.readFileSync(new URL(f, dir)));
    const doc = C.loadDxf(bytes);
    assert.ok(doc.spaces[0].entities.length > 0, `${f}: no entities`);
    const ours = {}, theirs = {};
    for (const e of C.parseDxf(C.readTokens(bytes).tok).entities) if (shared.has(e.type)) ours[e.type] = (ours[e.type] || 0) + 1;
    let parsed;
    try { parsed = new DxfParser().parseSync(new TextDecoder().decode(bytes)); } catch { continue; }
    for (const e of parsed.entities) if (shared.has(e.type)) theirs[e.type] = (theirs[e.type] || 0) + 1;
    assert.deepEqual(ours, theirs, f);
    compared++;
  }
  assert.ok(compared >= 15, `compared ${compared} files`);
});

// ---------------------------------------------------------------- plate: exact areas, contours, holes, distances
test('plate: exact areas, perimeters, region with holes, hole table, min distance', () => {
  const doc = load('plate.dxf'), S = doc.spaces[0], v = EXPECTED['plate.dxf'].values;
  const outline = entsOn(S, 'OUTLINE')[0], slot = entsOn(S, 'SLOT')[0];
  const oa = C.entityArea(S, outline);
  close(oa.area, v.outlineArea, 1e-9, 'outline area');
  close(oa.perimeter, v.outlinePerimeter, 1e-9, 'outline perimeter');
  const sa = C.entityArea(S, slot);
  close(sa.area, v.slotArea, 1e-9, 'slot area');
  close(sa.perimeter, v.slotPerimeter, 1e-9, 'slot perimeter');
  closePt([sa.cx, sa.cy], [50, 25], 1e-9, 'slot centroid');
  const holes = entsOn(S, 'HOLES');
  assert.equal(holes.length, v.holeCount);
  for (const h of holes) close(primsOf(S, h)[0].r, v.holeRadius, 1e-12);

  const A = C.analyzeSpace(S);
  const R = C.regionAt(A.contours, 30, 5);
  close(R.area, v.netArea, 1e-8, 'net area of the plate (outline − holes − slot)');
  assert.equal(R.holes.length, 5);
  assert.deepEqual(A.holes.map((h) => [+h.d.toFixed(6), h.count]), [[6.5, 4]]);

  const [h1, h2] = [[10, 10], [90, 10]].map((c) => holes.find((h) => Math.hypot(primsOf(S, h)[0].cx - c[0], primsOf(S, h)[0].cy - c[1]) < 1e-9));
  const md = C.minDistance(S.prims, [h1.p0], [h2.p0]);
  close(md.d, v.holeGap, 1e-9, 'hole wall to hole wall');
  const dim = S.entities.find((e) => e.type === 'DIMENSION' && e.info.dimtype === 0);
  close(dim.info.value, v.dimValue, 1e-9, 'linear dimension value');
});

test('snapping: endpoints, centres, intersections, perpendicular and tangent', () => {
  const S = load('plate.dxf').spaces[0];
  const ids = S.prims.map((_, i) => i);
  const en = { end: true, mid: true, center: true, quad: true, int: true, perp: true, tan: true, node: true, near: true };
  const snap = (x, y, prev) => C.snapCandidates(S.prims, ids, x, y, 0.6, 0.05, prev, en);
  let c = snap(100.2, 0.15);
  assert.equal(c[0].type, 'end'); closePt([c[0].x, c[0].y], [100, 0], 1e-12);
  c = snap(10.1, 10.2);
  assert.ok(['center', 'intersection'].includes(c[0].type)); closePt([c[0].x, c[0].y], [10, 10], 1e-12);
  assert.ok(c.some((x) => x.type === 'intersection'), 'centre lines cross at the hole centre');
  c = snap(13.25, 10.3);
  assert.ok(c.some((x) => x.type === 'quadrant' && Math.abs(x.x - 13.25) < 1e-12 && Math.abs(x.y - 10) < 1e-12), 'quadrant of the hole');
  c = snap(98.5, 48.5);
  const mid = c.find((x) => x.type === 'mid');
  closePt([mid.x, mid.y], [95 + 5 * Math.SQRT1_2, 45 + 5 * Math.SQRT1_2], 1e-12, 'midpoint of the R5 corner arc');
  c = snap(40, 0.3, [40, 30]);
  const perp = c.find((x) => x.type === 'perpendicular');
  closePt([perp.x, perp.y], [40, 0], 1e-12, 'perpendicular foot on the bottom edge');
  const hole = S.prims.find((p) => p.k === 'A' && p.full && Math.hypot(p.cx - 10, p.cy - 10) < 1e-9);
  const tps = C.tangentPoints(hole, [10, 30]);
  assert.equal(tps.length, 2);
  for (const t of tps) close((t[0] - 10) * (t[0] - 10) + (t[1] - 30) * (t[1] - 10), 0, 1e-9, 'radius ⟂ tangent');
});

// ---------------------------------------------------------------- transforms
test('transforms: non-uniform scale gives an ellipse; extrusion −Z mirrors arcs', () => {
  const S = load('transforms.dxf').spaces[0], v = EXPECTED['transforms.dxf'].values;
  const ell = S.prims.find((p) => p.k === 'E' && p.full && S.entities[p.e].layer === 'I3');
  assert.ok(ell, 'circle in a (2,1)-scaled block is an ellipse');
  closePt([ell.cx, ell.cy], v.ellipseCenter, 1e-12);
  const ax = C.ellipseAxes(ell);
  close(ax.a, v.ellipseAxes[0], 1e-12); close(ax.b, v.ellipseAxes[1], 1e-12);
  const neg = S.prims.filter((p) => S.entities[p.e].layer === 'NEG' && p.k === 'A');
  const arc = neg.find((p) => !p.full), circ = neg.find((p) => p.full);
  closePt([arc.cx, arc.cy], v.negArcCenter, 1e-12, 'mirrored arc centre');
  close(arc.r, v.negArcRadius, 1e-12);
  closePt(C.primPoint(arc, 0), v.negArcStart, 1e-12, 'mirrored arc start');
  closePt(C.primPoint(arc, 1), v.negArcEnd, 1e-12, 'mirrored arc end');
  assert.ok(arc.da < 0, 'mirrored arc runs clockwise');
  closePt([circ.cx, circ.cy], v.negCircleCenter, 1e-12);
  // MINSERT: 3 rows × 2 columns
  assert.equal(S.prims.filter((p) => S.entities[p.e].layer === 'I5' && p.k !== 'N').length, 36); // 6 copies × (line, arc, line, circle, 2 polyline segments)
});

// ---------------------------------------------------------------- curves
test('curves: rational spline, ellipse area, extrusion −Z ellipse, fit-point interpolation', () => {
  const S = load('curves.dxf').spaces[0], v = EXPECTED['curves.dxf'].values;
  const rat = entsOn(S, 'SPL_RAT')[0], rp = primsOf(S, rat)[0];
  close(C.primLength(rp), v.ratQuarterLength, 1e-9, 'rational quarter circle length');
  for (let s = 0; s <= 1; s += 0.1) { const q = C.primPoint(rp, s); close(Math.hypot(q[0], q[1] - 40), 10, 1e-12, 'on the circle'); }
  close(C.entityArea(S, entsOn(S, 'ELL_FULL')[0]).area, v.ellipseFullArea, 1e-9, 'ellipse area');
  const en = primsOf(S, entsOn(S, 'ELL_NEG')[0])[0];
  closePt(C.primPoint(en, 0), v.ellNegStart, 1e-12); closePt(C.primPoint(en, 1), v.ellNegEnd, 1e-12);
  const closed = primsOf(S, entsOn(S, 'SPL_CLOSED')[0])[0];
  assert.equal(C.primEnds(closed).length, 0, 'closed spline has no ends');
  assert.ok(C.entityArea(S, entsOn(S, 'SPL_CLOSED')[0]).area > 100);
  const fit = [[0, -30], [15, -20], [30, -32], [45, -22], [60, -30]];
  const sp = primsOf(S, entsOn(S, 'SPL_FIT')[0])[0];
  for (const f of fit) assert.ok(C.primClosest(sp, ...f).d < 1e-9, `fit point ${f} lies on the curve`);
});

// ---------------------------------------------------------------- hatches
test('hatches: exact areas with holes and clockwise edges; fill and pattern geometry', () => {
  const S = load('hatches.dxf').spaces[0], v = EXPECTED['hatches.dxf'].values;
  const h = (layer) => entsOn(S, layer)[0];
  close(C.hatchArea(h('H_SOLID')), v.solidAreaExact, 1e-9, 'square minus circle');
  close(C.hatchArea(h('H_SOLID')), v.solidArea, 0.2, 'ezdxf (flattened) agrees');
  close(C.hatchArea(h('H_PATTERN')), 1600, 1e-9);
  close(C.hatchArea(h('H_EDGES')), 600 + 50 * Math.PI, 1e-9, 'edge loop with a clockwise arc');
  close(C.hatchArea(h('H_EDGES')), v.edgeArea, 0.1, 'ezdxf (flattened) agrees');
  // the trapezoid fill covers exactly the even-odd area of the boundary polygons
  const polys = h('H_SOLID').hatch.loops.map(C.loopPolygon), tri = C.fillEvenOdd(polys, []);
  let a = 0;
  for (let i = 0; i < tri.length; i += 6) a += Math.abs(C.polygonArea(tri.slice(i, i + 6)));
  close(a, Math.abs(C.polygonArea(polys[0])) - Math.abs(C.polygonArea(polys[1])), 1e-9, 'filled triangles area');
  const pat = C.hatchPattern(h('H_PATTERN').hatch.loops.map(C.loopPolygon), h('H_PATTERN').hatch.defs, 1e6);
  assert.equal(pat.length / 4, 18, 'ANSI31: 40·√2 / 3.175 → 18 lines');
  for (let i = 0; i < pat.length; i += 2) assert.ok(pat[i] >= 50 - 1e-9 && pat[i] <= 90 + 1e-9 && pat[i + 1] >= -1e-9 && pat[i + 1] <= 40 + 1e-9, 'pattern clipped to the boundary');
});

// ---------------------------------------------------------------- PCB (R12)
test('pcb (R12): closed board outline from separate lines/arcs, hole table, gap detection, trace width', () => {
  const doc = load('pcb.dxf'), S = doc.spaces[0], v = EXPECTED['pcb.dxf'].values;
  assert.equal(doc.version, 'AC1009');
  const A = C.analyzeSpace(S);
  const edgePrim = S.prims.findIndex((p) => S.entities[p.e].layer === 'Edge.Cuts');
  const board = A.contours.contours[A.contours.primContour[edgePrim]];
  assert.ok(board.closed, 'outline chained into a closed contour');
  close(board.area, v.boardArea, 1e-9, 'board area');
  close(board.length, v.boardPerimeter, 1e-9, 'board perimeter');
  const table = Object.fromEntries(A.holes.map((h) => [String(+h.d.toFixed(6)), h.count]));
  assert.deepEqual(table, v.holeTable);
  const gapPrim = S.prims.findIndex((p) => S.entities[p.e].layer === 'Gap');
  assert.equal(A.contours.contours[A.contours.primContour[gapPrim]].closed, false, 'gap contour is open');
  assert.equal(A.ends.length, 2 + 4, 'two ends at the gap + two open traces');
  close(A.gaps[0].d, v.gap, 1e-12, 'smallest gap');
  const trace = entsOn(S, 'F.Cu')[0];
  close(C.entityLength(S, trace), v.traceLength, 1e-9, 'trace centreline length');
  assert.ok(trace.fill && trace.fill.length > 0, 'wide polyline is filled');
  let fa = 0;
  for (let i = 0; i < trace.fill.length; i += 6) fa += Math.abs(C.polygonArea(trace.fill.slice(i, i + 6)));
  assert.ok(fa > v.traceLength * 0.25 * 0.95, `trace fill area ${fa}`);
  const R = C.regionAt(A.contours, 30, 5);
  const holeArea = Math.PI * (4 * 1.6 ** 2 + 12 * 0.3 ** 2 + 6 * 0.5 ** 2);
  close(R.area, v.boardArea - holeArea, 1e-8, 'board minus drill holes');
});

// ---------------------------------------------------------------- text
test('text: MTEXT formatting stripped, attributes, alignment anchors', () => {
  const S = load('text.dxf').spaces[0];
  const mt = S.entities.find((e) => e.type === 'MTEXT');
  assert.deepEqual(mt.text.lines, ['Bold plain', 'Second line Ø10 ±', '1/2']);
  assert.ok(S.entities.some((e) => e.type === 'ATTRIB' && e.text.lines[0] === EXPECTED['text.dxf'].values.attrib));
  assert.ok(!S.entities.some((e) => e.type === 'ATTDEF'), 'ATTDEF inside an inserted block is not drawn');
  const mc = S.entities.find((e) => e.type === 'TEXT' && e.info.str === 'MIDDLE_CENTER');
  closePt(C.affPt(mc.text.M, 0, 0), [55, 10], 1e-9, 'middle-centre text anchored at its alignment point');
  assert.equal(mc.text.ha, 'c'); assert.equal(mc.text.va, 'middle');
  assert.deepEqual(C.mtextPlain('A\\~B\\PC{\\H2x;D}\\S3#4;'), ['A B', 'CD3/4']);
});

// ---------------------------------------------------------------- paper space
test('paper space: layout name, viewport scale, model content', () => {
  const doc = load('paper.dxf');
  assert.deepEqual(doc.spaces.map((s) => s.name), ['Model', EXPECTED['paper.dxf'].values.layout]);
  const P = doc.spaces[1];
  assert.equal(P.viewports.length, 1);
  close(P.viewports[0].scale, EXPECTED['paper.dxf'].values.viewportScale, 1e-12);
  closePt([P.viewports[0].mx, P.viewports[0].my], [50, 25], 1e-12, 'viewport looks at the model centre');
});

// ---------------------------------------------------------------- maths
test('bulge, intersections and minimum distance are exact', () => {
  const a = C.bulgeArc(0, 0, 2, 0, 1);
  closePt([a.cx, a.cy], [1, 0], 1e-15); close(a.r, 1, 1e-15); close(a.da, Math.PI, 1e-15);
  const L = (x1, y1, x2, y2) => ({ k: 'L', x1, y1, x2, y2 });
  const A = (cx, cy, r, a0 = 0, da = 2 * Math.PI) => ({ k: 'A', cx, cy, r, a0, da, full: Math.abs(da) >= 2 * Math.PI });
  const pts = C.intersectPrims(L(-10, 3, 10, 3), A(0, 0, 5)).sort((p, q) => p[0] - q[0]);
  closePt(pts[0], [-4, 3], 1e-12); closePt(pts[1], [4, 3], 1e-12);
  const aa = C.intersectPrims(A(0, 0, 5), A(8, 0, 5));
  assert.equal(aa.length, 2); for (const p of aa) closePt([p[0], Math.abs(p[1])], [4, 3], 1e-12);
  assert.equal(C.intersectPrims(L(-10, 3, 10, 3), A(0, 0, 5, 0, Math.PI / 2)).length, 1, 'arc range respected');
  close(C.primMinDist(L(-10, 8, 10, 8), A(0, 0, 5)).d, 3, 1e-12, 'line ↔ circle');
  close(C.primMinDist(A(0, 0, 5), A(20, 0, 3)).d, 12, 1e-12, 'circle ↔ circle');
  close(C.primMinDist(A(0, 0, 5), A(1, 0, 1)).d, 3, 1e-12, 'circle ↔ inner circle');
  // numeric path (ellipse) converges to the analytic answer
  const E = C.conicFrom(0, 0, 10, 0, 0, 5, 0, 2 * Math.PI);
  close(C.primMinDist(E, L(-20, 9, 20, 9)).d, 4, 1e-9, 'ellipse ↔ line');
  close(C.primLength(E), 48.44224110273837, 1e-9, 'ellipse perimeter (Gauss–Kummer reference)');
});

test('linetype dashes keep the pattern lengths', () => {
  const segs = [];
  C.dashPolyline([0, 0, 10, 0, 10, 10], [2, -1, 0, -1], (x1, y1, x2, y2) => segs.push(Math.hypot(x2 - x1, y2 - y1)));
  const dashes = segs.filter((s) => s > 0), dots = segs.filter((s) => s === 0);
  close(dashes.reduce((s, v) => s + v, 0) / 20, 0.5, 0.05, 'half the length is dashes');
  assert.ok(dots.length >= 4);
});
