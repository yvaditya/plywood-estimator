# CLAUDE.md — Notes for future Claude sessions

Quick orientation for a fresh session working on this repo.

## Repo shape
- **Top level**: only `launch.bat` / `launch.command`, `README.md`,
  `.gitignore`, and the `app/` + `docs/` folders. Keep it that way —
  the user explicitly wants the root clean.
- **`app/`**: full Vite + TS app. All npm commands run from there.
  - `cd app && npm install && npm run dev`
  - Vite serves at `http://localhost:5173`.
- **`docs/`**: ARCHITECTURE.md (data pipeline), this file.

## Tech stack
- Vite + TypeScript, **no React** (vanilla DOM via `document.createElement`).
- Three.js r169 for the 3D viewer.
- OpenCascade WASM (`occt-import-js`) for STEP parsing.
- jsPDF for PDF export.
- Pure-TS DXF R12 writer.

## Major modules (in `app/src/`)
| File | Responsibility |
|---|---|
| `main.ts` | UI wiring, file drop, state, all `addEventListener`s |
| `stepLoader.ts` | OCCT WASM init + STEP parse |
| `geometry.ts` | Body analysis: AABB → thickness + outline polygon + face vectors. Returns null for non-sheet shapes |
| `viewer.ts` | Three.js viewer, post chain, grain arrows, non-sheet ghost meshes |
| `nest.ts` | Per-thickness bucketing, multi-restart wrapper, grain → orientation policy |
| `packRect.ts` | `MaxRectsBin` + `GuillotineBin` packers (Jukka Jylänki) |
| `instructions.ts` | A/B/C letter labels + cut step generation |
| `shoppingList.ts` | Buy/have rollup + CSV export, localStorage persistence |
| `dxf.ts` | DXF R12 writer (layers SHEET / MARGIN / PARTS / LABELS / DIMS) |
| `pdf.ts` | jsPDF report (summary → parts overview → per-sheet → cut instructions) |
| `units.ts` | mm/inch conversion, fractional-inch formatting, money fmt |
| `style.css` | Notion-style light theme |

## Conventions
- **All geometry in mm internally.** Convert at the IO boundary
  (`toMm` / `fromMm` / `fmtDim` in `units.ts`).
- **World is Z-up** (STEP convention). The 3D scene, lighting, shadows,
  grain arrows all assume this.
- **Imperial display defaults**: 48"×96" sheet, 1/4" margin, 1/8" kerf,
  fractional inches at 1/16" precision.
- **Per-body IDs are globally unique** (`nextBodyId` counter in
  `main.ts`). Multi-file imports rely on this so collisions don't occur.
- **Per-sheet `sheetW`/`sheetL`** is the source of truth for cut-sheet
  rendering (auto-orient may pick portrait or landscape per thickness
  group); don't pull from `state.lastSheet.w/l` which is the original
  config and can mislead.

## Build / test
- `npx tsc --noEmit` from `app/` → must be clean before committing.
- `npx vite build` from `app/` → production build to `app/dist/`.
- Manual smoke test path: drop the test STEP at
  `C:\Users\yerra\AppData\Local\Temp\dishwasher_cabinet.stp`, select
  all, click **Estimate**. Should pack to 1 sheet, 59.2 % fill.

## Known sharp edges
- **Non-sheet bodies** (round legs, blocks, etc.) are filtered in
  `analyzeBody`. They still render in 3D as red dashed via
  `viewer.addNonSheetMesh()` but never enter the cut list. If you change
  the sheet-good thresholds (`SHEET_THICKNESS_MIN_MM` /
  `SHEET_THICKNESS_MAX_MM` in `geometry.ts`), check this still feels
  right.
- **Thickness bucket = 0.5 mm**. Tighter values split float-noise copies
  of the same panel into separate sheet stacks. Don't tighten without a
  good reason.
- **`packOne` skip-on-fail** (in `packRect.ts`) is critical: when a
  part doesn't fit on the current bin, **skip and try the next part**,
  not close the bin. Reverting that policy doubles sheet counts.

## UI rules from the user (don't violate without asking)
- Notion-style **light theme** for the chrome; 3D viewer + cut-sheet
  preview workspace are intentionally **dark stages** (like Notion code
  blocks).
- **Parts** in the cut sheet use **per-body colors** that match the 3D
  viewer 1:1 — the user explicitly wants this mapping.
- **Sheet** in the preview is dark plywood (#6B4F31).
- **No fake assembly steps in the PDF** — IKEA-style assembly diagrams
  need joint metadata that isn't in a STEP file. Stick to cut
  instructions + parts overview.
- **Parts are not moved in the 3D view.** Auto-flatten was reverted at
  user request; bodies display in their original STEP orientation.

## Useful invariants
- Every `id` referenced from `main.ts` must exist in `index.html`. If
  you rename an HTML id, search `main.ts` for it first.
- Every CSS `class` used by JS is also used by JS — don't strip
  selectors without grepping `main.ts` for `class=` / `classList`.
