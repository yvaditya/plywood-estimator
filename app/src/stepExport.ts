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

import type { Vec2 } from './geometry';

export interface StepPart {
  name: string;
  /** Outer ring, CCW, mm. Anchored anywhere — we offset parts apart on export. */
  outer: Vec2[];
  /** Inner rings (holes), CW, mm. */
  holes: Vec2[][];
  /** Panel thickness, mm. */
  thickness: number;
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

/** Emit the topology + geometry for one extruded ring set and return the
 *  manifold_solid_brep id. */
function emitPrism(w: StepWriter, part: StepPart, dx: number): number {
  const t = part.thickness > 0 ? part.thickness : 1;
  const rings: { pts: Vec2[] }[] = [
    { pts: part.outer },
    ...part.holes.map((h) => ({ pts: h })),
  ];

  // Shared direction/point primitives.
  const dirZ = w.e('DIRECTION(\'\',(0.0,0.0,1.0))');
  const dirNZ = w.e('DIRECTION(\'\',(0.0,0.0,-1.0))');
  const dirX = w.e('DIRECTION(\'\',(1.0,0.0,0.0))');

  interface RingTopo { vb: number[]; vt: number[]; eb: number[]; et: number[]; ev: number[]; }
  const topos: RingTopo[] = [];

  for (const ring of rings) {
    const pts = ring.pts;
    const n = pts.length;
    const vb: number[] = [], vt: number[] = [];
    for (const [x, y] of pts) {
      const pb = w.e(`CARTESIAN_POINT('',(${f(x + dx)},${f(y)},0.0))`);
      const pt = w.e(`CARTESIAN_POINT('',(${f(x + dx)},${f(y)},${f(t)}))`);
      vb.push(w.e(`VERTEX_POINT('',#${pb})`));
      vt.push(w.e(`VERTEX_POINT('',#${pt})`));
    }
    const mkEdge = (pa: number, pbV: number, ax: number, ay: number, az: number, ox: number, oy: number, oz: number): number => {
      const d = w.e(`DIRECTION('',(${f(ax)},${f(ay)},${f(az)}))`);
      const v = w.e(`VECTOR('',#${d},1.0)`);
      const p = w.e(`CARTESIAN_POINT('',(${f(ox)},${f(oy)},${f(oz)}))`);
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
    const loc = w.e('CARTESIAN_POINT(\'\',(0.0,0.0,' + f(t) + '))');
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
    const loc = w.e('CARTESIAN_POINT(\'\',(0.0,0.0,0.0))');
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
      const nrm = w.e(`DIRECTION('',(${f(uy)},${f(-ux)},0.0))`);
      const loc = w.e(`CARTESIAN_POINT('',(${f(x1 + dx)},${f(y1)},0.0))`);
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
  const safeName = part.name.replace(/['\\]/g, ' ');
  return w.e(`MANIFOLD_SOLID_BREP('${safeName}',#${shell})`);
}

/**
 * Build a complete STEP AP214 file containing one extruded solid per part.
 * Parts are spread along X so they don't overlap.
 */
export function buildStep(parts: StepPart[], isoDate: string): string {
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

  // One solid per part, offset along X.
  const solids: number[] = [];
  let dx = 0;
  for (const p of parts) {
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
  const prod = w.e(`PRODUCT('unplaced_parts','unplaced_parts','',(#${prodCtx}))`);
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
    "FILE_DESCRIPTION(('Unplaced parts from plywood-estimator'),'2;1');",
    `FILE_NAME('unplaced-parts.step','${isoDate}',(''),(''),'plywood-estimator','plywood-estimator','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    w.body(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
