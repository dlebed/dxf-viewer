"""Generate DXF test fixtures with known geometry plus an independent oracle (ezdxf).

    cd tests
    UV_CACHE_DIR=$TMPDIR/uv-cache uv run --no-project --with ezdxf==1.4.5 python make-fixtures.py

Writes fixtures/*.dxf and fixtures/expected.json. The expected values come from two sources:
  * constructed values (areas, radii, distances computed by hand from how the drawing is built), and
  * ezdxf's own geometry (per-layer curve length, extents) after decomposing blocks, so the
    viewer's block transforms, OCS handling, bulges, ellipses and splines are checked against a
    mature, independent DXF implementation.
"""
import json
import math
import os

import ezdxf
from ezdxf import path as ezpath
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import Vec3

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
os.makedirs(OUT, exist_ok=True)
EXPECTED = {}

CURVES = {'LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TRACE', '3DFACE'}


def flat(entities, parent_layer=None):
    """Decompose INSERT/DIMENSION recursively; layer-0 entities inside blocks take the parent's layer."""
    for e in entities:
        layer = e.dxf.get('layer', '0')
        if parent_layer is not None and layer == '0':
            layer = parent_layer
        t = e.dxftype()
        if t == 'INSERT':
            inserts = list(e.multi_insert()) if e.mcount > 1 else [e]
            for ins in inserts:
                yield from flat(ins.virtual_entities(), layer)
        elif t == 'DIMENSION':
            yield from flat(e.virtual_entities(), layer)
        else:
            yield e, layer


def sample(e):
    """Dense points along the true curve (projected to XY), or None if the entity has no curve geometry.
    Arcs and circles are sampled from their exact parametric form (ezdxf's path module approximates
    arcs with Béziers, which is ~1e-4 off - too loose for an oracle)."""
    t = e.dxftype()
    n = 40000
    if t == 'LINE':
        return [list(e.dxf.start), list(e.dxf.end)]
    if t in ('ARC', 'CIRCLE'):
        a0, a1 = (e.dxf.start_angle, e.dxf.end_angle) if t == 'ARC' else (0, 360)
        if a1 <= a0:
            a1 += 360
        return [list(v) for v in e.vertices([a0 + (a1 - a0) * i / n for i in range(n + 1)])]
    if t == 'SPLINE':
        return [list(p) for p in e.construction_tool().approximate(segments=n)]
    if t == 'ELLIPSE':
        ce = e.construction_tool()
        a, b = ce.start_param, ce.end_param
        if b <= a:
            b += 2 * math.pi
        return [list(v) for v in ce.vertices([a + (b - a) * i / n for i in range(n + 1)])]
    if t in ('LWPOLYLINE', 'POLYLINE'):
        if t == 'POLYLINE' and (e.is_poly_face_mesh or e.is_polygon_mesh):
            return None
        pts = []
        for v in e.virtual_entities():  # exploded into LINE / ARC in WCS
            s = sample(v)
            if s:
                pts.append(s)
        return pts and [pts]  # list of separate pieces
    if t in ('SOLID', 'TRACE', '3DFACE'):
        return [list(v) for v in ezpath.make_path(e).flattening(distance=1e-6)]
    return None


def pieces(e):
    s = sample(e)
    if not s:
        return []
    return s[0] if isinstance(s[0][0], list) else [s]


def oracle(msp):
    layers, lo, hi = {}, [math.inf, math.inf], [-math.inf, -math.inf]
    for e, layer in flat(msp):
        for pts in pieces(e):
            length = sum(math.dist(pts[i][:2], pts[i + 1][:2]) for i in range(len(pts) - 1))
            layers.setdefault(layer, 0.0)
            layers[layer] += length
            for p in pts:
                lo[0], lo[1] = min(lo[0], p[0]), min(lo[1], p[1])
                hi[0], hi[1] = max(hi[0], p[0]), max(hi[1], p[1])
    ext = [lo[0], lo[1], hi[0], hi[1]] if lo[0] <= hi[0] else None
    return {'layerLength': layers, 'extents': ext}


def counts(msp):
    c = {}
    for e in msp:
        c[e.dxftype()] = c.get(e.dxftype(), 0) + 1
    return c


def save(doc, name, values=None, fmt='asc'):
    fn = os.path.join(OUT, name)
    doc.saveas(fn, fmt=fmt)
    msp = doc.modelspace()
    units = doc.header.get('$INSUNITS', 0) if doc.dxfversion > 'AC1009' else 0  # R12 has no $INSUNITS
    EXPECTED[name] = {'insunits': units, 'counts': counts(msp), **oracle(msp), 'values': values or {}}


def new(version='R2018', units=4):
    doc = ezdxf.new(version, setup=True)
    doc.header['$INSUNITS'] = units
    return doc


# ---------------------------------------------------------------- plate: mechanical part with known areas
def plate():
    doc = new()
    for name, color, lt in [('OUTLINE', 7, 'Continuous'), ('HOLES', 1, 'Continuous'), ('SLOT', 5, 'Continuous'),
                            ('CENTER', 2, 'CENTER'), ('DIMS', 3, 'Continuous'), ('TEXT', 4, 'Continuous')]:
        doc.layers.add(name, color=color, linetype=lt)
    msp = doc.modelspace()
    k = math.tan(math.radians(90) / 4)  # bulge of a 90° arc
    msp.add_lwpolyline([(0, 0, 0), (100, 0, 0), (100, 45, k), (95, 50, 0), (0, 50, 0)], format='xyb', close=True,
                       dxfattribs={'layer': 'OUTLINE'})
    holes = [(10, 10), (90, 10), (10, 40), (80, 40)]
    for c in holes:
        msp.add_circle(c, 3.25, dxfattribs={'layer': 'HOLES'})
        msp.add_line((c[0] - 5, c[1]), (c[0] + 5, c[1]), dxfattribs={'layer': 'CENTER'})
        msp.add_line((c[0], c[1] - 5), (c[0], c[1] + 5), dxfattribs={'layer': 'CENTER'})
    # obround slot, centres 20 apart, width 8, centred on (50, 25)
    msp.add_lwpolyline([(40, 21, 0), (60, 21, 1), (60, 29, 0), (40, 29, 1)], format='xyb', close=True,
                       dxfattribs={'layer': 'SLOT'})
    msp.add_linear_dim(base=(50, -10), p1=(0, 0), p2=(100, 0), dimstyle='EZDXF', dxfattribs={'layer': 'DIMS'}).render()
    msp.add_diameter_dim(center=(90, 10), radius=3.25, angle=45, dimstyle='EZ_RADIUS',
                         dxfattribs={'layer': 'DIMS'}).render()
    msp.add_text('PLATE-01', height=3.5, dxfattribs={'layer': 'TEXT'}).set_placement((5, 55))
    msp.add_mtext('Material: AL 6061\\PThickness: 3 mm', dxfattribs={'layer': 'TEXT', 'char_height': 2.5,
                                                                    'insert': (60, 62)})
    r = 3.25
    plate_area = 5000 - (25 - 25 * math.pi / 4)
    slot_area = 20 * 8 + math.pi * 16
    values = {
        'outlineArea': plate_area,
        'outlinePerimeter': 290 + 2.5 * math.pi,
        'holeRadius': r, 'holeArea': math.pi * r * r, 'holeCount': 4,
        'slotArea': slot_area, 'slotPerimeter': 40 + 8 * math.pi,
        'netArea': plate_area - 4 * math.pi * r * r - slot_area,
        'holes': holes,
        'holeGap': 80 - 2 * r,  # (10,10)↔(90,10) is 80 apart; (10,40)↔(80,40) is 70 apart
        'dimValue': 100,
    }
    save(doc, 'plate.dxf', values)
    save(doc, 'plate-bin.dxf', values, fmt='bin')
    # the binary file reuses the plate's expected values
    EXPECTED['plate-bin.dxf']['binary'] = True


# ---------------------------------------------------------------- block transforms + OCS
def transforms():
    doc = new()
    for n in ['I1', 'I2', 'I3', 'I4', 'I5', 'NEG', 'BLK']:
        doc.layers.add(n)
    blk = doc.blocks.new('BRACKET', base_point=(0, 0))
    blk.add_line((0, 0), (10, 0))
    blk.add_arc((10, 5), 5, -90, 90)
    blk.add_line((10, 10), (0, 10))
    blk.add_circle((4, 5), 2)
    blk.add_lwpolyline([(0, 10, 0), (-3, 7, -0.4), (0, 0, 0)], format='xyb')
    pair = doc.blocks.new('PAIR')
    pair.add_blockref('BRACKET', (0, 0))
    pair.add_blockref('BRACKET', (0, 15), dxfattribs={'rotation': 90, 'xscale': 0.5, 'yscale': 0.5})
    msp = doc.modelspace()
    msp.add_blockref('BRACKET', (20, 0), dxfattribs={'rotation': 30, 'xscale': 2, 'yscale': 2, 'layer': 'I1'})
    msp.add_blockref('BRACKET', (70, 0), dxfattribs={'xscale': -1, 'layer': 'I2'})  # mirrored
    msp.add_blockref('BRACKET', (90, 0), dxfattribs={'xscale': 2, 'yscale': 1, 'layer': 'I3'})  # circle → ellipse
    msp.add_blockref('PAIR', (0, 40), dxfattribs={'rotation': 45, 'xscale': 1.5, 'yscale': 1.5, 'layer': 'I4'})
    ref = msp.add_blockref('BRACKET', (40, 40), dxfattribs={'layer': 'I5', 'rotation': 10})
    ref.grid(size=(3, 2), spacing=(15, 20))
    # entities with extrusion (0,0,-1): OCS mirrors x
    msp.add_arc((-10, 5), 4, 0, 120, dxfattribs={'layer': 'NEG', 'extrusion': (0, 0, -1)})
    msp.add_circle((-30, 5), 1.5, dxfattribs={'layer': 'NEG', 'extrusion': (0, 0, -1)})
    msp.add_lwpolyline([(0, -20, 0.5), (10, -20, 0), (10, -30, 0)], format='xyb',
                       dxfattribs={'layer': 'NEG', 'extrusion': (0, 0, -1)})
    values = {
        # I3: the circle r=2 at (4,5) scaled x2 becomes an ellipse with semi-axes 4 and 2 centred at (98, 5)
        'ellipseCenter': [98, 5], 'ellipseAxes': [4, 2],
        # mirrored arc (extrusion -Z): OCS centre (-10,5) is WCS (10,5)
        'negArcCenter': [10, 5], 'negArcRadius': 4,
        'negArcStart': [10 - 4, 5], 'negArcEnd': [10 - 4 * math.cos(math.radians(120)), 5 + 4 * math.sin(math.radians(120))],
        'negCircleCenter': [30, 5],
    }
    save(doc, 'transforms.dxf', values)


# ---------------------------------------------------------------- splines + ellipses
def curves():
    doc = new()
    for n in ['SPL_OPEN', 'SPL_RAT', 'SPL_CLOSED', 'SPL_FIT', 'ELL_FULL', 'ELL_ARC', 'ELL_NEG']:
        doc.layers.add(n)
    msp = doc.modelspace()
    cp = [(0, 0), (10, 20), (30, -10), (45, 15), (60, 0)]
    msp.add_open_spline(cp, degree=3, dxfattribs={'layer': 'SPL_OPEN'})
    # exact quarter circle r=10 as a rational quadratic, centred (0,40)
    w = math.sqrt(0.5)
    msp.add_rational_spline([(10, 40), (10, 50), (0, 50)], [1, w, 1], degree=2, dxfattribs={'layer': 'SPL_RAT'})
    msp.add_spline(dxfattribs={'layer': 'SPL_CLOSED'}).set_closed([(80, 0, 0), (100, 10, 0), (90, 30, 0), (70, 25, 0), (65, 8, 0)], degree=3)
    msp.add_spline([(0, -30), (15, -20), (30, -32), (45, -22), (60, -30)], dxfattribs={'layer': 'SPL_FIT'})
    msp.add_ellipse((30, 60), major_axis=(12 * math.cos(math.radians(30)), 12 * math.sin(math.radians(30))),
                    ratio=0.5, dxfattribs={'layer': 'ELL_FULL'})
    msp.add_ellipse((70, 60), major_axis=(10, 0), ratio=0.4, start_param=0.3, end_param=2.5,
                    dxfattribs={'layer': 'ELL_ARC'})
    msp.add_ellipse((100, 60), major_axis=(8, 0), ratio=0.5, start_param=0, end_param=math.pi / 2,
                    dxfattribs={'layer': 'ELL_NEG', 'extrusion': (0, 0, -1)})
    a, b = 12, 6
    values = {
        'ratQuarterLength': 10 * math.pi / 2,
        'ellipseFullArea': math.pi * a * b,
        # extrusion -Z flips the parametric direction: from (108,60) clockwise to (100,56)
        'ellNegStart': [108, 60], 'ellNegEnd': [100, 56],
    }
    save(doc, 'curves.dxf', values)


# ---------------------------------------------------------------- hatches
def hatches():
    doc = new()
    for n in ['H_SOLID', 'H_PATTERN', 'H_EDGES', 'BOUNDARY']:
        doc.layers.add(n)
    msp = doc.modelspace()
    h = msp.add_hatch(color=1, dxfattribs={'layer': 'H_SOLID'})
    h.paths.add_polyline_path([(0, 0), (40, 0), (40, 40), (0, 40)], is_closed=True, flags=1)
    ep = h.paths.add_edge_path(flags=16)
    ep.add_arc((20, 20), 10, 0, 360)
    h2 = msp.add_hatch(color=5, dxfattribs={'layer': 'H_PATTERN'})
    h2.set_pattern_fill('ANSI31', scale=1.0)
    h2.paths.add_polyline_path([(50, 0), (90, 0), (90, 40), (50, 40)], is_closed=True)
    # edge loop with a clockwise arc: a 30x20 rectangle whose right side bulges inward (cw arc)
    h3 = msp.add_hatch(color=3, dxfattribs={'layer': 'H_EDGES'})
    ep = h3.paths.add_edge_path()
    ep.add_line((100, 0), (130, 0))
    ep.add_arc((130, 10), 10, 270, 90, ccw=False)  # inward: from (130,0) clockwise around (130,10)?
    ep.add_line((130, 20), (100, 20))
    ep.add_line((100, 20), (100, 0))
    msp.add_lwpolyline([(0, 0), (40, 0), (40, 40), (0, 40)], close=True, dxfattribs={'layer': 'BOUNDARY'})

    def hatch_area(hatch):
        areas = []
        for p in ezpath.from_hatch(hatch):
            pts = [v for v in p.flattening(distance=1e-6, segments=64)]
            a = 0.0
            for i in range(len(pts)):
                x1, y1 = pts[i].x, pts[i].y
                x2, y2 = pts[(i + 1) % len(pts)].x, pts[(i + 1) % len(pts)].y
                a += x1 * y2 - x2 * y1
            areas.append(abs(a) / 2)
        areas.sort(reverse=True)
        return areas[0] - sum(areas[1:])

    values = {'solidArea': hatch_area(h), 'patternArea': hatch_area(h2), 'edgeArea': hatch_area(h3),
              'solidAreaExact': 1600 - 100 * math.pi}
    save(doc, 'hatches.dxf', values)


# ---------------------------------------------------------------- PCB-like R12 export
def pcb():
    doc = ezdxf.new('R12', setup=True)
    doc.header['$INSUNITS'] = 4
    for n, c in [('Edge.Cuts', 2), ('Drill', 7), ('F.Cu', 1), ('Gap', 6)]:
        doc.layers.add(n, color=c)
    msp = doc.modelspace()
    W, H, R = 60, 40, 3
    L = {'layer': 'Edge.Cuts'}
    msp.add_line((R, 0), (W - R, 0), dxfattribs=L)
    msp.add_arc((W - R, R), R, 270, 360, dxfattribs=L)
    msp.add_line((W, R), (W, H - R), dxfattribs=L)
    msp.add_arc((W - R, H - R), R, 0, 90, dxfattribs=L)
    msp.add_line((W - R, H), (R, H), dxfattribs=L)
    msp.add_arc((R, H - R), R, 90, 180, dxfattribs=L)
    msp.add_line((0, H - R), (0, R), dxfattribs=L)
    msp.add_arc((R, R), R, 180, 270, dxfattribs=L)
    D = {'layer': 'Drill'}
    for x, y in [(4, 4), (W - 4, 4), (4, H - 4), (W - 4, H - 4)]:
        msp.add_circle((x, y), 1.6, dxfattribs=D)
    for i in range(12):
        msp.add_circle((12 + 3 * i, 20), 0.3, dxfattribs=D)
    for i in range(6):
        msp.add_circle((15 + 6 * i, 32), 0.5, dxfattribs=D)
    msp.add_polyline2d([(12, 20), (12, 10), (30, 10), (33, 13)],
                       dxfattribs={'layer': 'F.Cu', 'default_start_width': 0.25, 'default_end_width': 0.25})
    msp.add_polyline2d([(15, 32), (45, 32)],
                       dxfattribs={'layer': 'F.Cu', 'default_start_width': 0.5, 'default_end_width': 0.5})
    G = {'layer': 'Gap'}
    msp.add_line((70, 0), (80, 0), dxfattribs=G)
    msp.add_line((80, 0), (80, 10), dxfattribs=G)
    msp.add_line((80, 10), (70, 10), dxfattribs=G)
    msp.add_line((70, 10), (70, 0.05), dxfattribs=G)  # 0.05 gap at (70,0)
    values = {
        'boardArea': W * H - (4 - math.pi) * R * R,
        'boardPerimeter': 2 * (W - 2 * R) + 2 * (H - 2 * R) + 2 * math.pi * R,
        'holeTable': {'3.2': 4, '0.6': 12, '1': 6},
        'gap': 0.05, 'gapEnds': [[70, 0], [70, 0.05]],
        'traceLength': 10 + 18 + math.hypot(3, 3),
    }
    save(doc, 'pcb.dxf', values)


# ---------------------------------------------------------------- units
def units():
    doc = new(units=1)
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (2, 0), (2, 1), (0, 1)], close=True)
    msp.add_circle((0.5, 0.5), 0.125)
    save(doc, 'inch.dxf', {'width': 2, 'radius': 0.125})
    doc = new(units=0)
    doc.header['$MEASUREMENT'] = 1
    doc.modelspace().add_line((0, 0), (10, 0))
    save(doc, 'unitless.dxf', {'length': 10})


# ---------------------------------------------------------------- text + code page
def text():
    doc = new()
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0))
    aligns = [TextEntityAlignment.LEFT, TextEntityAlignment.CENTER, TextEntityAlignment.RIGHT,
              TextEntityAlignment.MIDDLE_CENTER, TextEntityAlignment.TOP_LEFT, TextEntityAlignment.BOTTOM_RIGHT]
    for i, al in enumerate(aligns):
        msp.add_text(f'{al.name}', height=2.5, rotation=15 * i).set_placement((10 + 15 * i, 10), align=al)
    msp.add_mtext('{\\fArial|b1;Bold} plain\\PSecond line %%c10 \\U+00B1\\P\\S1/2;', dxfattribs={
        'insert': (0, 40), 'char_height': 3, 'width': 60, 'attachment_point': 1})
    blk = doc.blocks.new('TAG')
    blk.add_circle((0, 0), 5)
    blk.add_attdef('PART', (-3, -1), dxfattribs={'height': 2})
    ins = msp.add_blockref('TAG', (80, 40))
    ins.add_auto_attribs({'PART': 'P-17'})
    save(doc, 'text.dxf', {'attrib': 'P-17'})

    doc = new('R2000')
    doc.encoding = 'cp1251'
    doc.modelspace().add_text('Привет, мир', height=5).set_placement((0, 0))
    save(doc, 'cp1251.dxf', {'text': 'Привет, мир'})


# ---------------------------------------------------------------- paper space layout with a viewport
def paper():
    doc = new()
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (100, 0), (100, 50), (0, 50)], close=True)
    msp.add_circle((50, 25), 10)
    lay = doc.layouts.new('Sheet1')
    lay.add_line((0, 0), (200, 0))
    lay.add_text('TITLE BLOCK', height=5).set_placement((10, 10))
    lay.add_viewport(center=(110, 90), size=(160, 100), view_center_point=(50, 25), view_height=80)
    save(doc, 'paper.dxf', {'layout': 'Sheet1', 'viewportScale': 100 / 80})


plate()
transforms()
curves()
hatches()
pcb()
units()
text()
paper()

with open(os.path.join(OUT, 'expected.json'), 'w') as f:
    json.dump(EXPECTED, f, indent=1, ensure_ascii=False)
print('wrote', len(EXPECTED), 'fixtures to', OUT)
