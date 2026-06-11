/**
 * Wraps occt-import-js (OpenCascade WASM) for STEP parsing.
 * The library is loaded as a global script from /public/occt/.
 */

export interface OcctMesh {
  name: string;
  color?: [number, number, number];
  brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
}

export interface OcctResult {
  success: boolean;
  root: { name: string; meshes: number[]; children: any[] };
  meshes: OcctMesh[];
}

declare global {
  interface Window {
    occtimportjs?: (opts?: any) => Promise<any>;
  }
}

let occtPromise: Promise<any> | null = null;

async function ensureOcct(): Promise<any> {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    if (window.occtimportjs) {
      resolveOcct(resolve, reject);
      return;
    }
    const s = document.createElement('script');
    s.src = '/occt/occt-import-js.js';
    s.async = true;
    s.onload = () => resolveOcct(resolve, reject);
    s.onerror = () => reject(new Error('Failed to load occt-import-js script.'));
    document.head.appendChild(s);
  });
  return occtPromise;
}

function resolveOcct(resolve: (v: any) => void, reject: (e: Error) => void) {
  if (!window.occtimportjs) {
    reject(new Error('occtimportjs global not present after script load.'));
    return;
  }
  window
    .occtimportjs({
      locateFile: (path: string) => `/occt/${path}`,
    })
    .then(resolve)
    .catch(reject);
}

export async function parseStep(buffer: ArrayBuffer): Promise<OcctResult> {
  const occt = await ensureOcct();
  const bytes = new Uint8Array(buffer);
  // Tessellation quality. occt-import-js can only hand us triangles (the
  // BREP's true B-spline/arc curves are not exposed), so curve fidelity is
  // set HERE and nowhere else:
  //   - linearDeflection 0.1 mm ABSOLUTE: max chord error of any tessellated
  //     edge. The old bounding_box_ratio setting scaled with model size — a
  //     2.5 m cabinet got ~2.5 mm of sag and visibly faceted curves.
  //   - angularDeflection 0.2 rad (~11°): caps segment turn on small-radius
  //     features (hinge-cup holes etc.) where the linear bound alone is lax.
  // 0.1 mm is far inside any saw/router tolerance, so downstream outlines,
  // SVG/DXF exports and CNC masks treat curves as effectively exact.
  const res = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.1,
    angularDeflection: 0.2,
  });
  if (!res || !res.success) {
    throw new Error('STEP parse failed.');
  }
  return res as OcctResult;
}
