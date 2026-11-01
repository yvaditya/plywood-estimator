# Interactive HTML Package Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Export independent PC/tablet and phone HTML job packages with linked cut sheets, inventory, and an offline 3D assembly.

**Architecture:** A typed snapshot builder captures the existing job. An independent TypeScript runtime uses Three.js and shared unit formatting. A Vite virtual module bundles that runtime into an inline script at development/build time; the HTML adapter embeds data and styles safely.

**Tech Stack:** TypeScript, Three.js, Vite/esbuild, SVG, Node test runner, Python Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-interactive-html-package.md`

## Global constraints

- Produce `<job>_pc.html` and `<job>_phone.html`; each works independently without external resources.
- Preserve panel codes, units, cut overrides, source geometry, duplicate quantities, split provenance, and unplaced status.
- Avoid full estimator/OCCT/solver dependencies in the runtime.
- Preserve the existing uncommitted project work. Keep edits in this checkout and leave changes uncommitted for review.

## Review focus

- Script-like job names must remain inert text: serialization test and browser check.
- Multiple occurrences of a body must maintain separate checklist state: snapshot and browser tests.
- Split/unplaced parts must never disappear: mapping tests.
- Local-file storage and WebGL may be unavailable: browser fallbacks.
- A hidden phone model tab must resize correctly after selection: phone browser check.

## Task 1: Snapshot and safe document generation

Files: `app/src/packageData.ts`, `app/src/packageHtml.ts`, `tests/package.test.mjs`.

Interfaces: `buildPackageData(input: PackageInput): PackageData`; `buildPackageHtml(data: PackageData, layout: 'pc' | 'phone', runtime: string, css: string): string`.

- [x] Write and run Node tests for occurrence identity, segment-to-body mapping, unplaced rows, cut overrides, unsafe names, and stable snapshot keys.
- [x] Implement a versioned snapshot with compact typed-array model data, complete part references, sheet polygons, and cut steps. Use `allCutSteps` with the estimator's current settings.
- [x] Implement safe JSON-in-script and title escaping. Test two layout attributes and zero external resource references.
- [x] Run `node --test tests/package.test.mjs`; expect all cases to pass.

## Task 2: Standalone viewer and layouts

Files: `app/src/packageRuntime.ts`, `app/src/packageViewer.ts`, `app/src/packageStyle.css`, `app/packageRuntimePlugin.ts`, `app/vite.config.ts`, `app/src/package-runtime.d.ts`.

Interfaces: runtime reads `#package-data`; `PackageViewer` receives host, model data, and a selection callback; exposes selection, explosion, reset, isolation, and resize behavior.

- [x] Add a fixture generator and Playwright offline checks before implementing UI.
- [x] Implement the embedded viewer with original assembly geometry, per-cabinet explosion, raycast selection, orbit/pinch controls, on-demand rendering, and WebGL fallback.
- [x] Implement linked inventory tables, cut sheets/steps, cut and assembled progress, filter/search, and local-storage fallback.
- [x] Style a warm paper/ink workshop document: persistent PC split view; phone two-stage navigation; readable numeric dimensions and large controls.
- [x] Bundle the runtime as IIFE through a Vite virtual module in development and production, with no runtime external imports.
- [x] Run standalone offline browser checks at desktop, tablet, and phone sizes; verify no external requests, functional controls, and no page overflow.

## Task 3: Estimator integration and verification

Files: `app/src/main.ts`, `app/index.html`, `README.md`, `app/package.json`, `tests/package_ui.py`, `tests/package_export_ui.py`.

- [x] Add both export buttons beside PDFs and connect enable/disable guards to the existing estimate, parked-part, and correction invalidation lifecycle.
- [x] Capture model geometry from current viewer body meshes with world transforms, mapping by source body ID. Snapshot synchronously before asynchronous packaging so later edits cannot mix revisions.
- [x] Download a Blob with the selected layout; show progress and recover controls in `finally`.
- [x] Exercise real STEP import, estimate, both downloads, and reopening saved files offline. Run production build and repository tests.
- [x] Review changes for selection fidelity, script safety, resource independence, geometry correctness, and unrelated changes. Record verification and known browser limits in README.

## Execution record

- User approved the design with `continue`; proceed inline under the authorized task.
- Ruling: work in the existing checkout because its uncommitted geometry/viewer changes are part of the current app; do not reset, stash, or commit unrelated work.

- User refinement: both editions start with cutting and an inventory table, then move to assembly. Phone uses two-stage navigation and a table with a fixed identity column.
- User invoked Sites and chose local-only guidance. Nothing was registered or published.
- Task 1 complete: data and serialization tests cover quantities, split/unplaced mapping, manual overrides, source dimensions, stock-thickness snapshot consistency, and script-like names.
- Task 2 complete: desktop, tablet, portrait-phone and landscape-phone offline checks pass, including cut navigation, search, orbit, explosion, isolation, linked selection, persistence and storage/WebGL fallback.
- Task 3 complete: production build and actual STEP import/estimate/download/reopen/pick workflow pass. Repository suite: 132 tests passed.
- Independent reviewer checked data fidelity, PDF cut-measurement parity, coordinate transforms, script safety, offline bundling and mobile widths. Fixed the one important finding (live thickness override leaking into a completed estimate) with a regression test. Exact selected sheet occurrence now has a solid highlight; source-related copies use a dashed highlight.
- Existing build warnings remain for the analysis WASM Node module and large chunks. The standalone runtime is intentionally bundled and loaded only when exporting.
