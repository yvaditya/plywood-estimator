# CLAUDE.md — Notes for future Claude sessions

Quick orientation for a fresh session working on this repo.

## Repo shape
- **Top level**: only `launch.bat` / `launch.command`, `README.md`,
  `.gitignore`, `samlple step files/`, `tests/`, and the `app/` + `docs/`
  folders. Keep it that way — the user explicitly wants the root clean.
- **`app/`**: full Vite + TS app. All npm commands run from there.
  - `cd app && npm install && npm run dev`
  - Vite serves at `http://localhost:5173` (or next free port).
- **`docs/`**: ARCHITECTURE.md (data pipeline, function-by-function),
  WHITEPAPER.md (user-facing explainer with Mermaid diagrams + `img/`
  screenshots — keep it in sync when behaviour changes), this file.
- **`tests/`**: `visual_check.py` end-to-end Playwright pipeline + the
  gitignored `_output/` landing pad it writes to.

## Tech stack
- Vite + TypeScript, **no React** (vanilla DOM via `document.createElement`).
- Three.js r169 for the 3D viewer.
- OpenCascade WASM (`occt-import-js`) for STEP parsing.
- jsPDF for PDF export.
- Pure-TS DXF R12 writer.

## Major modules (in `app/src/`)
| File | Responsibility |
|---|---|
| `main.ts` | UI wiring, file drop, state, all `addEventListener`s, async nest button + replay button + convergence chart |
| `stepLoader.ts` | OCCT WASM init + STEP parse |
| `geometry.ts` | Body analysis: AABB → thickness + outline polygon + face vectors. Returns null for non-sheet shapes |
| `viewer.ts` | Three.js viewer, post chain, grain arrows, non-sheet ghost group, `snapshotFiltered(visibleIds, dirs, dist, frameIds?, target?)` for PDF snapshots |
| `nest.ts` | Per-thickness bucketing wrapper. Has `runNest` (sync) + `runNestAnimated` (async, observable, used by the UI) |
| `packRect.ts` | `MaxRectsBin` + `ShelfBin` + (legacy) `GuillotineBin` packers. Exports `packMulti` (sync) + `packMultiAnimated` (async with `onProgress`) |
| `instructions.ts` | A/B/C letter labels + cut step generation (THREE reference trims first when `margin > 0`; tree cuts coinciding with a trim line are deduped; panel-size grouping for the PDF tables) |
| `splitParts.ts` | CNC auto-split: parts too big for the sheet are split into dovetail-jointed segments (polygon booleans via polygon-clipping). Tail count scales with joint length; tail depth with thickness, capped at tail width |
| `shoppingList.ts` | Buy/have rollup + CSV export, localStorage persistence |
| `dxf.ts` | DXF R12 writer (layers SHEET / MARGIN / PARTS / LABELS / DIMS) |
| `pdf.ts` | jsPDF report (cover → contents → quick ref → shopping → job-wide Panels TABLE → per-sheet (overview + panels table + cut sequence) → per-cabinet assembly + IKEA-style step pages) |
| `cae.ts` | CAE: material cards (each carries `fbAlong`/`fbAcross` bending strengths for utilization %), panel weight, sag screening, orthotropic Mindlin plate FEM + ASSEMBLY flat-shell solver (membrane+bending, 6 DOF/node, penalty joints rigid/semi-rigid/hinged, floor grounding, Jacobi-PCG — 348 iters @ 58k DOF on the workbench). After the solve it does STRESS RECOVERY per element (membrane N + bending M at the centre → surface σ=N/t±6M/t² → per-face von Mises → nodal average), returning per-panel `vm` field + global `maxVm`/`maxVmPanelId`/`maxVmAt` + `utilPct` (peak grain-axis bending σ vs the card's fbAlong/fbAcross) + `stressVerdict` (<50% ok, <100% borderline, ≥100% weak). tests/cae_check.ts has SEVEN validation cases — keep all passing (case (g) checks recovered SS-strip surface stress; it uses a SHORT/THICK strip on hinged legs so the soft-grounding regularization — which perturbs absolute deflection for slender panels — doesn't steal the end reactions; centre moment stays P·L/4). Per-panel INTERACTIVE CAE was removed (user: useless); the ONLY CAE surface is the Analysis sidebar MODE (segmented Cut planning / Analysis switch under the brand header, green dot when solved; joints list + presets + patch loads + a Deflection/Stress heatmap field toggle that re-textures from the cached solve — no re-solve). Result line reports both deflection AND max stress (MPa) + util%, verdict = worst of the two. Structure table + Assembly PDF page (now with stress numbers + a second von-Mises heatmap under the deflection one) gate on an assembly solve |
| `cutEditor.ts` | "Edit cuts" popup: DIRECT cutting (click candidate line → commit). Clicking a piece EDGE opens a context popup: arm as measured-from, or set/unset a DATUM edge. Datum edges render blue, become the piece's default measuring edge (fromFar when far), and PROPAGATE to child pieces that retain the same boundary segment (datums stored as geometric line segments; persisted as `SheetOverrides.datumEdges` piece-key+side). manual_cut log records measuredFrom + provenance (armed/datum/default). Overrides keyed by layoutSignature + cutKeyFor in localStorage |
| `trainingLog.ts` | Opt-in JSONL recorder of manual sequence edits (full layout + auto sequence context per session) — source data for future learned ordering modes |
| `units.ts` | mm/inch conversion, fractional-inch formatting, money fmt, fmtSag (decimal, sub-mm safe) |
| `style.css` | Notion-style light theme |

## Cut strategies (`packRect.CutStrategy`)
Five strategies (user trimmed the list 2026-07 — `cnc-save-last` removed):
- **`free`** — MaxRects, max yield (any cuts).
- **`guillotine`** — min cuts; trials sweep shelf / shelf-v / SAS bins.
  Free-grain parts auto-unlock rotation under guillotine strategies (the
  per-body `rotation='lock'` default would otherwise block shelf
  optimisation).
- **`guillotine-exact`** — same objective + `packBeam` beam search over
  cut trees; slower, often beats the greedy pass.
- **`save-last`** — MaxRects everywhere except the last sheet, which is
  re-packed Bottom-Left so parts cluster in one corner and the remnant is
  a clean usable rectangle.
- **`cnc`** — true-shape any-angle nesting handled by `cncNest.ts`, NOT
  this rectangle packer; `nest.ts` dispatches via `isCncStrategy()`. (The
  engine's `saveLast` machinery still exists but no strategy sets it.)

The multi-restart optimiser objective is strategy-aware (`isBetter` in
`packRect.ts`):
- `free` → maximise total used area
- `guillotine` → minimise total cut count
- `save-last` → minimise last-sheet fill
Every strategy still tie-breaks first on (fewer unplaced → fewer sheets).

## Sheet orientation
**Locked landscape**. `nest.ts` only runs `packMulti` with `binW = usableL`
(long edge along the bin's X axis). The portrait try was removed at user
request so the sheet has a consistent orientation across the on-screen
preview, the PDF overview, the cut-sequence cards, the SVG, and the DXF.

## Parallel-guide cut sequence (user's workflow — don't regress)
The user cuts with a track saw + TSO-style parallel guide. Setup cost is
per distinct flip-stop SETTING and per rip↔cross ROTATION, not per cut.
Everything below lives in `packRect.ts` / `instructions.ts` / `pdf.ts`:
- `deriveGuillotineCuts` builds the tree explicitly, then a greedy
  scheduler emits cuts: same axis+distance ≻ same axis ≻ child-of-prev ≻
  larger parent. Readiness (parent piece exists) is the hard constraint
  the PDF diagrams rely on.
- `betterLine` priorities: reusable empty offcut strip first (both dims ≥
  `REUSABLE_MM` 200, bigger wins) → shave a thin FINISHED strip off big
  stock (`thinShave`) → separates → !thinBad → balance → pieceMin → dist.
- `thinStripsTop` (applied before every cut derivation): mirrors the
  layout vertically if thin strips sit below wide parts, then anchors the
  layout flush to the reference corner (bin origin = display top-left).
- THREE reference trims (`cutStepsForSheet`): both long edges + datum
  short edge, datum top-left. The FAR long trim lands at the last part's
  edge + kerf/2 — frees the leftover AND squares the edge; tree cuts on
  the same line are deduped (fewer total cuts). Last trim matches the
  first layout cut's direction. Both step functions take a `kerf` param.
- `CutStep.sameSetting` → "· same setting" caption. PDF `quotedDistance`:
  with the `#parallelGuide` toggle (default ON) layout cuts quote the
  KEEPER width (distance − kerf = the flip-stop number = finished part
  dim); trims quote the strip width coming off.
- Diagram colors: GREEN = edge measured from (left for vertical cuts,
  top for horizontal; captions "from L/T edge"), BLUE = reference edges
  (drawn above the fade), RED = active cut + parent border, white =
  prior cuts. Sheet cream stays the only brown.

## Async / animated optimiser
`runNestAnimated` ⇒ `packMultiAnimated` is what the **Estimate** button
calls. The optimiser yields back to the browser every 4 trials via
`setTimeout(0)`. Each trial fires an `onProgress({ i, total, current,
best, isNewBest })` callback, which `main.ts` uses to:
- update the granular progress counter on the button
- push the trial's layout + metrics into `state.lastTrialFrames` /
  `state.lastTrialMetrics`
- NOT paint live during the run — the user gets the FINAL state snapped
  in instantly when the run finishes.

After the run:
- The **▶ replay button** (icon-only ghost beside DXF/PDF) animates the
  captured frames at 25 fps (`1000/25 = 40 ms/frame`). Click again to
  stop; on completion the final state is restored via `renderResults()`.
- The **convergence chart** (`#convergenceChart`) renders an SVG with
  3 lines: yield (green), sheets (blue dashed), cuts (red dashed)
  running-best vs trial index. Built by `renderConvergenceChart()`.

## Cut layout pane (`#detailSvg`)
Replaced the single-detail view with a **vertical stack** of every sheet
in the result. One `section.sheet-entry` per sheet:
- title `Sheet N` (clickable — adds `.active`, accent outline)
- meta line: thickness · parts · fill % · `W × L`
- SVG (the sheet rect is the ONLY brown — `.sheet-border { fill: #6B4F31; stroke: none }`. Rest of the SVG canvas is transparent.)

There is **no sidebar sheet thumbnail strip** anymore — the stacked view
replaces it.

## Body list (sidebar)
Bodies group under collapsible **STEP-file headers** (chevron + tri-state
`<input type=checkbox>` per file + count subtitle). New files start
**collapsed**. Per-body details (qty / grain / rotation) sit inline only
when the body is selected. `state.collapsedFiles: Set<string>` persists
the expand state across renders.

## Conventions
- **All geometry in mm internally.** Convert at the IO boundary
  (`toMm` / `fromMm` / `fmtDim` in `units.ts`).
- **World is Z-up** (STEP convention). The 3D scene, lighting, shadows,
  grain arrows all assume this.
- **Imperial display defaults**: 48"×96" sheet, 1/4" margin, 1/8" kerf,
  fractional inches at 1/16" precision.
- **Per-body IDs are globally unique** (`nextBodyId` counter in
  `main.ts`). Multi-file imports rely on this so collisions don't occur.
- **Unplaced parts export as a generated STEP**, not the source file. The
  **Download STEP** button beside the unplaced count calls `buildStep()`
  (`stepExport.ts`), which writes one extruded-prism `MANIFOLD_SOLID_BREP`
  per unplaced INSTANCE from its footprint outline (`analysis.outline`) +
  `thickness`, spread along X. So the file contains ONLY the parts that
  didn't nest. The outline is the auto-oriented footprint (rotated from the
  original), which is fine for re-cutting a flat panel. Validated by
  round-tripping through occt-import-js (OpenCascade reads it; dims exact;
  holes preserved). AP214 boilerplate is hand-rolled — keep it valid.
- **Per-sheet `sheetW`/`sheetL`** is the source of truth for cut-sheet
  rendering; don't pull from `state.lastSheet.w/l` which is the original
  config and can mislead.
- **jsPDF rotated text quirk**: with `angle: 90`, the character body
  extends LEFT of the baseline anchor. To centre rotated text ON a
  vertical line, offset `x` by `+fontSize * 0.34` (NOT minus). Bit me
  once already.

## Build / test
- `npx tsc --noEmit` from `app/` → must be clean before committing.
- `npx vite build` from `app/` → production build to `app/dist/`.
- `python tests/visual_check.py [filter] [--snap]` → end-to-end
  Playwright run against every sample STEP, generates PDFs + per-page
  PNGs in `tests/_output/<sample>/`. The default cut strategy is Min
  cuts; `--snap` selects the "snap to nearest standard" thickness
  override before estimating. Each sample takes 30–80s. The
  "Start cabinets" sample is occasionally flaky at STEP-load — re-run
  with a filter if it fails with a disabled-button screenshot.

## Visual / file-output testing
- The Playwright MCP plugin is the live-control tool. Use it for grain /
  UI bugs you need to repro.
- The `tests/visual_check.py` pipeline boots its own vite on a free port,
  doesn't conflict with `npm run dev`.
- Animated estimate at 256 trials × ~5ms ≈ 1.3 s of work, plus yields
  every 4 trials. With the 3-file sample (15 sheet bodies) it's ~80–90 s
  end-to-end in headless Chromium because each trial's layout build is
  meatier.

## Known sharp edges
- **Non-sheet bodies** (round legs, blocks, etc.) are filtered in
  `analyzeBody`. They render in 3D in a separate `nonSheetGroup` and
  `snapshotFiltered` toggles that group off before each PDF snapshot.
- **Thickness bucket = 0.5 mm**. Tighter values split float-noise copies
  of the same panel into separate sheet stacks. Don't tighten.
- **Thickness comes from the OBB when a panel is tilted**. The world-axis
  AABB over-reports thickness for a leaning panel (a 1/2" panel tilted ~2°
  reads ~7/8" and lands on its own sheet). `analyzeBody` always computes
  the PCA-OBB and prefers its thin extent when meaningfully thinner
  (`obbThin < worldThickness * 0.9`). Axis-aligned panels are untouched
  (`obbThin === worldThickness`). Don't revert to a world-only reading.
- **`packOne` skip-on-fail** in `packRect.ts` is critical: when a part
  doesn't fit on the current bin, **skip and try the next part**, not
  close the bin. Reverting that policy doubles sheet counts.
- **Snapshot resolution is decoupled from window size**. Cover snapshots
  use `{w:1200, h:1100}`, IKEA step snapshots use `{w:1600, h:900}` — set
  in `main.ts` and passed through `snapshotFiltered`'s `target` param.
- **Replay button vs busy class**. Detect "replay running" via
  `replayBtn.classList.contains('busy')`. Don't fire a second click while
  busy — the handler interprets that as a stop request.
- **DXF is STRICT R12 only** (`dxf.ts`). No LWPOLYLINE (R14 entity — use
  POLYLINE/VERTEX/SEQEND), no post-R12 header vars, and `footer()` must NOT
  emit ENDSEC (the caller closes ENTITIES; a doubled ENDSEC made several
  waterjet CAM importers reject the file). Validate changes with ezdxf's
  strict `readfile`, not just `recover`.
- **Wheel pan/zoom classification is sticky per gesture stream**
  (`viewer.handleWheelPan`). Events within 400 ms keep the stream's verdict;
  re-classifying per event made Windows smooth-scroll wheels (sub-50px
  deltas mid-spin) leak into the pan path and nudge the model. Don't judge
  individual events.
- **CNC auto-split** (`splitOversize` checkbox, CNC strategies only) runs in
  `main.ts` BEFORE `runNestAnimated`, using bin = (sheetL−2m, sheetW−2m).
  Segment ids are `<bodyId>.s<n>` and don't resolve to a body —
  `state.splitSegmentGeo` carries their geometry for the unplaced STEP
  export. Joints shorter than 24 mm get a straight cut, not a dovetail.
- **Sheet consolidation passes**: both packers try to dissolve the
  least-filled sheet into the others' free space after the restart search
  (`consolidateSheets` in packRect.ts — MaxRects strategies only, never
  'guillotine'; widened `consolidate` in cncNest.ts). Removing them
  silently costs whole sheets on some jobs.
- **Curve fidelity is set ONLY in `stepLoader.ts`** (occt exposes triangles,
  never the BREP's true splines): `absolute_value` 0.1 mm linear deflection +
  0.2 rad angular. Don't revert to `bounding_box_ratio` — it scaled chord
  error with model size (2.5 mm sag on a 2.5 m cabinet, visibly faceted
  circles).
- **CNC PDF**: `PdfOptions.cnc` suppresses the panel-saw cut-sequence pages
  AND the parts-overview grid (a router follows contours — without the flag
  the EMPTY cnc cut tree hits the legacy full-sheet-line fallback and prints
  fictional cuts). Split parts get a "Join split parts" section
  (`drawSplitJoins`, fed by `buildSplitJoins()` in main.ts); split segments'
  panel labels carry roman suffixes ('1a-i') added in `annotatePlacedParts`.
- **Optimiser is multicore** (`optPool.ts` + `optWorker.ts`): rect trials and
  CNC raster passes fan out across a Web Worker pool; the sequential drivers
  in packRect/cncNest are the deterministic fallback (auto-used when Workers
  are missing or error). Worker pool layouts can differ run-to-run on
  objective ties (arrival order). The pool passes a FINER CNC grid
  (targetCells 450) than the single-core default (300) — pass and finish
  messages must always share the same `opt` or masks/grids disagree.
- **CNC attempt budget** (`cncAttemptCount`): caps are sized for the worker
  pool (96/48/24/10 by part count), bounded by n!·2 distinct orderings for
  small jobs, plus per-worker and per-generator wall-clock budgets.
- **Dovetail cuts avoid notches**: `splitParts.ts` probes candidate cut
  positions around the even split and scores material coverage over the
  whole joint zone (cut line + tail depth, area-based); a cut through a
  notch/hole loses to a nearby full-material position. Don't score by
  bbox extent — L-shaped islands read as full material.
- **CNC placement scan is heavily optimised** (`cncNest.ts`) — a 50-instance
  dense-outline bench went 22.9s → 1.3s (17×). Three invariants keep it
  correct; break any and you get overlaps or missed placements:
  1. `SheetGrid.cursors` assume MONOTONIC occupancy (cells are marked, never
     cleared). If you ever add cell clearing, cursors must be invalidated.
  2. Mask cell lists are boundary-first for fail-fast — orderings may change,
     but the set must stay the full solid.
  3. Masks raster from `simplifyRing`-reduced rings (tol ≤ min(0.5, res/6));
     placements/exports keep the EXACT rings carried on the Mask. Don't put
     simplified rings into `Mask.outer/holes`.
  GPU (WebGPU) was evaluated and rejected: each placement mutates the grid,
  so per-placement GPU readback latency eats the parallel gain; cross-pass
  parallelism is already covered by the worker pool.
- **CNC densification** (cncNest.ts): every ordering runs under BOTH
  placement policies — bottom-left-fill AND touching-perimeter ('contact':
  pick among ~5 frontier candidates by mask-fringe contact with stock/
  edges). The post-search `finalSqueeze` alternates per-sheet shake
  (re-pack each sheet's own parts toward the origin) with consolidation —
  this combination is what dissolves under-filled sheets (bench: a job
  stuck at 3 sheets through every earlier change packs in 2). Don't strip
  either policy or the shake.
- **"Optimize further" button** (`#optimizeMoreBtn`, main.ts): re-runs the
  estimate with `deepSearch` + an incrementing `seed`, keeps the new layout
  ONLY if it beats the current one (unplaced → sheets → yield), else
  restores and says so. CNC deepSearch routes to `packCncDeep` (optPool.ts)
  — a Deepnest-style genetic algorithm: genome = placement order + scan
  direction + placement policy, order-crossover + adjacent-swap mutation,
  generations evaluated in parallel via 'cnc-orders' worker jobs. Saw
  strategies get doubled restarts + a fresh shuffle stream (seedOffset in
  buildTrialSchedule). Every click mines a different seed.

## Cut-editor legality gotcha
Layout-cut parents live in the USABLE frame (both margins removed), but the
trims never cut the FAR short edge — replaying trims over the raw sheet
leaves regions one margin too wide. `seedRegions` in cutEditor.ts shaves
that margin after the trims; without it every reorder reads illegal.

## Sidebar
Workflow-ordered tinted groups (Import → Stock → Cutting → Parts → Job &
export → Shopping), full-bleed ~97%-lightness tints per group, flat chrome.
Kerf is a select (1.8 mm default / 2.5 mm / custom); margin default 0.5";
`#kerfRef` (keeper / center / spacing) drives quotedDistance + far-trim
placement; `#material` (CAE material cards) sits in Stock.

## UI rules from the user (don't violate without asking)
- Notion-style **light theme** for the chrome; 3D viewer is intentionally
  a dark stage; the Cut layout is now flat / minimal (no card chrome).
- **Parts** in the cut sheet use **per-body colors** that match the 3D
  viewer 1:1.
- **Sheet rect**: brown fill (`#6B4F31`), no border. The SVG canvas
  around it stays transparent — the brown stops at the sheet edge.
- **No fake assembly steps**. IKEA-style snapshots are derived from the
  STEP-file body order; the explode direction is
  `(bodyCenter − cabinetCenter).normalize()` (NOT face normal — face
  normals can point INTO other panels). Each snapshot drops a
  semi-transparent ghost at the panel's rest position so the user sees
  where it lands.
- **Parts are not moved in the 3D view.** Auto-flatten was reverted at
  user request; bodies display in their original STEP orientation.
- **Animation cadence**: 25 fps. Don't change without asking.
- **Two-finger trackpad pan**: handled in `viewer.handleWheelPan`. The
  sign convention is "scroll the scene like a document" (opposite of
  drag-the-scene). Don't flip it.

## Useful invariants
- Every `id` referenced from `main.ts` must exist in `index.html`. If
  you rename an HTML id, search `main.ts` for it first.
- Every CSS class used by JS is used by JS — don't strip selectors
  without grepping `main.ts` for `class=` / `classList`.
- `paintTrialPreview` (in `main.ts`) is the lightweight repaint used
  during replay. It builds an SVG per frame using `buildSheetSvg`.
- `renderResults()` is the full repaint that draws every sheet stacked
  with click handlers and convergence-chart refresh. Call it after any
  state mutation that changes the layout.

## Open follow-ups / ideas not yet built
- Memory cap on `state.lastTrialFrames` for very large jobs (256 trials
  × dozens of parts × many sheets could grow). Consider keeping only
  every Nth frame when total parts × sheets exceeds some budget.
- Live-paint mode during Estimate (under a toggle). Currently the user
  gets the final state instantly and replays on demand; some users may
  prefer to watch the optimiser work in real time.
- Animated optimiser doesn't currently know it's an animated session —
  could short-circuit the SAS guillotine retry for the same strategy.
- Per-panel dim leader-line callouts FIRE when there's space below /
  right of the panel but the inline path is taken whenever it fits. A
  smarter selection might prefer the leader for very small panels even
  when the inline JUST fits.
