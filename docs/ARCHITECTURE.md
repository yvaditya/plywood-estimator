# ARCHITECTURE — Data Pipeline

How a dropped STEP file becomes an optimized cut plan, function by function.

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
│  CSV exports │    │  detail +    │    │  (multi-     │    │  button      │
│              │    │  thumbnails  │    │   restart)   │    │              │
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

   This stage runs *after* the Z and X shifts so the rest of the
   pipeline sees the translated coordinates naturally.

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

## Stage 5: Nest

**Entry**: `runNest(parts: NestPart[], config: NestConfig)` in `src/nest.ts`.

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

4. **Auto-orient sheet** — `packMulti` runs twice, once with bin =
   `(usableW × usableL)` and once with `(usableL × usableW)`. The
   winner (by `compareTries`: fewest unplaced → fewest sheets → tightest
   last sheet) decides the sheet orientation for this thickness group.
   Per-sheet `sheetW` / `sheetL` are recorded.

5. **Multi-restart packer** (`packMulti` in `src/packRect.ts`):
   - **Phase 1** — every heuristic (BSSF, BLSF, BAF, BL) × baseline
     area-descending order.
   - **Phase 2** — same heuristics × longest-side-descending order.
   - **Phase 3** — random shuffles of the baseline up to `restarts - 8`
     iterations.
   The best result wins by `isBetter`.

6. **Per-attempt packer** (`packOne`):
   The cabinet-builder fix here is critical — when a part doesn't fit
   on the current bin, **skip it and try the next part**. Only when no
   remaining part fits do we close the bin and open a new one. This
   matches SVGnest's placement worker and dramatically reduces sheet
   count vs the naive "close on first failure" policy.

7. **Bin packer** (cut strategy):
   - **`MaxRectsBin`** — Jukka Jylänki's maximal-rectangles algorithm.
     Each placement splits its free rect into up to 4 sub-rects, then
     prune dominated free rects.
   - **`GuillotineBin`** — each placement creates exactly TWO child free
     rects via a SAS (Shorter Axis Split). The whole layout is
     producible with edge-to-edge cuts on a track saw or panel saw.

8. **Placement → PlacedPart** — each placement is mapped back to the
   original polygon (rotated 0° or 90° to match what the packer chose)
   and shifted by the sheet's edge `margin`. PlacedPart carries the
   polygon `outer + holes` for downstream SVG / DXF / PDF rendering.

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

### DXF (R12 ASCII)
`sheetToDxf(sheet, opt)` in `src/dxf.ts` emits a tiny but valid DXF
with layers SHEET / MARGIN / PARTS / LABELS / DIMS. Opens in every CAD
tool that reads DXF.

### PDF report
`buildPdf(result, opt)` in `src/pdf.ts`. Multi-page report on the
user-selected paper size:

1. **Summary** — job name, sheet metrics, per-thickness breakdown,
   inventory check (from shopping list).
2. **Parts overview** — IKEA-style grid. Each card = letter label,
   silhouette to scale, part name, `L × W × T` dims, quantity.
3. **One page per sheet** — sheet diagram with parts overlaid + letter
   labels overlaid on each part centered on its bbox.
4. **Cut instructions** — total cut count, then per sheet:
   numbered list of rip cuts (parallel to sheet length / grain) first,
   then crosscuts; distance from reference edge (left for rips, bottom
   for crosscuts).

Shopping list rows flow into the PDF's inventory check section as
`InventoryCheck[]`.

---

## Coordinates and units

- All internal geometry is in **millimetres**.
- The UI defaults to **inches** display with fractional formatting
  (`fmtFracInches` in `src/units.ts`, 1/16" precision).
- `toMm` / `fromMm` convert at the IO boundary.
- World is **Z-up** to match STEP convention. The 3D scene, lighting,
  shadows, and grain arrows all assume Z-up.
