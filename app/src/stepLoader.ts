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
  const res = occt.ReadStepFile(bytes, {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (!res || !res.success) {
    throw new Error('STEP parse failed.');
  }
  return res as OcctResult;
}
