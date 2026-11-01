# Interactive HTML job packages

## Purpose

Export a woodworking job as two independent single-file HTML artifacts: one optimized for PCs/tablets and one for phones. Each contains the cut list, part inventory, sheet layouts, and a rotatable CAD assembly with linked part selection. Recipients can consult the job without running the estimator.

## Output and entry points

Add `PC / tablet HTML` and `Phone HTML` download buttons alongside existing cut-planning exports. Produce `<job>_pc.html` and `<job>_phone.html`. Each button downloads its own file, avoiding browser restrictions on multiple automatic downloads. Both contain the same job snapshot and work offline with all scripts, styles, model geometry, and data embedded. No CDN, local server, STEP parser, or external assets are required by the exported files.

Use the last completed estimate, current units, job name, current model geometry, and saved cut-sequence overrides. Follow existing export guards for parked parts. Include unplaced parts explicitly with an `Unplaced` status; never silently omit them. Export generation shows progress, prevents conflicting exports, restores controls after failure, and explains failures.

## PC and tablet layout

Open on Step 1, **Cut & check**, with sheet layouts and cutting steps beside an inventory table. Step 2, **Assemble**, replaces the cutting panel with a large 3D viewer beside that inventory and selected-part details. On narrower tablets, panels stack without horizontal page overflow. Support mouse orbit, wheel zoom, touch orbit/pinch, and visible reset-view controls.

## Phone layout

Use a compact header and sticky two-stage navigation: **Cut & check** then **Assemble**, following the user's workshop sequence. In Step 1, switch between cut sheets and the inventory table. Keep the part identity column visible while horizontally scrolling the table. In Step 2, lead with the 3D model, followed by selected-part details and the inventory. Use large touch targets, portrait/landscape support, drag orbit and pinch zoom, zoomable sheet diagrams, safe-area spacing, and capped rendering pixel ratio.

## Shared interactions

- Clicking/tapping a model body, inventory item, or sheet part selects the same source part across all sections. Highlight the corresponding geometry and all relevant sheet occurrences, distinguishing the selected occurrence from related copies; retain existing panel codes such as `1a`.
- Details show name, panel codes, dimensions, thickness, quantity, cabinet/source file, and sheet location. Selection offers `Show in model` and `Show on sheet` actions.
- Provide an exploded-view slider, assembly reset, selected-part isolation, and restore-all action. Explosion is a visual aid using per-cabinet centers, not a claimed construction sequence.
- The inventory is a table with code/name, length/width/thickness, quantity, sheet location, and per-occurrence cut and assembled checkboxes with completion totals. Keep duplicate quantities and split segments distinct; map segments to their source body explicitly. If only source-body geometry is available, highlight that body and identify the segment rather than implying exact segment geometry.
- Remember checklist progress locally using a job-snapshot-specific key when browser storage is available. If unavailable, checklists still work for the current session. Copies on other devices do not synchronize. The downloaded file is a fixed snapshot, not a live connection to the estimator.
- Include sheet outlines, holes, panel codes, stock sizes, kerf/margins, and cut steps with the current manual overrides. Search and filter parts by name, code, and completion status.

## Implementation boundaries

Keep three focused pieces: a typed snapshot builder mapping existing estimator data into export data; a standalone browser runtime for the package UI and lightweight Three.js viewer; and an HTML generator/download adapter. Bundle the standalone runtime and Three.js into one inline script using the existing build toolchain, available in development and production. Reuse existing cut-step and unit-formatting logic; do not import the entire estimator, analysis solver, or OpenCascade into the export runtime.

Store model positions/normals/indices compactly with source-body identity and original assembly coordinates. Avoid unnecessary geometry duplication between quantities. Preserve colors and Z-up orientation. Render on demand while idle and during interaction; cap pixel ratio and use simple lighting rather than the estimator's full postprocessing pipeline. Do not change assembly geometry to reduce file size.

Serialize embedded data safely: job names and part names cannot terminate script tags or become executable markup. Validate snapshot references before download. If WebGL is unavailable or context creation fails, retain working inventory and cut views and show an actionable model-view message.

## Validation and acceptance

Test snapshot mapping for duplicate quantities, multiple source files, split parts, unplaced parts, manual cut overrides, and unchanged panel codes. Test serialization with HTML/script-like names. Build the production app and generate both exports from a representative model. Open the exported files directly with networking disabled and verify there are no external resource requests. At desktop, tablet, and phone sizes verify selection in all three directions, orbit/zoom, explosion/reset, isolation/restore, cut-step rendering, checklist totals, and storage-unavailable behavior. Confirm the phone layout has no horizontal page overflow and both artifacts remain useful without WebGL.

## Scope

This feature delivers browsable build packages. It does not infer assembly instructions, alter nesting, re-import STEP files, edit CAD, or synchronize progress between artifacts.
