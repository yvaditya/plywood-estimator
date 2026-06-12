# ARCHITECTURE — Data Pipeline

How a dropped STEP file becomes an optimized cut plan, function by function.
(Reader-friendly companion with diagrams: [WHITEPAPER.md](WHITEPAPER.md).)

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ User drops   │ →  │  STEP parse  │ →  │  Body        │ →  │  3D viewer   │
│ .step files  │    │  (OCCT WASM) │    │  analysis    │    │  + body list │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                                   │
                                                                   ↓ user picks
                                                                   bodies +
                                                                   sets grain
                                                                   │
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────┴───────┐
│  PDF / DXF / │ ←  │  Cut sheet   │ ←  │  Nest        │ ←  │  Estimate    │
│  CSV / STEP  │    │  detail +    │    │  (worker pool│    │  (+ CNC auto-│
│  exports     │    │  join guide  │    │   multicore) │    │   split)     │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

---

## Stage 1: File drop → OCCT mesh

**Entry**: `handleFiles(FileList)` in `src/main.ts`.

For each file in order:

1. **Z-to-floor translation** — `meshesAabbAxis(meshes, 2)` finds the
   file's vertical bottom. `shiftMeshesAxis(meshes, 2, -zMin)` shifts the
   geometry so the lowest point sits at world `z = 0`.

2. **X auto-layout** — `meshesAabbAxis(meshes, 0)` finds horizontal
   extents. `shiftMeshesX` slides this file along `+X` by
   `cumulativeRightX + FILE_GAP - bbox.min`, so files lay out in a row
   instead of overlapping at origin. `cumulativeRightX` is a
   process-lifetime cursor; `clearAll()` resets it.

3. **STEP parse** — `parseStep(arrayBuffer)` in `src/stepLoader.ts` invokes
   the OpenCascade WASM importer (`occt-import-js`). Returns an
   `OcctResult` containing a `meshes[]` array of `OcctMesh`
   (positions, normals, triangle indices, brep-face boundaries).

   Tessellation fidelity is set HERE and nowhere else: **0.1 mm absolute
   linear deflection + 0.2 rad angular**. The importer only exposes
   triangles (no B-spline pass-through), so this is the curve quality for
   the whole pipeline — far inside cutting tolerance.

   This stage runs *after* the Z and X shifts so the rest of the
   pipeline sees the translated coordinates naturally.

4. **Import progress** — `handleFiles` drives a per-file progress bar
   (parse share, then per-body analysis), yielding to the event loop every
   few bodies so the page stays responsive on large assemblies.

---

## Stage 2: Body analysis

**Entry**: `analyzeBody(mesh)` in `src/geometry.ts`.

Per mesh:

1. **AABB extents** along the three world axes → `(ext[0], ext[1], ext[2])`.

2. **Sheet-good gate** (returns `null` to skip otherwise):
   - thinnest extent must be **3 mm – 26 mm** (≈ 1/8" – 1" plywood
     stock thickness range);
   - thinnest extent must be `< 0.5 × ` mid extent;
   - if world axes don't qualify, the same test runs on a PCA-OBB so
     tilted panels still pass.

   Bodies that fail (round legs, dowels, blocks) flow into
   `viewer.addNonSheetMesh()` for visual representation (red dashed) and
   are excluded from the body list and the nester.

   **Tilt correction.** The world-axis AABB measures thickness along a
   world axis, so a panel that leans even a couple of degrees has its
   thin extent inflated by a slice of its own length/width (a 1/2" panel
   can read as 7/8" and split onto its own sheet). The PCA-OBB is
   therefore *always* computed: when its least-variance axis — which
   stays perpendicular to the panel face regardless of tilt — finds a
   meaningfully thinner *and still sheet-valid* thickness
   (`obbThin < worldThickness × 0.9`), `analyzeBody` trusts the OBB over
   the inflated world reading. For a genuinely axis-aligned panel
   `obbThin === worldThickness`, so the world path is unchanged.

3. **Axis-aligned analysis** (`analyzeAxisAligned`):
   - thinIdx = thinnest axis → `thickness`;
   - bigIdx / midIdx → `length` / `width`;
   - `faceNormal` = world-axis unit vector of thinIdx;
   - `faceCenter` = AABB centroid + half-thickness along faceNormal;
   - `lengthDir`, `widthDir` = world-axis unit vectors of bigIdx, midIdx.

4. **Outline extraction** (`buildOutline`):
   - filter triangles whose normal aligns with `+faceNormal`
     (`dot >= 0.92`) — that's the "front face";
   - walk the boundary edges of that triangle set into closed loops
     (boundary edge = appears in exactly one triangle);
   - project loops onto the `(lengthDir, widthDir)` plane → 2D rings;
   - largest-area ring = `outer` (CCW); the rest are `holes` (CW).

5. **Auto-orient** (`dominantEdgeAngleMod90` + `rotateRing2`):
   - length-weighted histogram of edge angles mod 90°;
   - rotate the polygon by the smaller of `-angle` or `(90 - angle)` so
     the dominant direction lands on an axis;
   - re-shift so the outer ring sits at `(0, 0)`.

6. **PartFootprint cache** is built per-part in `nest.ts`:
   anchored polygon at 0° AND 90° pre-computed once per body for reuse
   across instances.

`analyzeBody` returns a `BodyAnalysis` containing `thickness, length,
width, outline, centerWorld, faceCenter, faceNormal, lengthDir,
widthDir`. Main wraps this in a `BodyState` (with user-editable `qty`,
`grain`, `rotation`, `selected`, `color`) and pushes it to
`state.bodies`.

---

## Stage 3: 3D viewer

**Entry**: `viewer.addOcctMesh()` and `viewer.addNonSheetMesh()` in
`src/viewer.ts`.

- One `Three.Mesh` per body using a `MeshPhysicalMaterial` with a
  unique color from `bodyColor(i)` (24-color Tableau-grade palette +
  HSL fallback).
- Two `EdgesGeometry` overlays per mesh:
  - sharp (threshold 25°) → body-color lerped toward black;
  - tangential (threshold 5°) → body-color lerped toward white.
- Per-body `Fresnel rim` injected into the material via
  `onBeforeCompile`.

Post-processing chain on a `samples: 4` MSAA HalfFloat render target:

```
RenderPass → GTAOPass → OutlinePass(hover) → OutlinePass(selected) → SMAAPass → OutputPass
```

**Grain arrows** (`viewer.setBodyGrain`):
each selected body gets a flat ExtrudeGeometry arrow on BOTH faces at
the panel centroid. Direction follows `lengthDir` (length grain) or
`widthDir` (width grain); `free` shows the arrow as a perpendicular
"+". Clicking an arrow fires `onGrainCycle(bodyId)` and main rotates
the grain state.

---

## Stage 4: User picks bodies, sets grain & rotation

Body list rows (`renderBodyList()` in `main.ts`):

- Checkbox toggles selection (synced with viewer click selection).
- `Qty` integer per body.
- `Grain` dropdown (free / length / width) — re-rendered as an arrow on
  the 3D body.
- `Rotation` dropdown (lock / flip90) — sent to the nester.

The body list also shows `N sheet / M total` when non-sheet bodies were
skipped.

---

## Stage 4.5: CNC auto-split (optional, CNC strategies only)

**Entry**: `splitOversizeParts(parts, binX, binY)` in `src/splitParts.ts`,
called from `runEstimate` in `main.ts` BEFORE the nester sees the parts.

Parts whose footprint can't fit the usable sheet at any allowed orientation
are replaced by dovetail-jointed segments (`<id>.s<n>`):

- cut perpendicular to the longest axis into the minimum number of fitting
  pieces; recursion handles doubly-oversize parts;
- candidate cut positions probed around the even split, scored by material
  AREA in the joint zone (cut line + tail depth) — cuts avoid notches and
  holes;
- `tails = max(1, round(jointLen / 120mm))`, depth `1.5×thickness` clamped
  [10, 30] and ≤ tail width, 9° flare; joints < 24 mm get a straight cut;
- polygon booleans via `polygon-clipping`; pieces conserve area exactly
  (tiny flare-tip shards at joint crossings are dropped);
- `state.splitSegmentGeo` keeps segment geometry for the unplaced-STEP
  export and the PDF join guide; placed segments get roman-suffixed panel
  labels (`1a-i`) in `annotatePlacedParts`.

---

## Stage 5: Nest

**Entry**: `runNest` (sync) / `runNestAnimated` (async, used by the UI) in
`src/nest.ts`. Both bucket by thickness, then dispatch by strategy:
rectangle packing (`packRect.ts`) or CNC true-shape (`cncNest.ts`). The
animated path routes through the **multicore worker pool** (`optPool.ts` →
`optWorker.ts`), with the single-core drivers as automatic fallback.

### Rectangle path (free / guillotine / save-last)

1. **Bucket by thickness** at 0.5 mm tolerance. Each bucket nests
   independently into its own stack of sheets.

2. **Per-instance expansion** — each `NestPart` produces `qty` copies.
   `buildFootprint(part)` returns a `PartFootprint` with the polygon
   anchored at 0° and 90°, plus bbox dims `(w0,h0,w90,h90)`.

3. **Rotation policy** (`rotationPolicy(grain, mode, w0, h0)`):
   - `grain=length` → choose pre-rotation that puts the long edge along
     bin X (sheet length axis).
   - `grain=width` → opposite.
   - `grain=free` and `mode='flip90'` → packer may flip 0/90.

4. **Sheet orientation is LOCKED landscape** — bin X = sheet length. (The
   portrait auto-orient try was removed at user request so every document
   shows one consistent orientation.)

5. **Multi-restart optimiser** (`buildTrialSchedule` + `packMulti` /
   `packMultiParallel`): every heuristic (BSSF, BLSF, BAF, BL) × area-desc
   and longest-side-desc orders, then seeded shuffles up to the restarts
   budget. `seedOffset` shifts the shuffle stream for "Optimize further"
   re-runs. The best result wins by the strategy-aware `isBetter`.

6. **Per-attempt packer** (`packOne`):
   The cabinet-builder fix here is critical — when a part doesn't fit
   on the current bin, **skip it and try the next part**. Only when no
   remaining part fits do we close the bin and open a new one. This
   matches SVGnest's placement worker and dramatically reduces sheet
   count vs the naive "close on first failure" policy.

7. **Bin packer** (cut strategy):
   - **`MaxRectsBin`** — Jukka Jylänki's maximal-rectangles algorithm.
   - **`ShelfBin`** — FFDH shelves; the true min-cuts strategy.
   - (**`GuillotineBin`** — legacy SAS splitter, kept for reference.)

8. **Finish** (`finishPack`): `consolidateSheets` rebuilds live bins from
   finished sheets and tries to dissolve the least-filled sheet into the
   others' free space; save-last then corner-packs the last sheet.

### CNC path (cnc / cnc-save-last) — `cncNest.ts`

Raster true-shape nesting: masks per part×angle on a ~5–8 mm grid
(conservative rasterisation from simplified rings; exact contours carried on
the mask for output), kerf halo dilation, holes left open so parts nest
inside them. Placement scan is heavily optimised (SAT O(1) accept/reject,
boundary-first cells, monotonic resume cursors — 17× measured). Each pass
= ordering × scan-direction × placement-policy (bottom-left vs
touching-perimeter); passes fan out across workers; `finalSqueeze`
alternates per-sheet shake with consolidation, then save-last compaction.
"Optimize further" runs `packCncDeep` — a genetic algorithm over placement
orders (order-crossover + swap mutation, generations evaluated in
parallel).

### Output

**Placement → PlacedPart** — each placement is mapped back to the original
polygon (rotated to match the packer) and shifted by the sheet's edge
`margin`. PlacedPart carries the polygon `outer + holes` for downstream
SVG / DXF / PDF rendering.

Returns a `NestResult` with `groups[].sheets[].parts[]` plus aggregate
sheet count, yield, total area, and per-sheet `largestFree` offcut.

---

## Stage 6: Detail + thumbnails + shopping list

`renderResults()` in `main.ts`:

- **Detail SVG** — `buildSheetSvg(sheet, w, l, margin, withLabels)`
  emits the dark plywood sheet, optional margin rect, every part as a
  colored polygon with a darker stroke, a grain arrow per part, and a
  big A/B/C **letter label** plus dimensions sub-label centered on the
  bbox. Per-sheet `sheet.sheetW`/`sheet.sheetL` honor the auto-orient
  choice.

- **Thumbnails** — same `buildSheetSvg(... withLabels=false)` letterboxed
  into a fixed-height card. Aspect-ratio-aware via `style.aspectRatio`.

- **Metrics row** — Total sheets · Parts placed · Yield · Waste · Edge
  banding (sum of part perimeters) · Cuts (unique interior X+Y edges
  across all sheets) · Biggest offcut.

- **Shopping list** — `buildShoppingList(result, sheetW, sheetL)` derives
  one row per thickness group. User can edit `Have` (persisted) and
  `$/sheet` (persisted) to compute `Buy` and `Line cost`. Job total
  bottom strip. CSV export.

---

## Stage 7: Exports

### DXF (STRICT R12 ASCII)
`sheetToDxf(sheet, opt)` in `src/dxf.ts` emits strict R12 with layers
SHEET / MARGIN / PARTS / LABELS / DIMS: classic `POLYLINE`/`VERTEX`/`SEQEND`
(NEVER `LWPOLYLINE` — that's R14 and old waterjet importers reject the
file), LTYPE/STYLE/BLOCKS tables, `$EXTMIN/$EXTMAX`, single `ENDSEC` per
section. `outlinesOnly` mode emits contours only for CAM. Validate changes
with ezdxf's strict `readfile`, not just `recover`.

### PDF report
`buildPdf(result, opt)` in `src/pdf.ts`. Multi-page report on the
user-selected paper size:

1. **Summary** — job name, sheet metrics, per-thickness breakdown,
   inventory check (from shopping list).
2. **Shopping list** page.
3. **Parts overview** — IKEA-style grid (SKIPPED in CNC mode).
4. **One page per sheet** — sheet diagram with parts overlaid + letter
   labels; followed by per-sheet cut-sequence cards (SKIPPED in CNC mode —
   `opt.cnc`; a router follows contours).
5. **Join split parts** (only when the CNC auto-split fired) — each split
   parent drawn reassembled from its segments, labelled `i / ii / …` with
   the sheet panel id (`1a-i`) each piece nests under (`drawSplitJoins`,
   data from `buildSplitJoins()` in main.ts).
6. **Per-cabinet assembly** — cover + IKEA-style step pages.

Shopping list rows flow into the PDF's inventory check section as
`InventoryCheck[]`.

### STEP (unplaced parts)
`buildStep()` in `src/stepExport.ts` — one extruded-prism solid per
unplaced instance from its footprint outline (split segments resolve via
`state.splitSegmentGeo`).

---

## "Optimize further"

`#optimizeMoreBtn` re-runs `runEstimate({ seed: ++n, deepSearch: true })`:
CNC routes to the genetic search (`packCncDeep`), saw strategies get
doubled restarts + a fresh shuffle stream. The new result replaces
`state.lastNest` only if strictly better (unplaced → sheets → yield);
otherwise the previous layout is restored and the verdict shown in
`detailSub`. Every click increments the seed — repeated clicks mine
different regions of the search space.

---

## Coordinates and units

- All internal geometry is in **millimetres**.
- The UI defaults to **inches** display with fractional formatting
  (`fmtFracInches` in `src/units.ts`, 1/16" precision).
- `toMm` / `fromMm` convert at the IO boundary.
- World is **Z-up** to match STEP convention. The 3D scene, lighting,
  shadows, and grain arrows all assume Z-up.
