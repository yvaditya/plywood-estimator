# Curved panel finite-element mesh

The user wants real solver meshes for curved bodies in the plywood analysis workflow, with a filled view of the exact elements being solved. Existing authorization requests autonomous completion.

Support flat, constant-thickness boards with curved or oblique outer boundaries and holes. The STEP importer supplies polylines at 0.1 mm chord tolerance; preserve those boundaries without a stair-step raster. Freeform bent or doubly curved solids are outside the planar-board data model and must not be claimed as supported.

Retain the efficient rectangular Q4/H8 path. For nonrectilinear outlines, form a constrained, refined triangle mesh and subdivide each triangle into three convex Q4 elements with shared edge midpoints. Extrude those Q4 elements into H8 layers for solid analysis. This permits one solver connectivity format and exact preview/solve/view identity. General isoparametric element matrices and stress recovery must use actual node coordinates, not bounding-box dimensions.

Reject invalid boundaries, inverted Jacobians, and meshes exceeding the resource cap. Report the source boundary approximation, actual element size, aspect and Jacobian quality. Keep filled faces as default, expose all internal edges, and retain explicit deformation controls.

Validation must cover curved outlines and holes, concave profiles, manifold connectivity, positive element Jacobians, area and extruded volume, coordinate and connectivity identity, stiffness patch tests, rigid-body modes, and solve refinement. Rectangular reference results must remain unchanged.
