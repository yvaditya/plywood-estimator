"""
Render exported cut-sheet DXFs to a PNG so two layouts can be compared by eye.

Draws both sides with identical styling — same scale, same colours, same
annotations — because a comparison where the two halves are drawn differently
tells you about the drawing, not the layout.

Usage:
  python tests/render_layout.py out.png "Label A" a1.dxf a2.dxf -- "Label B" b1.dxf b2.dxf
"""
from __future__ import annotations

import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

from layout_metrics import largest_free, parts_of

SHEET_FACE = "#6B4F31"
PART_FACE = "#7FA8D0"
REMNANT = "#3FA34D"


def draw(ax, path, title):
    parts, sheet = parts_of(path)
    sw, sh = sheet[2], sheet[3]
    ax.add_patch(Rectangle((0, 0), sw, sh, facecolor=SHEET_FACE, edgecolor="none"))
    for x, y, w, h in parts:
        ax.add_patch(Rectangle((x, y), w, h, facecolor=PART_FACE,
                               edgecolor="#22405C", linewidth=0.7))
        if min(w, h) > 90:
            ax.text(x + w / 2, y + h / 2, f"{w:.0f}\n×{h:.0f}", ha="center",
                    va="center", fontsize=5.5, color="#12212F")
    free = largest_free(parts, sw, sh)
    fill = sum(w * h for _, _, w, h in parts) / (sw * sh) * 100
    sub = f"{len(parts)} parts · {fill:.1f}% fill"
    if free:
        # Outline where the biggest single usable rectangle actually is.
        best, bx, by = None, 0, 0
        step = 20
        for yy in range(int(sh), -1, -step):
            for xx in range(0, int(sw), step):
                if xx + free[0] > sw or yy + free[1] > sh:
                    continue
                if all(not (xx < px + pw and xx + free[0] > px
                            and yy < py + ph and yy + free[1] > py)
                       for px, py, pw, ph in parts):
                    best, bx, by = free, xx, yy
                    break
            if best:
                break
        if best:
            ax.add_patch(Rectangle((bx, by), best[0], best[1], facecolor="none",
                                   edgecolor=REMNANT, linewidth=1.6, linestyle="--"))
        sub += f" · offcut {free[0]:.0f}×{free[1]:.0f}"
    ax.set_title(f"{title}\n{sub}", fontsize=7.5, linespacing=1.5)
    ax.set_xlim(-40, sw + 40)
    ax.set_ylim(-40, sh + 40)
    ax.set_aspect("equal")
    ax.axis("off")


def main(argv):
    out = argv[0]
    groups, cur = [], None
    for a in argv[1:]:
        if a == "--":
            cur = None
            continue
        if cur is None:
            cur = [a, []]
            groups.append(cur)
        else:
            cur[1].append(a)
    rows = len(groups)
    cols = max(len(g[1]) for g in groups)
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 5.2, rows * 3.0))
    if rows == 1:
        axes = [axes]
    if cols == 1:
        axes = [[a] for a in axes]
    for r, (label, files) in enumerate(groups):
        for c in range(cols):
            ax = axes[r][c]
            if c < len(files):
                draw(ax, files[c], f"{label} — sheet {c + 1}")
            else:
                ax.axis("off")
    fig.tight_layout()
    fig.savefig(out, dpi=170, facecolor="white")
    print("wrote", out)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1:])
