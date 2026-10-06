# Assembly thickness correction

Status: implemented after design approval and the user's request for autonomous execution. Validation is recorded in `thickness-correction-plan.md`.

## Intended result

Change the plywood stock thickness while keeping the cabinet's outside perimeter and existing joints intact wherever those constraints can coexist. Resize the affected boards and translate them in the assembly; feed the corrected geometry into the viewer, cut list, nesting, and a new STEP assembly export.

The user's example is nominal 3/4 inch (19.05 mm) stock changing to measured 18 mm. The difference is 1.05 mm per board. A rail between two outer side boards with their outside faces fixed grows by 2.10 mm. A support underneath a top board whose top face stays fixed grows vertically by 1.05 mm. Stacked thicknesses and internal partitions require solving the connected assembly, not adding the same allowance to every part.

Assumptions for review:

- Preserve external dimensions and the outside outline before preserving internal clear openings. Internal openings may change with stock thickness.
- Work on one imported cabinet at a time, treating all of its parts as context even when only a thickness group is selected for conversion.
- Target actual measured thickness with a positive numeric millimetre input, rather than rounding it to a nominal plywood size.
- Save corrected CAD as a separate STEP download. Keep the imported source and an undo snapshot.

## Repository and benchmark evidence

- `main.ts` currently applies thickness override only when constructing nesting inputs; it does not change assembly geometry.
- `cae.ts` detects likely contacts for structural analysis. Its sampled edge contacts and default 2 mm tolerance are too permissive to serve directly as hard CAD constraints.
- `stepLoader.ts` exposes triangulated meshes through `occt-import-js`, not an editable native CAD feature tree.
- `stepExport.ts` already generates closed STEP panel solids from outlines, but lays them out side by side. Assembly export needs world placement instead.
- Read-only inspection of `FULL TOE KICK.stp` found 44 imported meshes: 42 rectangular, axis-aligned panels measuring 19.05 mm thick, and two zero-thickness surfaces. A bounding-face comparison found 126 face contacts, no positive-volume box overlaps, and no separated face pairs within 2 mm. The contact count is preliminary evidence, not a validated correction result.

## Approaches

Recommended: add a deterministic joint constraint solver for validated rectangular panel assemblies, then regenerate the corrected panel solids at their assembly positions using the existing STEP writer. This suits the supplied model and retains a browser-only workflow. Its limits must be explicit for shaped joinery and non-panel geometry.

Alternative: add a full CAD-kernel editing service that keeps original boundary representations and handles arbitrary trimmed faces and curved features. This provides a broader foundation, but requires a new runtime, import/body identity integration, feature-specific edit rules, and substantially more validation. A CAD kernel alone does not infer which cabinet dimensions should remain fixed.

The recommended first implementation will not silently treat complex solids as rectangular boards. A panel must pass the geometry checks before automatic correction is offered.

## Find affected boards

1. Retain stable source-file/body identities and immutable imported geometry. Keep assembly transforms separate from the display's file-spacing and floor offsets.
2. Determine a shared orthogonal assembly frame and verify every candidate board is a closed rectangular prism. Do not rely only on the largest face outline: inspect the mesh faces and volume so pockets, rebates, notches, and holes cannot disappear during reconstruction.
3. Build a broad-phase neighbour list, then compare actual rectangular faces. Require opposing normals, plane separation within a tight editable contact tolerance (default 0.05 mm), and positive overlap area. Record which board face touches which other face, the contact interval, and the original small gap. Ignore point/edge-only proximity as a butt joint.
4. Separate end-to-face, end-to-end, and face-to-face contacts. Thickness changes can propagate through all three; do not label every neighbour as a length extension.
5. Starting from the chosen nominal thickness group, follow contacts to identify boards whose dimensions or positions depend on the changed faces. Unchanged-thickness boards can still need length adjustments.
6. Keep disconnected assemblies separate. Boards in the active cabinet remain part of the solve even when their thickness group is unchanged; geometry outside that cabinet stays fixed. Crossing into an unsupported part produces a review item rather than an assumed joint.

The structural-analysis detector can be reused for visual comparison, but the correction module owns its stricter contact representation and tolerances.

## Preserve the exterior and solve the joints

Represent every supported board by its six face coordinates in the assembly frame. For each principal direction, solve the face movements together:

- New distance between the two thickness faces equals the requested stock thickness for target boards, and the original thickness for other boards.
- Original connected faces remain connected, preserving their original tiny clearance instead of absorbing unrelated design gaps.
- Original external reference faces remain at their coordinates. Identify the outer boundaries of the assembly's projections, excluding enclosed internal openings. Preserve perimeter segments and re-entrant corners; a global bounding box alone is insufficient for the toe kick's L shape.
- Detect recessed broad faces that projections hide by checking exposure on both sides against intervening board faces. A sole exposed face stays fixed. When both faces are exposed, prefer the outward side relative to the connected assembly centre; a centred board with both faces exposed requires an explicit anchor in the source CAD. Reference planes are identified before inferring assembly axes.
- Preserve original flush alignments at a joint when they are needed to retain contact and the exterior profile.
- Prefer unchanged in-plane board dimensions when no joint requires a change. For remaining freedom, minimize movement and keep unconstrained internal board centres near their original positions. Use deterministic ordering and tolerances.

Solve equalities explicitly, detect contradictory constraints, and report which boards/faces conflict. Do not hide an impossible exterior constraint by scaling the entire cabinet or leaving a gap. A single board whose two external thickness faces are both fixed cannot become thinner without relaxing one face; such cases need an anchor choice in the review.

After solving, independently check all original supported contacts, face overlap, positive dimensions, collisions, target thickness, and exterior boundary segments. Recompute the projected outside outline and compare it to the original, including concave corners. Reject the proposed application if a hard invariant fails.

## Review and application

The Thickness workspace sits beside Cut planning and Analysis. It has stock
settings on the left, the shared 3D viewer in the centre, and a separate review
area on the right. On narrower screens, the review stacks below the viewer.
The workflow provides:

- Cabinet and source thickness group, actual stock thickness input, and Analyse corrections.
- A searchable table with Board, Old size, New size, and Movement columns. Expand a board name to inspect the joints responsible for its changes.
- A preview showing the original outline and corrected assembly, highlighting changed boards and unresolved contacts.
- External size/outline and joint validation results.
- Apply correction, Reset to imported geometry, and Download STEP, always available in the fixed review footer while its report scrolls.

Leaving this workspace clears temporary preview geometry while keeping the
proposal and applied state. All workspaces share restrained colours, consistent
section headings, and keyboard-accessible navigation. This follows the user's
request to use [Dieter Rams's principles](https://www.vitsoe.com/us/about/good-design)
for understandable, useful, honest, and unobtrusive design.

Analysis creates a proposal without changing live geometry. Applying a valid proposal updates the viewer and body analyses together, invalidates stale nesting and structural-analysis results, and regenerates cutting inputs from corrected dimensions. Reset restores the imported baseline. Repeated edits solve from that baseline, avoiding accumulated rounding or repeated allowances.

The existing nominal-thickness override must not silently override a corrected 18 mm part with 19.05 mm. Applying correction should clear the incompatible override and use corrected geometry as the source of thickness.

## CAD output

Extend the existing panel STEP writer with explicit world origin and orthonormal axes. Keep its existing side-by-side export behaviour for unplaced cutting parts. The new assembly export writes corrected panels in their solved assembly positions, including unchanged supported panels in that cabinet.

For this first implementation, label the download as a corrected panel assembly. Treat the supplied file's two zero-thickness surfaces as reference geometry and list them as excluded from that panel-solid export. Other unsupported solids must never be silently omitted: show their identities and block an export described as a complete corrected assembly.

This exports usable CAD solids; it does not recreate the source CAD application's feature history. For validated rectangular boards, the generated geometry consists of exact planar faces rather than tessellated curved approximations.

## Components

- New `app/src/thicknessCorrection.ts`: supported-panel validation, contact graph, exterior references, constrained correction, independent validation, and change report. No DOM or viewer dependency.
- `app/src/main.ts`: source-body mapping and baseline state, correction controls, proposal/apply/reset lifecycle, nesting and analysis invalidation.
- `app/src/viewer.ts`: reversible updates of the affected body geometry and correction preview highlighting.
- `app/src/stepExport.ts`: placed panel solids and corrected assembly metadata, preserving the existing unplaced-parts export.
- `app/index.html` and `app/src/style.css`: controls and readable per-board change review within the existing visual style.
- New geometry regression tests and a local STEP benchmark using the existing OCCT importer.

## Acceptance checks

1. Side boards change from 19.05 to 18 mm with external faces fixed; the intervening rail grows by exactly 2.10 mm and all butt joints remain closed.
2. A fixed top surface stays fixed while the top panel thins and the board below extends by 1.05 mm.
3. Internal divider and double-layer cases propagate cumulative changes correctly without breaking face-to-face contacts.
4. The complete toe-kick assembly retains its outside outline, including the L-shaped return, and every supported original joint passes post-correction validation.
5. Mixed thicknesses, disconnected cabinets, and unchanged context boards do not receive unrelated thickness changes.
6. Unsupported shaped joinery, contradictory anchors, pre-existing overlaps, false near contacts, and zero/negative target thickness produce actionable review results.
7. Apply, repeated analyse/apply, and reset preserve stable part identities; viewer, cut list, and nesting use the same corrected dimensions.
8. Export and re-import the corrected STEP through OCCT. Verify solid count, thickness, world placement, outside outline, and contact closure. Test the legacy STEP export separately for regressions.
9. Run optimizer regressions and a browser flow with `FULL TOE KICK.stp`; retain a before/after dimension report and the corrected STEP as benchmark artifacts.
