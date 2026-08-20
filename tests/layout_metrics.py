"""
Score a cut layout the way the shop actually pays for it.

Sheet count is not the only cost. On a track saw with a parallel guide the
cost is the number of distinct FLIP-STOP SETTINGS and the number of
rip<->crosscut rotations — cutting six parts that share a width is one setup,
cutting six different widths is six. This reads a layout (from our own DXF
export, PARTS layer) and reports both.

Usage:  python tests/layout_metrics.py <sheet.dxf> [more.dxf ...]
"""
from __future__ import annotations

import os
import sys
from collections import Counter

import ezdxf

TOL = 1.0  # mm — two coordinates this close are the same saw setting


def parts_of(path: str):
    """(x, y, w, h) per part rect on the PARTS layer, plus the sheet size."""
    doc = ezdxf.readfile(path)
    msp = doc.modelspace()
    out, sheet = [], None
    for e in msp:
        if e.dxftype() not in ("POLYLINE", "LWPOLYLINE"):
            continue
        pts = ([(p[0], p[1]) for p in e.points()] if e.dxftype() == "LWPOLYLINE"
               else [(v.dxf.location[0], v.dxf.location[1]) for v in e.vertices])
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        box = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        if e.dxf.layer == "PARTS":
            out.append(box)
        elif e.dxf.layer == "SHEET":
            sheet = box
    return out, sheet


def cluster(vals, tol=TOL):
    """Distinct values within tol — i.e. distinct saw settings."""
    out = []
    for v in sorted(vals):
        if not out or abs(v - out[-1][0]) > tol:
            out.append([v, 1])
        else:
            out[-1][1] += 1
    return out


def largest_free(parts, sw, sh, margin=12.7):
    """Biggest empty axis-aligned rectangle inside the margin box.

    The remnant only counts if it comes off as ONE piece — two thin slivers
    of the same total area are scrap. Solved on the grid induced by the
    parts' own edges, so every maximal empty rectangle is representable.
    """
    x0, y0, x1, y1 = margin, margin, sw - margin, sh - margin
    xs = sorted({x0, x1} | {v for x, _, w, _ in parts for v in (x, x + w)
                            if x0 < v < x1})
    ys = sorted({y0, y1} | {v for _, y, _, h in parts for v in (y, y + h)
                            if y0 < v < y1})
    if len(xs) < 2 or len(ys) < 2:
        return None
    occ = [[any(xs[c] >= px - .01 and xs[c + 1] <= px + pw + .01
                and ys[r] >= py - .01 and ys[r + 1] <= py + ph + .01
                for px, py, pw, ph in parts)
            for c in range(len(xs) - 1)] for r in range(len(ys) - 1)]
    colw = [xs[c + 1] - xs[c] for c in range(len(xs) - 1)]
    heights = [0.0] * (len(xs) - 1)
    best = None
    for r in range(len(ys) - 1):
        rh = ys[r + 1] - ys[r]
        for c in range(len(xs) - 1):
            heights[c] = 0.0 if occ[r][c] else heights[c] + rh
        for c in range(len(xs) - 1):
            if heights[c] == 0:
                continue
            h = heights[c]
            w = 0.0
            for d in range(c, len(xs) - 1):
                if heights[d] == 0:
                    break
                h = min(h, heights[d])
                w += colw[d]
                if not best or w * h > best[0] * best[1]:
                    best = (w, h)
    return best


def report(paths):
    tot_area = tot_sheet = 0.0
    all_rows = []
    for p in paths:
        parts, sheet = parts_of(p)
        if not sheet:
            print(f"{os.path.basename(p)}: no SHEET layer, skipping")
            continue
        sw, sh = sheet[2], sheet[3]
        area = sum(w * h for _, _, w, h in parts)
        tot_area += area
        tot_sheet += sw * sh

        # A layout is "row structured" when parts share Y bands: one rip
        # frees a whole band, then the band is crosscut. Same for columns.
        ys = cluster([y for _, y, _, _ in parts])
        hs = cluster([h for _, _, _, h in parts])
        xs = cluster([x for x, _, _, _ in parts])
        ws = cluster([w for _, _, w, _ in parts])
        sizes = Counter((round(w, 1), round(h, 1)) for _, _, w, h in parts)

        free = largest_free(parts, sw, sh)
        all_rows.append((os.path.basename(p), len(parts), area / (sw * sh),
                         len(ys), len(hs), len(xs), len(ws), free))
        print(f"\n=== {os.path.basename(p)} ===")
        print(f"  sheet {sw:.1f} x {sh:.1f}   {len(parts)} parts   "
              f"fill {area / (sw * sh) * 100:.1f}%")
        print(f"  distinct Y bands (rip settings) : {len(ys):2d}  "
              + " ".join(f"{v:.0f}x{n}" for v, n in ys))
        print(f"  distinct part HEIGHTS           : {len(hs):2d}  "
              + " ".join(f"{v:.0f}x{n}" for v, n in hs))
        print(f"  distinct X starts (cross stops) : {len(xs):2d}")
        print(f"  distinct part WIDTHS            : {len(ws):2d}  "
              + " ".join(f"{v:.0f}x{n}" for v, n in ws))
        if free:
            print(f"  biggest single remnant          : {free[0]:.0f} x {free[1]:.0f} mm"
                  f"  ({free[0] * free[1] / (sw * sh) * 100:.1f}% of the sheet)")
        print(f"  repeated sizes: "
              + ", ".join(f"{w:.0f}x{h:.0f} x{n}" for (w, h), n in sizes.most_common()
                          if n > 1) or "  (none)")

    print("\n--- totals ---")
    print(f"  sheets {len(all_rows)}   overall fill "
          f"{tot_area / tot_sheet * 100:.1f}%")
    setup = sum(r[4] + r[6] for r in all_rows)
    print(f"  sum of distinct heights+widths across sheets (setup proxy): {setup}")
    for r in all_rows:
        rem = f"{r[7][0]:.0f}x{r[7][1]:.0f}" if r[7] else "-"
        print(f"    {r[0]:26s} parts {r[1]:2d} fill {r[2]*100:5.1f}%  "
              f"heights {r[4]} widths {r[6]}  remnant {rem}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    report(sys.argv[1:])
