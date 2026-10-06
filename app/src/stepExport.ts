/**
 * Minimal STEP (AP214) writer for sheet-good parts.
 *
 * Each part is a flat panel fully described by its 2D footprint (outer ring +
 * holes, in mm) and a thickness. We export it as an extruded prism
 * (MANIFOLD_SOLID_BREP): the footprint at z=0 and z=thickness joined by side
 * faces. This lets us emit a STEP file containing ONLY selected bodies (e.g.
 * the parts that wouldn't nest), rather than re-exporting a whole source file.
 *
 * Topology is built so every edge is shared by exactly two faces with opposite
 * orientation (a valid closed manifold shell), which CAD/CAM importers accept.
 */

import type { Vec2, Vec3 } from './geometry';

export interface StepPart {
  name: string;
  /** Outer ring, CCW, mm. Anchored anywhere — we offset parts apart on export. */
  outer: Vec2[];
  /** Inner rings (holes), CW, mm. */
  holes: Vec2[][];
  /** Panel thickness, mm. */
  thickness: number;
}

export interface PlacedStepPart extends StepPart {
  /** World position of local (0, 0, 0), in mm. */
  origin: Vec3;
  /** Orthonormal, right-handed local axes in world coordinates. */
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
}

class StepWriter {
  private lines: string[] = [];
  private id = 0;
  e(body: string): number {
    const n = ++this.id;
    this.lines.push(`#${n}=${body};`);
    return n;
  }
  refs(ids: number[]): string {
    return `(${ids.map((i) => `#${i}`).join(',')})`;
  }
  body(): string {
    return this.lines.join('\n');
  }
}

const f = (n: number): string => {
  // STEP reals: finite decimal, always with a fractional part.
  if (!isFinite(n)) n = 0;
  let s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
  if (!s.includes('.')) s += '.0';
  return s;
};

function unit(dx: number, dy: number, dz: number): [number, number, number] {
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}

/** STEP strings escape apostrophes by doubling them. Remove controls and
 *  backslashes so a supplied name cannot introduce a STEP encoding directive. */
function stepString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\\]/g, ' ').replace(/'/g, "''");
}

function assemblyReal(n: number): string {
  if (!Number.isFinite(n)) throw new Error('Panel world geometry must be finite.');
  const [mantissa, exponent] = String(n).split('e');
  return (mantissa.includes('.') ? mantissa : `${mantissa}.0`) + (exponent ? `E${exponent}` : '');
}

function validatePlacedPart(part: PlacedStepPart): void {
  const finiteVector = (v: number[], size: number) =>
    Array.isArray(v) && v.length === size && v.every(Number.isFinite);
  if (![part.origin, part.uAxis, part.vAxis, part.normal].every(v => finiteVector(v, 3))) {
    throw new Error(`Panel "${part.name}" requires finite origin and frame vectors.`);
  }
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const u = part.uAxis, v = part.vAxis, n = part.normal;
  const cross: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const tolerance = 1e-8;
  if ([u, v, n].some(axis => Math.abs(dot(axis, axis) - 1) > tolerance)
    || Math.abs(dot(u, v)) > tolerance || Math.abs(dot(u, n)) > tolerance || Math.abs(dot(v, n)) > tolerance
    || Math.hypot(cross[0] - n[0], cross[1] - n[1], cross[2] - n[2]) > tolerance) {
    throw new Error(`Panel "${part.name}" requires an orthonormal right-handed frame.`);
  }
  if (!Number.isFinite(part.thickness) || part.thickness <= 0) {
    throw new Error(`Panel "${part.name}" thickness must be finite and positive.`);
  }
  let area = 0;
  for (const [index, ring] of [part.outer, ...part.holes].entries()) {
    if (ring.length < 3 || !ring.every(p => finiteVector(p, 2))) {
      throw new Error(`Panel "${part.name}" rings need at least three finite points.`);
    }
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) throw new Error(`Panel "${part.name}" ring has a zero-length edge.`);
      twiceArea += (a[0] - ring[0][0]) * (b[1] - ring[0][1]) - (b[0] - ring[0][0]) * (a[1] - ring[0][1]);
    }
    if (!Number.isFinite(twiceArea) || (index === 0 ? twiceArea <= 0 : twiceArea >= 0)) {
      throw new Error(`Panel "${part.name}" rings need positive area, with CCW outer and CW holes.`);
    }
    area += twiceArea / 2;
  }
  if (!(area > 0) || !Number.isFinite(area * part.thickness)) {
    throw new Error(`Panel "${part.name}" geometry must have finite, positive volume.`);
  }
}

/** Emit the topology + geometry for one extruded ring set and return the
 *  manifold_solid_brep id. */
function emitPrism(w: StepWriter, part: StepPart, dx: number, frame?: PlacedStepPart): number {
  const t = part.thickness > 0 ? part.thickness : 1;
  const rings: { pts: Vec2[] }[] = [
    { pts: part.outer },
    ...part.holes.map((h) => ({ pts: h })),
  ];

  // Apply the same rigid frame to vertices, edge curves, and supporting planes.
  // Legacy layout keeps its original six-decimal formatting.
  const real = frame ? assemblyReal : f;
  const vector = (x: number, y: number, z: number): Vec3 => frame ? [
    frame.uAxis[0] * x + frame.vAxis[0] * y + frame.normal[0] * z,
    frame.uAxis[1] * x + frame.vAxis[1] * y + frame.normal[1] * z,
    frame.uAxis[2] * x + frame.vAxis[2] * y + frame.normal[2] * z,
  ] : [x, y, z];
  const direction = (x: number, y: number, z: number): number =>
    w.e(`DIRECTION('',(${vector(x, y, z).map(real).join(',')}))`);
  const point = (x: number, y: number, z: number): number => {
    const p = vector(x, y, z);
    if (frame) for (let axis = 0; axis < 3; axis++) p[axis] += frame.origin[axis];
    return w.e(`CARTESIAN_POINT('',(${p.map(real).join(',')}))`);
  };
  const dirZ = direction(0, 0, 1);
  const dirNZ = direction(0, 0, -1);
  const dirX = direction(1, 0, 0);

  interface RingTopo { vb: number[]; vt: number[]; eb: number[]; et: number[]; ev: number[]; }
  const topos: RingTopo[] = [];

  for (const ring of rings) {
    const pts = ring.pts;
    const n = pts.length;
    const vb: number[] = [], vt: number[] = [];
    for (const [x, y] of pts) {
      const pb = point(x + dx, y, 0);
      const pt = point(x + dx, y, t);
      vb.push(w.e(`VERTEX_POINT('',#${pb})`));
      vt.push(w.e(`VERTEX_POINT('',#${pt})`));
    }
    const mkEdge = (pa: number, pbV: number, ax: number, ay: number, az: number, ox: number, oy: number, oz: number): number => {
      const d = direction(ax, ay, az);
      const v = w.e(`VECTOR('',#${d},1.0)`);
      const p = point(ox, oy, oz);
      const line = w.e(`LINE('',#${p},#${v})`);
      return w.e(`EDGE_CURVE('',#${pa},#${pbV},#${line},.T.)`);
    };
    const eb: number[] = [], et: number[] = [], ev: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x1, y1] = pts[i], [x2, y2] = pts[j];
      const [ux, uy] = unit(x2 - x1, y2 - y1, 0);
      eb.push(mkEdge(vb[i], vb[j], ux, uy, 0, x1 + dx, y1, 0));
      et.push(mkEdge(vt[i], vt[j], ux, uy, 0, x1 + dx, y1, t));
      ev.push(mkEdge(vb[i], vt[i], 0, 0, 1, x1 + dx, y1, 0));
    }
    topos.push({ vb, vt, eb, et, ev });
  }

  const oriented = (edge: number, dir: boolean) => w.e(`ORIENTED_EDGE('',*,*,#${edge},${dir ? '.T.' : '.F.'})`);

  // Cap loops: forward traversal of an edge array, optionally reversed sense.
  const capLoop = (edges: number[], forward: boolean): number => {
    const n = edges.length;
    const oe: number[] = [];
    if (forward) for (let i = 0; i < n; i++) oe.push(oriented(edges[i], true));
    else for (let i = n - 1; i >= 0; i--) oe.push(oriented(edges[i], false));
    return w.e(`EDGE_LOOP('',${w.refs(oe)})`);
  };

  const faces: number[] = [];

  // Top cap (normal +Z): outer bound + hole bounds, all forward.
  {
    const loc = point(0, 0, t);
    const ax = w.e(`AXIS2_PLACEMENT_3D('',#${loc},#${dirZ},#${dirX})`);
    const plane = w.e(`PLANE('',#${ax})`);
    const bounds: number[] = [];
    topos.forEach((tp, idx) => {
      const loop = capLoop(tp.et, true);
      bounds.push(w.e(`${idx === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},.T.)`));
    });
    faces.push(w.e(`ADVANCED_FACE('',${w.refs(bounds)},#${plane},.T.)`));
  }
  // Bottom cap (normal -Z): outer bound + hole bounds, all reversed.
  {
    const loc = point(0, 0, 0);
    const ax = w.e(`AXIS2_PLACEMENT_3D('',#${loc},#${dirNZ},#${dirX})`);
    const plane = w.e(`PLANE('',#${ax})`);
    const bounds: number[] = [];
    topos.forEach((tp, idx) => {
      const loop = capLoop(tp.eb, false);
      bounds.push(w.e(`${idx === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${loop},.T.)`));
    });
    faces.push(w.e(`ADVANCED_FACE('',${w.refs(bounds)},#${plane},.T.)`));
  }
  // Side faces: one quad per ring edge.
  for (let r = 0; r < rings.length; r++) {
    const tp = topos[r];
    const pts = rings[r].pts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x1, y1] = pts[i], [x2, y2] = pts[j];
      const [ux, uy] = unit(x2 - x1, y2 - y1, 0);
      // Outward (loop right-hand) normal for edge Bi->B(i+1): (uy,-ux,0).
      const nrm = direction(uy, -ux, 0);
      const loc = point(x1 + dx, y1, 0);
      const ax = w.e(`AXIS2_PLACEMENT_3D('',#${loc},#${nrm},#${dirZ})`);
      const plane = w.e(`PLANE('',#${ax})`);
      const oe = [
        oriented(tp.eb[i], true),   // Bi -> B(i+1)
        oriented(tp.ev[j], true),   // B(i+1) -> T(i+1)
        oriented(tp.et[i], false),  // T(i+1) -> Ti
        oriented(tp.ev[i], false),  // Ti -> Bi
      ];
      const loop = w.e(`EDGE_LOOP('',${w.refs(oe)})`);
      const bound = w.e(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(w.e(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
    }
  }

  const shell = w.e(`CLOSED_SHELL('',${w.refs(faces)})`);
  const safeName = frame ? stepString(part.name) : part.name.replace(/['\\]/g, ' ');
  return w.e(`MANIFOLD_SOLID_BREP('${safeName}',#${shell})`);
}

/**
 * Build a complete STEP AP214 file containing one extruded solid per part.
 * Parts are spread along X so they don't overlap.
 */
export function buildStep(parts: StepPart[], isoDate: string): string {
  return buildStepDocument(parts, isoDate);
}

/** Export corrected panel solids in their assembly positions. Local footprint
 *  (x, y) extrudes from z=0 to thickness along the supplied normal. */
export function buildAssemblyStep(parts: PlacedStepPart[], isoDate: string, name = 'corrected_assembly'): string {
  if (parts.length === 0) throw new Error('A corrected assembly needs at least one panel.');
  parts.forEach(validatePlacedPart);
  return buildStepDocument(parts, isoDate, { parts, name });
}

function buildStepDocument(parts: StepPart[], isoDate: string, assembly?: { parts: PlacedStepPart[]; name: string }): string {
  const w = new StepWriter();

  // Geometric context with mm units.
  const lenUnit = w.e('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angUnit = w.e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solUnit = w.e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncert = w.e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${lenUnit},'distance_accuracy_value','')`);
  const ctx = w.e(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncert}))` +
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solUnit}))REPRESENTATION_CONTEXT('',''))`,
  );

  // One solid per part: preserve world placement for assemblies, or spread
  // unplaced cutting parts along X using the existing layout.
  const solids: number[] = [];
  let dx = 0;
  for (const [index, p] of parts.entries()) {
    if (assembly) {
      solids.push(emitPrism(w, p, 0, assembly.parts[index]));
      continue;
    }
    let minX = Infinity, maxX = -Infinity;
    for (const [x] of p.outer) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    if (!isFinite(minX)) { minX = 0; maxX = 0; }
    solids.push(emitPrism(w, p, dx - minX));
    dx += (maxX - minX) + 50; // 50 mm gap between parts
  }

  // Shape representation + product structure boilerplate.
  const originPt = w.e('CARTESIAN_POINT(\'\',(0.0,0.0,0.0))');
  const zd = w.e('DIRECTION(\'\',(0.0,0.0,1.0))');
  const xd = w.e('DIRECTION(\'\',(1.0,0.0,0.0))');
  const placement = w.e(`AXIS2_PLACEMENT_3D('',#${originPt},#${zd},#${xd})`);
  const repItems = [placement, ...solids];
  const shapeRep = w.e(`ADVANCED_BREP_SHAPE_REPRESENTATION('',${w.refs(repItems)},#${ctx})`);

  const appCtx = w.e('APPLICATION_CONTEXT(\'core data for automotive mechanical design processes\')');
  w.e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = w.e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const productName = assembly ? stepString(assembly.name) : 'unplaced_parts';
  const prod = w.e(`PRODUCT('${productName}','${productName}','',(#${prodCtx}))`);
  const prodDefCtx = w.e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const formation = w.e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const prodDef = w.e(`PRODUCT_DEFINITION('design','',#${formation},#${prodDefCtx})`);
  const prodDefShape = w.e(`PRODUCT_DEFINITION_SHAPE('','',#${prodDef})`);
  w.e(`SHAPE_DEFINITION_REPRESENTATION(#${prodDefShape},#${shapeRep})`);
  const prodCat = w.e('PRODUCT_RELATED_PRODUCT_CATEGORY(\'part\',$,(#' + prod + '))');
  void prodCat;

  return [
    'ISO-10303-21;',
    'HEADER;',
    assembly ? "FILE_DESCRIPTION(('Corrected panel assembly from woodworking-companion'),'2;1');"
      : "FILE_DESCRIPTION(('Unplaced parts from woodworking-companion'),'2;1');",
    `FILE_NAME('${assembly ? 'corrected-assembly' : 'unplaced-parts'}.step','${assembly ? stepString(isoDate) : isoDate}',(''),(''),'woodworking-companion','woodworking-companion','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    w.body(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
