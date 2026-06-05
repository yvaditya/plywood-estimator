# Plywood Estimator

A browser app for cabinet builders and woodworkers.
Drop one or more STEP files → pick the panel bodies → get optimized cut
sheets, a shopping list, edge-banding totals, cost rollups, DXF/PDF cut
plans, and per-sheet cut instructions.

Runs entirely in the browser. STEP parsing via OpenCascade (WASM); 2D
nesting in pure TypeScript; 3D viewer in Three.js.

---

## Run

### Windows
Double-click `launch.bat`. First run installs deps; subsequent runs just
start the dev server and open the browser.

### macOS
First time only, in Terminal:
```sh
chmod +x launch.command
```
Then double-click `launch.command` in Finder.

### Manual
```sh
cd app
npm install
npm run dev
```
Open <http://localhost:5173/>.

Requires Node 18 or newer.

---

## Features

### Import
- **Multi-file STEP** — drop several `.step`/`.stp` files in a row; each
  file's bodies append to the model with the file name as a prefix.
- **Auto-layout** — additional files are translated along +X (cumulative
  width + a 100 mm gap) and snapped down so each file's lowest point sits
  on the floor (`z=0`).
- **Non-sheet-good filter** — round legs, dowels, blocks etc. are
  detected (thinnest extent outside the 1/8" – 1" plywood range or not
  meaningfully thinner than the other two) and rendered in red dashed in
  the 3D view, but excluded from the cut list. Body count shows
  `N sheet / M total` so you can see what was skipped.

### 3D viewer
- **Z-up world** (STEP convention) with Three.js, GTAO, OutlinePass,
  SMAA, MSAA × 4 multisampled composer target, 4K shadow maps, Khronos
  PBR Neutral tone mapping.
- **Click-to-select** bodies; selected bodies pop with a white halo and
  the rest dim but stay readable via the edge overlay.
- **24 hand-picked distinct colors** + HSL fallback for jobs past 24
  parts.
- **Two-layer edge overlay**: sharp creases dark, tangential transitions
  light.
- **Grain arrows** on both flat faces of each selected body at the panel
  centroid. Color/shape codes the grain state. Click an arrow to cycle
  free → length → width.

### Analysis
- **Body analysis** (`geometry.ts`) computes thickness, in-face length
  and width, and a 2D polygon outline of the part's flat face. World-axis
  AABB is the fast path; PCA-OBB is the fallback for tilted panels.
- **Auto-orient** rotates the outline polygon so its dominant edge
  direction is axis-aligned with the sheet — angled cuts are minimized.

### Cut sheet nesting
- **Two cut strategies**:
  - **Max yield** — MaxRects bin packer (Jukka Jylänki), best yield.
  - **Min cuts** — Guillotine bin packer (SAS variant). Every placement
    is a single edge-to-edge cut — producible with a track saw or
    panel saw.
- **Per-thickness grouping** with 0.5 mm bucket tolerance so float-noise
  copies of the same part don't split into multiple sheet stacks.
- **Auto-orient sheet** (landscape vs portrait) — the nester tries both
  bin orientations per thickness group and keeps the winner.
- **Grain → orientation**: `grain=length` aligns the part's long edge
  along the sheet's length axis; `grain=width` aligns it across.
- **Multi-restart optimizer** (configurable 1 – 256 tries). Each try
  combines a different (heuristic × insertion-order) pair; the best
  result is kept by (fewest unplaced → fewest sheets → tightest fill).

### Outputs
- **2D layout** SVG in the right pane (and PDF) with darker plywood
  background, per-body colored chunks, big letter labels, and grain
  arrows.
- **Thumbnail strip** of all sheets in the job; aspect-ratio-aware so
  landscape and portrait both render correctly.
- **DXF export** (R12 ASCII) per sheet — layers SHEET / MARGIN / PARTS /
  LABELS / DIMS. Opens in AutoCAD, Fusion, FreeCAD, LightBurn, etc.
- **PDF report** with paper-size selector (Letter / Legal / Tabloid / A4,
  portrait or landscape):
  1. Summary page (sheets, yield, waste, edge-banding, cost).
  2. **Parts overview** — IKEA-style grid of unique parts with A/B/C
     letter labels, silhouettes, dimensions, and quantities.
  3. One page per cut sheet, parts overlaid with letter labels.
  4. **Cut instructions** — numbered rip-then-crosscut steps per sheet
     with distances from the reference edges and a total cut count.

### Shopping list (sidebar)
Auto-generated from the latest nest result.
Per row: thickness · sheet dims · need · have (editable, persisted in
localStorage) · buy · unit price (editable) · line cost. Job-cost
total at the bottom. Copy to clipboard or CSV export.

### Job metadata
Job name, currency, and PDF paper size all persist across sessions.

---

## Project layout

```
plywood estimator/
├── launch.bat            Windows double-click launcher
├── launch.command        macOS double-click launcher
├── README.md
├── docs/
│   ├── ARCHITECTURE.md   Data flow / pipeline documentation
│   └── CLAUDE.md         Notes for future Claude sessions
└── app/
    ├── index.html
    ├── package.json, tsconfig.json, vite.config.ts
    ├── public/occt/      OpenCascade WASM (served statically)
    └── src/
        ├── stepLoader.ts     STEP → meshes via occt-import-js
        ├── geometry.ts       Body analysis (thickness + outline + face data)
        ├── viewer.ts         Three.js viewer + grain-arrow widgets
        ├── packRect.ts       MaxRects + Guillotine bin packers
        ├── nest.ts           Group-by-thickness, multi-restart wrapper
        ├── instructions.ts   Letter labels + cut-step generation
        ├── shoppingList.ts   Buy/have rollup + CSV
        ├── dxf.ts            DXF R12 writer
        ├── pdf.ts            jsPDF report (summary + parts + sheets + cuts)
        ├── units.ts          mm/in formatting, fractional inches, money
        ├── main.ts           UI wiring
        └── style.css         Notion-style theme
```

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the data flow /
pipeline documentation.

---

## License
Copyright (c) 2026 Aditya Yerra <vyerra@icloud.com>. All rights reserved.

Source-available — see [LICENSE](./LICENSE).

Short version:
- Free for personal, non-profit, and educational use, and for evaluation.
- For-profit shops may use it internally for their own work.
- No reselling, sublicensing, or offering it as a paid product/service.
- No using this repo or its code as training/eval data for any AI or ML
  model.

For any other commercial use, contact Aditya Yerra <vyerra@icloud.com>
for a separate license.
