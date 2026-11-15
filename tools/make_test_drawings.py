"""Writes the test drawings in crates/inlay-core/tests/drawings and their manifest.

Each drawing exercises one way real files differ: units, transforms, path
commands, fill rules, outlines without fills, separate segments, things that
must be left out, and the DXF entity kinds. The manifest says what the import
of each must find, worked out here from the geometry, not from the app.

Run from the repository root:  python tools/make_test_drawings.py
"""

import json
import math
import os
import random

OUT = os.path.join("crates", "inlay-core", "tests", "drawings")
PX = 25.4 / 96.0
manifest = []


def shoelace(points):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))) / 2


def case(name, text, regions, area, **more):
    """Records one drawing. `area` is the total of all regions, mm²."""
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline=more.pop("newline", "\n")) as f:
        f.write(text)
    entry = {"file": name, "regions": regions, "area": round(area, 3)}
    entry.update(more)
    manifest.append(entry)


def svg(body, width="100mm", height="80mm", view="0 0 100 80", extra=""):
    view = f' viewBox="{view}"' if view else ""
    size = f' width="{width}"' if width else ""
    size += f' height="{height}"' if height else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg"{extra}{size}{view}>\n{body}\n</svg>\n'


# ---------------------------------------------------------------- SVG

case(
    "svg-01-basic-shapes.svg",
    svg(
        '  <rect x="10" y="10" width="30" height="20" fill="#333"/>\n'
        '  <circle cx="65" cy="20" r="10" fill="#333"/>\n'
        '  <ellipse cx="25" cy="55" rx="15" ry="8" fill="#333"/>\n'
        '  <polygon points="50,45 70,45 50,65" fill="#333"/>\n'
        '  <rect x="60" y="50" width="30" height="20" rx="4" fill="#333"/>'
    ),
    5,
    600 + math.pi * 100 + math.pi * 120 + 200 + 600 - (4 - math.pi) * 16,
    page=[100, 80],
    build="all",
)

# No viewBox and sizes in CSS pixels: 96 to the inch.
case(
    "svg-02-pixels-no-viewbox.svg",
    svg('  <rect x="48" y="48" width="96" height="96" fill="black"/>', width="378", height="189", view=None),
    1,
    25.4**2,
    page=[378 * PX, 189 * PX],
    build="all",
)

# Sizes in inches with a viewBox in hundredths of an inch.
case(
    "svg-03-inches-viewbox.svg",
    svg('  <rect x="50" y="50" width="100" height="100" fill="black"/>', width="4in", height="2in", view="0 0 400 200"),
    1,
    25.4**2,
    page=[101.6, 50.8],
)

case(
    "svg-04-transforms.svg",
    svg(
        '  <g transform="translate(20 10)"><g transform="scale(2)">\n'
        '    <rect width="10" height="5" transform="rotate(30)" fill="#444"/>\n'
        "  </g></g>\n"
        '  <rect transform="matrix(1 0 0.5 1 50 50)" width="20" height="10" fill="#444"/>\n'
        '  <circle transform="scale(-1 1) translate(-80 0)" cx="10" cy="20" r="5" fill="#444"/>'
    ),
    3,
    200 + 200 + math.pi * 25,
)


def quad(p0, p1, p2, n=400):
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
        for t in (i / n for i in range(1, n + 1))
    ]


def cubic(p0, p1, p2, p3, n=400):
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append(
            (
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            )
        )
    return out


# Every path command, absolute and relative, with the areas worked out here.
a_points = [(10, 10), (40, 10), (40, 30)] + quad((40, 30), (25, 45), (10, 30))
b_start = (60, 10)
b_c1 = cubic(b_start, (70, 2), (80, 2), (90, 10))
# "s 10 20 0 30": the first control point mirrors the last one of the curve before.
b_c2 = cubic((90, 10), (100, 18), (100, 30), (90, 40))
b_points = [b_start] + b_c1 + b_c2 + [(60, 40)]
t_q1 = quad((10, 60), (20, 45), (30, 60))
# "t 20 0": the control point mirrors the one before, (20,45) about (30,60).
t_q2 = quad((30, 60), (40, 75), (50, 60))
t_points = [(10, 60)] + t_q1 + t_q2 + [(50, 75), (10, 75)]
case(
    "svg-05-path-commands.svg",
    svg(
        '  <path fill="#222" d="M 10 10 H 40 V 30 Q 25 45 10 30 Z"/>\n'
        '  <path fill="#222" d="m 60 10 c 10 -8 20 -8 30 0 s 10 20 0 30 l -30 0 z"/>\n'
        '  <path fill="#222" d="M10,60q10-15,20,0t20,0v15h-40z"/>\n'
        '  <path fill="#222" d="M 66 62 a 9 9 0 1 0 18 0 a 9 9 0 1 0 -18 0 z"/>'
    ),
    4,
    shoelace(a_points) + shoelace(b_points) + shoelace(t_points) + math.pi * 81,
    tolerance=0.002,
)

case(
    "svg-06-fill-rules.svg",
    svg(
        # Two squares wound the same way: non-zero fills the inner one too.
        '  <path fill="#555" d="M5 5 H25 V25 H5 Z M10 10 H20 V20 H10 Z"/>\n'
        # The same with even-odd: the inner square is a hole.
        '  <path fill="#555" fill-rule="evenodd" d="M35 5 H55 V25 H35 Z M40 10 H50 V20 H40 Z"/>\n'
        # Two overlapping squares in one path are one shape.
        '  <path fill="#555" d="M5 40 H25 V60 H5 Z M15 50 H35 V70 H15 Z"/>\n'
        # Two overlapping shapes drawn separately stay two shapes.
        '  <rect fill="#555" x="50" y="40" width="20" height="20"/>\n'
        '  <rect fill="#777" x="60" y="50" width="20" height="20"/>\n'
        # A bow tie: its two halves are separate shapes.
        '  <polygon fill="#555" fill-rule="evenodd" points="75,5 95,25 95,5 75,25"/>'
    ),
    7,
    400 + 300 + 700 + 400 + 400 + 200,
)

case(
    "svg-07-outlines-nested.svg",
    svg(
        '  <g fill="none" stroke="#000" stroke-width="0.2">\n'
        '    <rect x="20" y="20" width="60" height="40"/>\n'
        '    <circle cx="38" cy="40" r="8"/>\n'
        '    <circle cx="62" cy="40" r="8"/>\n'
        "  </g>"
    ),
    3,
    2400,
    build="all",
    simulate=True,
)

# A slot drawn the way some CAD exports do it: every line and arc its own element.
case(
    "svg-08-separate-segments.svg",
    svg(
        '  <g fill="none" stroke="#000" stroke-width="0.1">\n'
        '    <path d="M 65 25 A 5 5 0 0 1 65 35"/>\n'
        '    <line x1="35" y1="25" x2="65" y2="25"/>\n'
        '    <path d="M 35 25 A 5 5 0 0 0 35 35"/>\n'
        '    <line x1="65" y1="35" x2="35" y2="35"/>\n'
        '    <polyline points="20,60 40,50 60,60 80,50"/>\n'
        "  </g>"
    ),
    1,
    300 + math.pi * 25,
    open=1,
    build="all",
)

case(
    "svg-09-things-left-out.svg",
    svg(
        '  <defs><rect id="unused" width="50" height="50" fill="red"/></defs>\n'
        '  <rect x="10" y="10" width="20" height="10" fill="#000"/>\n'
        '  <rect x="50" y="10" width="20" height="10" fill="#000" display="none"/>\n'
        '  <rect x="50" y="30" width="20" height="10" fill="none"/>\n'
        '  <rect x="10" y="40" width="0.05" height="0.05" fill="#000"/>\n'
        '  <text x="10" y="70" font-size="8">Not outlines</text>\n'
        '  <image x="60" y="50" width="10" height="10" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="/>'
    ),
    1,
    200,
    has_text=True,
    images=1,
    specks=1,
)

# As Illustrator writes it: no size, a viewBox in points, fills from a style sheet.
case(
    "svg-10-style-sheet-no-size.svg",
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 283.46 141.73">\n'
    "  <defs><style>.cls-1{fill:#231f20;}.cls-2{fill:none;stroke:#231f20;stroke-miterlimit:10;}</style></defs>\n"
    '  <rect class="cls-1" x="20" y="20" width="100" height="50"/>\n'
    '  <circle class="cls-2" cx="200" cy="70" r="40"/>\n'
    "</svg>\n",
    2,
    (5000 + math.pi * 1600) * PX * PX,
    page=[283.46 * PX, 141.73 * PX],
)

case(
    "svg-11-use-and-symbols.svg",
    svg(
        '  <defs><rect id="tile" width="12" height="12" fill="#246"/></defs>\n'
        '  <use href="#tile" x="10" y="10"/>\n'
        '  <use href="#tile" x="40" y="10"/>\n'
        '  <use href="#tile" x="70" y="10" transform="rotate(45 76 16)"/>',
        extra=' xmlns:xlink="http://www.w3.org/1999/xlink"',
    ),
    3,
    3 * 144,
)

# As Inkscape writes it: its own namespaces, a layer with a transform, style attributes.
case(
    "svg-12-inkscape-layers.svg",
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    '<svg width="120mm" height="60mm" viewBox="0 0 120 60" version="1.1" id="svg1"\n'
    '   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n'
    '   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"\n'
    '   xmlns="http://www.w3.org/2000/svg">\n'
    '  <sodipodi:namedview id="namedview1" inkscape:document-units="mm"/>\n'
    '  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(-5,-5)">\n'
    '    <path style="fill:#800000;stroke:none;stroke-width:0.26" d="m 20,20 h 30 v 20 h -30 z" id="path1"/>\n'
    '    <ellipse style="fill:#008000;fill-opacity:1;stroke:#000000;stroke-width:0.5" cx="85" cy="35" rx="20" ry="12" id="e1"/>\n'
    '    <path style="display:none;fill:#000000" d="m 0,0 h 5 v 5 h -5 z" id="hidden"/>\n'
    "  </g>\n"
    "</svg>\n",
    2,
    600 + math.pi * 240,
    build="all",
)

# Lettering turned into outlines: strokes too thin for most tools.
case(
    "svg-13-thin-letters.svg",
    svg(
        '  <rect x="10" y="10" width="1.2" height="20" fill="#000"/>\n'
        '  <polygon points="20,10 21.2,10 21.2,28.8 30,28.8 30,30 20,30" fill="#000"/>\n'
        '  <path fill-rule="evenodd" fill="#000" d="M 40 20 a 8 8 0 1 0 16 0 a 8 8 0 1 0 -16 0 z M 41.2 20 a 6.8 6.8 0 1 0 13.6 0 a 6.8 6.8 0 1 0 -13.6 0 z"/>',
        width="70mm",
        height="40mm",
        view="0 0 70 40",
    ),
    3,
    24 + 34.56 + math.pi * (64 - 6.8**2),
)

# A full bed of shapes, to see how long a large job takes.
body = []
for j in range(5):
    for i in range(8):
        cx, cy = 20 + i * 35.7, 21 + j * 37
        if (i + j) % 2 == 0:
            body.append(f'  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="12" fill="#333"/>')
        else:
            body.append(f'  <rect x="{cx - 11:.2f}" y="{cy - 11:.2f}" width="22" height="22" fill="#333"/>')
case(
    "svg-14-full-bed.svg",
    svg("\n".join(body), width="290mm", height="190mm", view="0 0 290 190"),
    40,
    20 * math.pi * 144 + 20 * 484,
    page=[290, 190],
)

# ---------------------------------------------------------------- DXF


def dxf(entities, units=None, header_extra=()):
    lines = []
    if units is not None or header_extra:
        lines += ["0", "SECTION", "2", "HEADER"]
        if units is not None:
            lines += ["9", "$INSUNITS", "70", str(units)]
        lines += list(header_extra)
        lines += ["0", "ENDSEC"]
    lines += ["0", "SECTION", "2", "ENTITIES"]
    for kind, groups in entities:
        lines += ["0", kind]
        for code, value in groups:
            lines += [str(code), f"{value:.6f}" if isinstance(value, float) else str(value)]
    lines += ["0", "ENDSEC", "0", "EOF"]
    return "\n".join(lines) + "\n"


def line(a, b):
    return ("LINE", [(8, "0"), (10, float(a[0])), (20, float(a[1])), (30, 0.0), (11, float(b[0])), (21, float(b[1])), (31, 0.0)])


def arc(c, r, a0, a1, extra=()):
    return ("ARC", [(8, "0"), (10, float(c[0])), (20, float(c[1])), (30, 0.0), (40, float(r)), (50, float(a0)), (51, float(a1))] + list(extra))


def circle(c, r):
    return ("CIRCLE", [(8, "0"), (10, float(c[0])), (20, float(c[1])), (30, 0.0), (40, float(r))])


# A slot from two lines and two arcs, given out of order, with a hole in it.
slot = [
    arc((60, 20), 10, 270, 90),
    line((20, 30), (60, 30)),
    arc((20, 20), 10, 90, 270),
    line((60, 10), (20, 10)),
    circle((40, 20), 5),
]
case("dxf-01-lines-and-arcs.dxf", dxf(slot), 2, 40 * 20 + math.pi * 100, page=[70, 30], unit="no unit", build="all", simulate=True)


def lwpolyline(vertices, closed):
    groups = [(8, "0"), (90, len(vertices)), (70, 1 if closed else 0)]
    for v in vertices:
        groups += [(10, float(v[0])), (20, float(v[1]))]
        if len(v) > 2 and v[2]:
            groups.append((42, float(v[2])))
    return ("LWPOLYLINE", groups)


# A rounded rectangle 40 x 20 with 5 mm corners (quarter arcs have bulge tan(22.5 deg)),
# and a plain closed square.
q = math.tan(math.pi / 8)
rounded = [(5, 0), (35, 0, q), (40, 5), (40, 15, q), (35, 20), (5, 20, q), (0, 15), (0, 5, q)]
case(
    "dxf-02-polylines-with-bulges.dxf",
    dxf([lwpolyline(rounded, True), lwpolyline([(50, 0), (70, 0), (70, 20), (50, 20)], True)], units=4),
    2,
    800 - (4 - math.pi) * 25 + 400,
    page=[80, 30],
    build="all",
)

ellipse = ("ELLIPSE", [(8, "0"), (10, 30.0), (20, 20.0), (30, 0.0), (11, 20.0), (21, 0.0), (31, 0.0), (40, 0.5), (41, 0.0), (42, 2 * math.pi)])
case(
    "dxf-03-circles-and-ellipse.dxf",
    dxf([circle((80, 20), 15), circle((80, 20), 6), ellipse], units=4),
    3,
    math.pi * 225 + math.pi * 200,
)

# A circle as a rational spline (nine control points, weights at the corners),
# and a shape closed by a cubic spline on top of three lines.
w = math.sqrt(0.5)
r = 15.0
ctrl = [(r, 0), (r, r), (0, r), (-r, r), (-r, 0), (-r, -r), (0, -r), (r, -r), (r, 0)]
weights = [1, w, 1, w, 1, w, 1, w, 1]
knots = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1]
nurbs = [(8, "0"), (70, 4), (71, 2), (72, len(knots)), (73, len(ctrl))]
nurbs += [(40, float(k)) for k in knots]
for (x, y), wt in zip(ctrl, weights):
    nurbs += [(10, float(x + 20)), (20, float(y + 20)), (30, 0.0), (41, float(wt))]
bez = [(50, 20), (55, 40), (75, 40), (80, 20)]
bspline = [(8, "0"), (70, 8), (71, 3), (72, 8), (73, 4)] + [(40, float(k)) for k in [0, 0, 0, 0, 1, 1, 1, 1]]
for x, y in bez:
    bspline += [(10, float(x)), (20, float(y)), (30, 0.0)]
arch = [bez[0]] + cubic(*bez) + [(80, 5), (50, 5)]
case(
    "dxf-04-splines.dxf",
    dxf([("SPLINE", nurbs), ("SPLINE", bspline), line((80, 20), (80, 5)), line((80, 5), (50, 5)), line((50, 5), (50, 20))], units=4),
    2,
    math.pi * 225 + shoelace(arch),
    tolerance=0.002,
    build="all",
)

case(
    "dxf-05-inches.dxf",
    dxf([lwpolyline([(1, 1), (3, 1), (3, 3), (1, 3)], True)], units=1),
    1,
    4 * 25.4**2,
    page=[2 * 25.4 + 10, 2 * 25.4 + 10],
    unit="inches",
)

hatch = ("HATCH", [(8, "0"), (2, "SOLID"), (70, 1)])
insert = ("INSERT", [(8, "0"), (2, "BLOCK1"), (10, 0.0), (20, 0.0)])
text = ("TEXT", [(8, "0"), (10, 0.0), (20, 40.0), (40, 5.0), (1, "Label")])
case(
    "dxf-06-things-left-out.dxf",
    dxf(
        [lwpolyline([(0, 0), (20, 0), (20, 20), (0, 20)], True), line((30, 0), (50, 0)), line((50, 0), (50, 20)), hatch, insert, text],
        units=4,
    ),
    1,
    400,
    open=1,
    has_text=True,
    unsupported=["HATCH", "INSERT"],
)

# The old POLYLINE with its vertices as entities of their own: a circle from
# two half-turn bulges, and a triangle.
heavy = [
    ("POLYLINE", [(8, "0"), (66, 1), (70, 1)]),
    ("VERTEX", [(8, "0"), (10, 0.0), (20, 10.0), (42, 1.0)]),
    ("VERTEX", [(8, "0"), (10, 20.0), (20, 10.0), (42, 1.0)]),
    ("SEQEND", [(8, "0")]),
    ("POLYLINE", [(8, "0"), (66, 1), (70, 1)]),
    ("VERTEX", [(8, "0"), (10, 30.0), (20, 0.0)]),
    ("VERTEX", [(8, "0"), (10, 50.0), (20, 0.0)]),
    ("VERTEX", [(8, "0"), (10, 30.0), (20, 20.0)]),
    ("SEQEND", [(8, "0")]),
]
case("dxf-07-old-polylines.dxf", dxf(heavy), 2, math.pi * 100 + 200, unit="no unit")

# A quarter disc whose arc is drawn in a mirrored plane (its normal points
# down), as some programs write arcs drawn clockwise.
mirrored = arc((-30, 0), 10, 90, 180, extra=[(210, 0.0), (220, 0.0), (230, -1.0)])
case(
    "dxf-08-mirrored-arc.dxf",
    dxf([mirrored, line((30, 10), (30, 0)), line((30, 0), (40, 0))], units=4),
    1,
    math.pi * 25,
)

# Centimetres, Windows line endings, and group codes padded with spaces.
padded = dxf([lwpolyline([(0, 0), (3, 0), (3, 2), (0, 2)], True)], units=5)
padded = "\n".join(("  " + l if i % 2 == 0 else l) for i, l in enumerate(padded.split("\n")[:-1])) + "\n"
case("dxf-09-centimetres-crlf.dxf", padded, 1, 600, newline="\r\n", unit="centimetres", page=[40, 30])

# A coaster as a CAD sketch gives it: an outer circle, an inner circle, and six
# wedges each made of two lines and an arc, in shuffled order.
coaster = [circle((0, 0), 44), circle((0, 0), 40)]
wedges = 0.0
for k in range(6):
    mid = math.radians(60 * k + 30)
    # Each wedge is a pie slice of radius 30 about a point 6 mm out from the centre.
    apex = (6 * math.cos(mid), 6 * math.sin(mid))
    a0, a1 = 60 * k + 8, 60 * k + 52
    p0 = (apex[0] + 30 * math.cos(math.radians(a0)), apex[1] + 30 * math.sin(math.radians(a0)))
    p1 = (apex[0] + 30 * math.cos(math.radians(a1)), apex[1] + 30 * math.sin(math.radians(a1)))
    coaster += [line(apex, p0), arc(apex, 30, a0, a1), line(p1, apex)]
    wedges += math.pi * 900 * 44 / 360
random.Random(7).shuffle(coaster)
case("dxf-10-coaster-sketch.dxf", dxf(coaster, units=4), 8, math.pi * 44**2, page=[98, 98], build="all", simulate=True)


def polygon(points):
    return [line(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]


# One sketch holding three separate parts, as a CAD program exports several
# bodies at once: a house-shaped plate with a ring and three figures with sharp
# corners (one of them with a hole), a strip with two holes, and a plate with
# a triangle. Partly at negative coordinates.
parts = (
    polygon([(-20, 0), (60, 0), (60, 50), (20, 90), (-20, 50)])
    + [circle((20, 45), 12), circle((20, 45), 5)]
    + polygon([(-12, 6), (4, 6), (4, 26), (-12, 12)])
    + polygon([(-6, 10), (1, 10), (1, 19)])
    + polygon([(10, 6), (14, 6), (22, 26), (18, 26)])
    + polygon([(28, 6), (33, 6), (33, 26), (29, 26), (24, 21), (26, 19), (28, 21)])
    + [lwpolyline([(90, 10), (150, 10), (150, 30), (90, 30)], True), circle((100, 20), 4), circle((140, 20), 4)]
    + [lwpolyline([(170, 40), (230, 40), (230, 70), (170, 70)], True)]
    + polygon([(185, 45), (215, 45), (200, 65)])
)
random.Random(11).shuffle(parts)
case("dxf-11-several-parts.dxf", dxf(parts, units=4), 12, 5600 + 1200 + 1800, page=[260, 100])

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"{len(manifest)} drawings written to {OUT}")
