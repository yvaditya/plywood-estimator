# Thickness correction implementation plan

Spec: `docs/thickness-correction-design.md`.
User approved the design and explicitly requested autonomous implementation.

## Constraints and decisions

- Continue in the shared workspace and preserve all existing optimizer changes.
- Initial implementation needed no publishing. The user subsequently requested a UI cleanup and Git push. No dependency installation or source STEP changes are needed.
- Work in millimetres. Retain double precision source meshes independently of Three.js buffers.
- Fail with a review report on unsupported solids or impossible constraints. Reference surfaces are explicitly excluded from panel-solid export.
- Use exact face-displacement constraints and independent post-validation; preserve original small contact gaps.
- Correction API: `correctThickness(inputs: CorrectionInput[], options: CorrectionOptions): CorrectionProposal`. Each input has stable `id`, `name`, and `mesh: OcctMesh`; options have `sourceThickness`, `targetThickness`, and optional `tolerance`. Proposal includes `ok`, `issues`, `contacts`, `changes`, `panels`, and validation metrics. Each corrected panel retains its input id and returns `before`, `after` bounds, corrected mesh, thickness axis and source geometry.
- STEP API: `buildAssemblyStep(parts: PlacedStepPart[], isoDate: string, name?: string): string`. `PlacedStepPart` extends existing `StepPart` with `origin`, `uAxis`, `vAxis`, `normal` world vectors; the extrusion starts at origin and extends along normal. Existing `buildStep` stays compatible.

## Tasks

- [x] Geometry solver and tests. First add failing tests for a 19.05→18 mm outer frame (rail +2.10 mm), top support (+1.05 mm), source immutability, mixed thickness, near-contact rejection, invalid thickness, closed-prism validation, and L-shaped outside references. Run `node --test tests/thickness.test.mjs` red; implement contact graph, perimeter anchors, constraint solve, mesh remapping and independent validation; run green.
- [x] STEP assembly export and round-trip tests (independent work). Test world placement in three orientations, holes, translated models, and unchanged legacy export using actual OCCT re-import. Extend `stepExport.ts`; run `node --test tests/stepExport.test.mjs`.
- [x] Actual STEP benchmark. Run the solver on all meshes of FULL TOE KICK.stp, report excluded surfaces, before/after dimensions, contact residual and exterior mismatch, export corrected STEP into `tests/_output`, and re-import to verify it independently. Resolve any genuine solver conflicts before UI integration.
- [x] Integration. Add a focused correction UI module and controls with cabinet/thickness selection, analysis, per-board report, geometry preview, apply, reset and download. Preserve immutable source meshes; update viewer and body analysis together; clear incompatible thickness override and stale cut/CAE results. Block mutation during active nesting/import/analysis.
- [x] Browser and regression verification. Run `npm test`, TypeScript/Vite build and a Playwright flow covering import, preview without cut-list mutation, apply 18 mm, nesting, corrected STEP download, repeated correction from baseline, reset and unsupported input. Review independently, fix concrete findings, update README/spec status and attach benchmark artifacts.

## Review focus

- Protect the concave outline, not merely the assembly bounding box.
- Do not accidentally accept a pocketed, open, or overlapped mesh as a solid rectangular prism.
- Preserve file origin when the app shifts models for display; do not join separate source files.
- Applying twice must not double the dimensional allowance or leave stale exports/results.
- Unsupported/reference geometry must be disclosed; do not lose supported unchanged boards in export.

## Progress ledger

- Implemented the solver, immutable baseline integration, reversible preview, apply/reset, corrected STEP export, and focused UI. Existing optimizer changes are preserved.
- Independent review found and resolved recessed exterior anchors, reference planes influencing the assembly frame, and previews omitting unchanged proposal panels. Regression fixtures cover those cases; the final review reported no remaining concrete findings.
- Geometry, optimizer, and real OCCT STEP round-trip tests: 46 passed. TypeScript and Vite production build passed. Existing bundler chunk-size and WASM externalization notices remain.
- FULL TOE KICK benchmark: 42 panels corrected from 19.05 to 18 mm; all 126 contacts preserved; zero joint-gap error, perimeter error, or collisions. Two zero-thickness reference surfaces are disclosed and excluded from the panel-solid export. Exported CAD re-imports successfully with verified dimensions, joint contacts, exterior references, and placement.
- Corrected panels still nest on two 48 x 96 inch sheets in Repeated long rips mode, with no unplaced panels. Artifacts: `tests/_output/FULL TOE KICK-18mm.step` and `tests/_output/thickness_bench_summary.json`.
- First version supports closed rectangular boards in a shared orthogonal frame. Unsupported shaped joinery, contradictory exterior anchors, and existing overlaps block application with a review report. Original STEP and feature history are not edited.
- Final production browser verification passed: import, analyse, non-mutating preview, apply, 18 mm nesting, applied-state STEP download, repeat apply without accumulated allowances, reset, invalid target, duplicate filenames, isolated cabinet correction, clear, and zero browser errors. Both downloaded STEP files independently re-import to 42 panels at 18 mm with zero coordinate drift against the validated benchmark export. Browser artifacts are under `tests/_output/thickness_ui/`.
- git diff --check passed. No source STEP modification, commit, or publishing was performed.

## Workspace UI follow-up (2026-10-06)

- User requested a dedicated Thickness workspace like Analysis, a cleaner interface guided by Dieter Rams, an old/new size table, and a Git push.
- Replaced the sidebar accordion with stock controls, a large shared assembly viewer, and a scrollable correction report with fixed actions. Added a searchable semantic table, expandable per-board explanations, clear preview status, responsive layouts, and keyboard workspace navigation. Temporary previews end on workspace changes without losing the proposal.
- Simplified shared sidebar headings, colours, navigation, and focus states. No geometry solver or export algorithm changes in this UI follow-up.
- Full toe-kick browser workflow passed, including table filtering, responsive fixed actions, preview cleanup on workspace changes, apply, nesting, export, reset, duplicate imports, isolated cabinet edits, and persisted workspace selection. Production checks also verified old/new table values, expandable reasons, keyboard navigation, and layouts at 900, 1280, and 1600 pixels with no browser errors.
- Independent review reproduced an active structural solve repainting over Thickness. Entry is now disabled until shared model operations and captures finish; keyboard navigation skips the unavailable tab. The reviewer verified the real solve/capture sequence, result preservation, and graphics restoration, with no remaining findings.
- Final TypeScript/Vite build, all 46 regression tests, and whitespace checks passed before preparing the user-requested Git update.
