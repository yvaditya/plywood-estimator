# CLAUDE.md — Notes for future Claude sessions

Quick orientation for a fresh session working on this repo.

## Repo shape
- **Top level**: only `launch.bat` / `launch.command`, `README.md`,
  `.gitignore`, `samlple step files/`, `tests/`, and the `app/` + `docs/`
  folders. Keep it that way — the user explicitly wants the root clean.
- **`app/`**: full Vite + TS app. All npm commands run from there.
  - `cd app && npm install && npm run dev`
  - Vite serves at `http://localhost:5173` (or next free port).
- **`docs/`**: ARCHITECTURE.md (data pipeline), this file.
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
| `instructions.ts` | A/B/C letter labels + cut step generation (margin-trim cuts emitted as first 4 steps when `margin > 0`) |
| `shoppingList.ts` | Buy/have rollup + CSV export, localStorage persistence |
| `dxf.ts` | DXF R12 writer (layers SHEET / MARGIN / PARTS / LABELS / DIMS) |
| `pdf.ts` | jsPDF report (cover → shopping → parts grouped by cabinet → per-sheet (overview + cut sequence) → per-cabinet (assembled + parts table) → IKEA-style step pages → final 'Assembled' frame) |
| `units.ts` | mm/inch conversion, fractional-inch formatting, money fmt |
| `style.css` | Notion-style light theme |

## Cut strategies (`packRect.CutStrategy`)
- **`free`** — MaxRects, max yield (any cuts).
- **`guillotine`** — Shelf packer (FFDH). Min cuts; track-saw friendly.
  Free-grain parts auto-unlock rotation under this strategy (the per-body
  `rotation='lock'` default would otherwise block shelf optimisation).
- **`save-last`** — MaxRects everywhere except the last sheet, which is
  re-packed Bottom-Left so parts cluster in one corner and the remnant is
  a clean usable rectangle.
- **`cnc`** / **`cnc-save-last`** — true-shape any-angle nesting handled
  by `cncNest.ts`, NOT this rectangle packer. `nest.ts` dispatches both via
  `isCncStrategy()` before the rectangle path. `cnc-save-last` adds the
  save-last behaviour to the raster nester: the pass objective
  (`passBetter`, `saveLast` flag) tie-breaks equal-sheet layouts toward the
  emptiest least-filled sheet, and a final `compactLastSheet` re-packs that
  sheet's parts bottom-left so the remnant is one clean offcut.

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
- **Original STEP bytes are retained** in `state.sourceFiles` (keyed by
  `fileTag`) so the **Download STEP** button beside the unplaced count can
  re-download the source file(s) the unplaced parts came from (single file →
  direct download; multiple → zipped via `fflate`). Cleared in `clearAll()`.
  We download the whole source file, not a per-part extract — there is no
  STEP writer; the per-body `OcctMesh` isn't retained either.
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
- `python tests/visual_check.py [filter]` → end-to-end Playwright run
  against every sample STEP, generates PDFs + per-page PNGs in
  `tests/_output/<sample>/`. The default cut strategy is Min cuts.
  Each sample takes 30–80s.

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
