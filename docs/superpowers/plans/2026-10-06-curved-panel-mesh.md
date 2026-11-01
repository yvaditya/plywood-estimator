# Curved Panel Mesh Implementation Plan

**Goal:** Mesh and solve planar curved plywood boundaries using the same elements shown in the viewer.

**Architecture:** Add isolated boundary-meshing and general-element modules. The assembly pipeline uses explicit local nodes and quad connectivity; result textures are rasterized from those elements.

**Tech stack:** TypeScript, Three.js triangulation, existing Eigen/PCG and optional PyNite solvers.

**Spec:** ../specs/2026-10-06-curved-panel-mesh.md

## Constraints and review focus

- Preserve existing uncommitted optimization, thickness, and CAE changes.
- Preserve imported boundary vertices and holes; never fill a hole through centroid-only classification.
- No inverted elements, hanging nodes, invented support bands, or display-only mesh substitution.
- Bound refinement and respect actual DOF caps, including mandatory curved boundary detail.
- Disclose planar-board scope and imported curve approximation.

## Tasks

- [x] Add `app/src/caeBoundaryMesh.ts`: `meshBoundaryQuads(outline, sizeMm)` returns local `uv: Vec2[]` and `quads: [number,number,number,number][]`. Validate topology, refine with shared edges, preserve boundary, and exercise circle/hole/concavity/refinement/invalid input tests.
- [x] Add `app/src/caeElements.ts`: general Q4 membrane and Mindlin/MITC plate matrices, extruded H8 stiffness, centre derivatives and strain recovery. Test affine strain energy, rigid motions, positive energy, and rectangular equivalence.
- [x] Integrate explicit nodes/connectivity in `app/src/cae.ts` for preprocessing, loads, supports, quality, preview, serialization, assembly and recovery. Rectangular kernels remain the fast path; nonrectangular kernels use actual geometry.
- [x] Update analysis hints and quality reporting in `main.ts`/`index.html`, plus README scope. Add end-to-end curved panel preview/solve and renderer identity regressions.
- [x] Build, run numerical and geometry tests, exercise a curved STEP import in the production browser, capture filled/wireframe meshes, and review the complete change.

## Verification and review

- `npm test`: 123 passed. `npm run build`: passed (existing bundle-size/WASM warnings).
- `python tests/cae_sidecar_test.py`: 4 passed.
- Production browser: native curved STEP arc and circular hole imported, meshed, refined, solved, and displayed as filled/wire meshes using Eigen and PyNite. Both runs preserved preview/solve connectivity and produced no browser errors. Solid mesh: 2,988 H8 elements, 4,794 nodes, 14,382 DOF.
- Existing three-board cabinet browser regression: shell/H8, holes, layers, supports, result views and preview/solve counts passed.
- FULL TOE KICK benchmark: 42 eligible boards, no unsupported-board regressions; 5,181 nodes and 3,872 Q4 elements at 30 mm.
- Independent code review found and verified fixes for node-density-biased patch loads and grain-frame display mismatch. Consistent Q4 area loads preserve force and first moments, including partial footprints. Source-outline and grain frames now agree after arbitrary import rotations.
- Screenshots and run summaries: `tests/_output/cae_curved_ui/`, `tests/_output/cae_curved_ui_pynite/`, and `tests/_output/cae_boundary_ui/`.
- Scope remains flat, constant-thickness board solids. Curves follow the 0.1 mm imported chord approximation. Joint links are approximate, distorted cells require convergence checks, and H8 stress recovery is at element centres.
