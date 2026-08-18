"""
Detect dimension lines that strike through dimension text in a cutlist PDF.

The cutlist draws dim lines with a GAP broken into them where the value sits
(brokenLine / DimRegistry in pdf.ts). This checks that invariant holds for
every line on the page: no drawn stroke may pass through the bbox of any text
span, minus a small tolerance so glyph bboxes touching a line's endpoint don't
count.

Usage:  python tests/dim_overlap_check.py <file.pdf> [more.pdf ...]
Exit:   0 = clean, 1 = overlaps found (listed per page)
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz

# Span bboxes are generous (full ascender/descender box, plus side bearings).
# Shrink before testing, but shrink the READING axis and the CROSS axis by
# different amounts — and note the reading axis is Y for the 90°-rotated
# height dimensions, so this cannot be hardcoded to X.
#   reading axis: trim only the side bearings at each end
#   cross  axis: trim the ascender/descender padding above and below the ink
SHRINK_READING = 0.04
SHRINK_CROSS = 0.16
# A stroke must cross more than this much of the shrunk box to count — kills
# hairline grazes at box corners.
MIN_CROSS_PT = 0.8


def _clip(p1, p2, rect):
    """Liang-Barsky: length of the segment p1->p2 that lies inside rect."""
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x1 - rect.x0), (dx, rect.x1 - x1),
                 (-dy, y1 - rect.y0), (dy, rect.y1 - y1)):
        if p == 0:
            if q < 0:
                return 0.0
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return 0.0
            t0 = max(t0, r)
        else:
            if r < t0:
                return 0.0
            t1 = min(t1, r)
    if t1 <= t0:
        return 0.0
    return (t1 - t0) * (dx * dx + dy * dy) ** 0.5


# Cream stock fill, also used for the drafting text mask painted behind
# dimension values. A mask hides whatever crosses it, so anything it covers
# is not actually visible ink.
SHEET_FILL = (245 / 255, 239 / 255, 217 / 255)


def _is_sheet_fill(col) -> bool:
    return col is not None and all(abs(a - b) < 0.01 for a, b in zip(col, SHEET_FILL))


def _masks(page):
    """Text-mask rectangles as (paint_order_index, rect). Cream-filled,
    unstroked rects — the drafting text mask painted behind a value."""
    out = []
    for i, d in enumerate(page.get_drawings()):
        if d["type"] != "f" or not _is_sheet_fill(d.get("fill")):
            continue
        for item in d["items"]:
            if item[0] == "re":
                out.append((i, fitz.Rect(item[1])))
    return out


def _segments(page):
    """Every straight segment of visible ink, as ((x1,y1),(x2,y2)).

    Filled paths count: the dimension arrowheads are filled triangles, and an
    arrowhead landing on a value overlaps it just as badly as a line does.
    Cream mask rectangles are NOT ink — they are the thing that hides ink —
    so they are skipped, otherwise every mask would report as crossing the
    value it exists to protect.
    """
    segs = []
    for i, d in enumerate(page.get_drawings()):
        if d["type"] == "f" and _is_sheet_fill(d.get("fill")):
            continue
        for item in d["items"]:
            if item[0] == "l":
                segs.append((i, tuple(item[1]), tuple(item[2])))
            elif item[0] == "re":
                r = item[1]
                cs = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
                segs += [(i, cs[j], cs[(j + 1) % 4]) for j in range(4)]
    return segs


def _text_boxes(page):
    """Shrunk bbox per text span, with its string.

    `line['dir']` gives the reading direction — (1,0) horizontal, (0,-1) for
    the 90°-rotated height values — which decides which bbox axis is the
    reading axis and therefore which shrink applies to it.
    """
    out = []
    for blk in page.get_text("dict")["blocks"]:
        for line in blk.get("lines", []):
            dx, dy = line.get("dir", (1.0, 0.0))
            vertical = abs(dy) > abs(dx)
            for span in line.get("spans", []):
                txt = span["text"].strip()
                if not txt:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                w, h = x1 - x0, y1 - y0
                if w <= 0 or h <= 0:
                    continue
                if vertical:      # reading axis is Y, cross axis is X
                    sx, sy = SHRINK_CROSS, SHRINK_READING
                else:             # reading axis is X, cross axis is Y
                    sx, sy = SHRINK_READING, SHRINK_CROSS
                out.append((fitz.Rect(x0 + w * sx, y0 + h * sy,
                                      x1 - w * sx, y1 - h * sy), txt))
    return out


def check(path: Path) -> int:
    doc = fitz.open(str(path))
    total = 0
    for pno, page in enumerate(doc, start=1):
        boxes = _text_boxes(page)
        segs = _segments(page)
        masks = _masks(page)
        hits = []
        for rect, txt in boxes:
            # A mask painted over this value hides every stroke laid down
            # BEFORE it. Paint order is content-stream order, so only strokes
            # with a later index are still visible on top of the mask.
            shield = -1
            for idx, m in masks:
                if m.x0 <= rect.x0 + 0.5 and m.y0 <= rect.y0 + 0.5 \
                   and m.x1 >= rect.x1 - 0.5 and m.y1 >= rect.y1 - 0.5:
                    shield = max(shield, idx)
            for si, a, b in segs:
                if si < shield:
                    continue
                crossed = _clip(a, b, rect)
                if crossed > MIN_CROSS_PT:
                    hits.append((txt, round(crossed, 2), rect))
                    break
        if hits:
            print(f"  p{pno}: {len(hits)} text span(s) struck through")
            for txt, crossed, rect in hits[:12]:
                print(f"      {txt!r:22s} crossed {crossed}pt  at ({rect.x0:.0f},{rect.y0:.0f})")
            if len(hits) > 12:
                print(f"      … and {len(hits) - 12} more")
        total += len(hits)
    doc.close()
    print(f"{path.name}: {total} overlap(s)")
    return total


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    grand = 0
    for a in argv:
        grand += check(Path(a))
    print("\n" + ("CLEAN" if grand == 0 else f"FAIL — {grand} overlap(s)"))
    return 1 if grand else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
