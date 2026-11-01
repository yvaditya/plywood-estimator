/**
 * General planar Q4 and straight-extruded H8 finite elements. Coordinates and
 * constitutive matrices use the same panel/material axes. These are small-strain
 * elements for flat boards, not warped shells or curved through-thickness solids.
 *
 * Plate: Bathe & Dvorkin (1985), MITC4 covariant shear interpolation, eqs. 6–9:
 * https://web.mit.edu/kjb/www/Publications_Prior_to_1998/A_Four-Node_Plate_Bending_Element_Based_on_Mindlin_Reissner_Plate_Theory_and_a_Mixed_Interpolation.pdf
 * Solid: nine enhanced displacement-gradient modes with the centre Jacobian
 * and det(J0)/det(J) correction described in the linear formulation at:
 * https://abaqus.uclouvain.be/English/SIMACAETHERefMap/simathe-c-incompatible.htm
 * The additional volumetric modes of a 13-mode C3D8I are not included here.
 */

type Quad = readonly (readonly [number, number])[];
type Matrix = readonly (readonly number[])[];
type HexStrain = [number, number, number, number, number, number];
const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
const GP = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const zeros = (rows: number, cols: number): number[][] =>
  Array.from({ length: rows }, () => new Array(cols).fill(0));

interface QuadMap {
  N: number[];
  dx: number[];
  dy: number[];
  det: number;
  dXi: number[];
  dEta: number[];
  xXi: number;
  xEta: number;
  yXi: number;
  yEta: number;
}

/** J has physical-coordinate rows and natural-coordinate columns. */
function mapping(uv: Quad, xi: number, eta: number): QuadMap {
  const N: number[] = [], dXi: number[] = [], dEta: number[] = [];
  let xXi = 0, xEta = 0, yXi = 0, yEta = 0;
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = SIGNS[i];
    N.push(.25 * (1 + sx * xi) * (1 + sy * eta));
    dXi.push(.25 * sx * (1 + sy * eta));
    dEta.push(.25 * sy * (1 + sx * xi));
    // Subtracting a common origin avoids cancellation for translated meshes.
    const x = uv[i][0] - uv[0][0], y = uv[i][1] - uv[0][1];
    xXi += dXi[i] * x; xEta += dEta[i] * x;
    yXi += dXi[i] * y; yEta += dEta[i] * y;
  }
  const det = xXi * yEta - xEta * yXi;
  if (!(det > 0) || !Number.isFinite(det))
    throw new Error('Inverted or degenerate quadrilateral Jacobian.');
  const dx = dXi.map((v, i) => (yEta * v - yXi * dEta[i]) / det);
  const dy = dXi.map((v, i) => (-xEta * v + xXi * dEta[i]) / det);
  return { N, dx, dy, det, dXi, dEta, xXi, xEta, yXi, yEta };
}

function validateQuad(uv: Quad): void {
  if (uv.length !== 4 || uv.some(p => p.length !== 2 || !p.every(Number.isFinite)))
    throw new Error('A quadrilateral needs four finite two-dimensional coordinates.');
  let edgeSquared = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    edgeSquared = Math.max(edgeSquared, (uv[i][0] - uv[j][0]) ** 2 + (uv[i][1] - uv[j][1]) ** 2);
  }
  // A bilinear planar Q4 determinant is affine in (xi,eta). Positive corner
  // determinants therefore establish positive orientation on the entire cell,
  // including parts which a 2×2 Gauss rule alone would miss in a folded Q4.
  for (const [xi, eta] of SIGNS) {
    if (mapping(uv, xi, eta).det <= 64 * Number.EPSILON * edgeSquared)
      throw new Error('Degenerate quadrilateral: its corner Jacobian is too small.');
  }
}

function naturalPoint(...coordinates: number[]): void {
  if (coordinates.some(v => !Number.isFinite(v) || Math.abs(v) > 1))
    throw new Error('Natural element coordinates must be finite and within [-1,1].');
}

/** CCW nodes (-,-),(+,-),(+,+),(-,+); physical derivatives in the panel axes. */
export function quadGeometry(uv: Quad, xi = 0, eta = 0): {
  N: number[]; dx: number[]; dy: number[]; det: number;
} {
  validateQuad(uv); naturalPoint(xi, eta);
  const { N, dx, dy, det } = mapping(uv, xi, eta);
  return { N, dx, dy, det };
}

function validateMatrix(D: Matrix, n: number): void {
  if (D.length !== n || D.some(row => row.length !== n || !row.every(Number.isFinite)))
    throw new Error(`The constitutive matrix must be a finite ${n}×${n} matrix.`);
}

function product(D: Matrix, B: Matrix): number[][] {
  return D.map(row => B[0].map((_, col) => row.reduce((s, d, k) => s + d * B[k][col], 0)));
}

/** K += Aᵀ B weight. A and B have the same strain-component row order. */
function accumulate(K: number[][], A: Matrix, B: Matrix, weight: number): void {
  for (let r = 0; r < K.length; r++) for (let c = 0; c < K[r].length; c++) {
    let value = 0;
    for (let k = 0; k < A.length; k++) value += A[k][r] * B[k][c];
    K[r][c] += value * weight;
  }
}

/** 8×8 membrane stiffness, DOFs [u,v] per node, full 2×2 integration. */
export function quadMembraneK(uv: Quad, Dm: Matrix): number[][] {
  validateQuad(uv); validateMatrix(Dm, 3);
  const K = zeros(8, 8);
  for (const xi of GP) for (const eta of GP) {
    const { dx, dy, det } = mapping(uv, xi, eta), B = zeros(3, 8);
    for (let i = 0; i < 4; i++) {
      B[0][2 * i] = dx[i]; B[1][2 * i + 1] = dy[i];
      B[2][2 * i] = dy[i]; B[2][2 * i + 1] = dx[i];
    }
    accumulate(K, B, product(Dm, B), det);
  }
  return K;
}

/** Covariant engineering shear gamma_xi or gamma_eta at an edge tying point. */
function covariantShear(g: QuadMap, direction: 'xi' | 'eta'): number[] {
  const d = direction === 'xi' ? g.dXi : g.dEta;
  const x = direction === 'xi' ? g.xXi : g.xEta;
  const y = direction === 'xi' ? g.yXi : g.yEta;
  const B = new Array(12).fill(0);
  for (let i = 0; i < 4; i++) {
    B[3 * i] = d[i];
    B[3 * i + 1] = -y * g.N[i];
    B[3 * i + 2] = x * g.N[i];
  }
  return B;
}

/**
 * 12×12 MITC4 plate stiffness, [w,thetaX,thetaY] per node. Curvatures are
 * [thetaY,x, -thetaX,y, thetaY,y-thetaX,x]. Physical engineering shears are
 * [w,x+thetaY, w,y-thetaX]. Db already includes t³/12; Ds includes k*t.
 *
 * Interpolate covariant edge shears, then apply J⁻ᵀ at each Gauss point.
 * Interpolating physical shear components directly would fail on skewed cells.
 * Both bending and assumed shear use 2×2 integration, with no hourglass term.
 */
export function quadPlateK(uv: Quad, Db: Matrix, Ds: readonly [number, number]): number[][] {
  validateQuad(uv); validateMatrix(Db, 3);
  if (Ds.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid plate shear stiffness.');
  const K = zeros(12, 12);
  const bottom = covariantShear(mapping(uv, 0, -1), 'xi');
  const top = covariantShear(mapping(uv, 0, 1), 'xi');
  const left = covariantShear(mapping(uv, -1, 0), 'eta');
  const right = covariantShear(mapping(uv, 1, 0), 'eta');
  for (const xi of GP) for (const eta of GP) {
    const g = mapping(uv, xi, eta), Bb = zeros(3, 12), Bs = zeros(2, 12);
    for (let i = 0; i < 4; i++) {
      Bb[0][3 * i + 2] = g.dx[i]; Bb[1][3 * i + 1] = -g.dy[i];
      Bb[2][3 * i + 2] = g.dy[i]; Bb[2][3 * i + 1] = -g.dx[i];
    }
    for (let i = 0; i < 12; i++) {
      const covXi = ((1 - eta) * bottom[i] + (1 + eta) * top[i]) / 2;
      const covEta = ((1 - xi) * left[i] + (1 + xi) * right[i]) / 2;
      Bs[0][i] = (g.yEta * covXi - g.yXi * covEta) / g.det;
      Bs[1][i] = (-g.xEta * covXi + g.xXi * covEta) / g.det;
    }
    accumulate(K, Bb, product(Db, Bb), g.det);
    accumulate(K, Bs, [Bs[0].map(v => Ds[0] * v), Bs[1].map(v => Ds[1] * v)], g.det);
  }
  return K;
}

function validateThickness(thickness: number): void {
  if (!(thickness > 0) || !Number.isFinite(thickness))
    throw new Error('Extruded hexahedron thickness must be finite and positive.');
}

/** Insert the symmetric gradient of a displacement triple, engineering shear. */
function strainColumns(B: number[][], column: number, dx: number, dy: number, dz: number): void {
  B[0][column] = dx; B[1][column + 1] = dy; B[2][column + 2] = dz;
  B[3][column + 1] = dz; B[3][column + 2] = dy;
  B[4][column] = dz; B[4][column + 2] = dx;
  B[5][column] = dy; B[5][column + 1] = dx;
}

function hexCompatibleB(g: QuadMap, thickness: number, zeta: number): number[][] {
  const B = zeros(6, 24);
  for (let i = 0; i < 8; i++) {
    const zSign = i < 4 ? -1 : 1, n = i % 4, factor = (1 + zSign * zeta) / 2;
    strainColumns(B, 3 * i, g.dx[n] * factor, g.dy[n] * factor, g.N[n] * zSign / thickness);
  }
  return B;
}

/**
 * Enhanced gradients = det(J0)/det(J) * J0⁻ᵀ * grad(1-naturalCoordinate²).
 * The volume integral of every column is zero even on a distorted cell, since
 * det(J) cancels and the remaining natural coordinate is odd. Constant stress
 * consequently cannot excite the modes (the constant-strain patch test).
 */
function hexEnhancedB(
  g: QuadMap, centre: QuadMap, thickness: number, xi: number, eta: number, zeta: number,
): number[][] {
  const B = zeros(6, 9), ratio = centre.det / g.det;
  strainColumns(B, 0, -2 * xi * centre.yEta / centre.det * ratio,
    2 * xi * centre.xEta / centre.det * ratio, 0);
  strainColumns(B, 3, 2 * eta * centre.yXi / centre.det * ratio,
    -2 * eta * centre.xXi / centre.det * ratio, 0);
  strainColumns(B, 6, 0, 0, -4 * zeta / thickness * ratio);
  return B;
}

/** Solve A X = rhs with diagonal equilibration and Cholesky. Never regularize. */
function solvePositive(A: Matrix, rhs: Matrix): number[][] {
  const n = A.length, columns = rhs[0].length, L = zeros(n, n);
  const scale = A.map((row, i) => Math.sqrt(row[i]));
  if (scale.some(v => !(v > 0) || !Number.isFinite(v)))
    throw new Error('Invalid incompatible-mode stiffness; check element geometry and material.');
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let v = A[i][j] / (scale[i] * scale[j]);
    for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
    if (i === j) {
      if (!(v > 64 * Number.EPSILON))
        throw new Error('Singular incompatible-mode stiffness; check element geometry and material.');
      L[i][j] = Math.sqrt(v);
    } else L[i][j] = v / L[j][j];
  }
  const X = zeros(n, columns);
  for (let col = 0; col < columns; col++) {
    const y = new Array(n).fill(0), x = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let v = rhs[i][col] / scale[i];
      for (let j = 0; j < i; j++) v -= L[i][j] * y[j];
      y[i] = v / L[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = y[i];
      for (let j = i + 1; j < n; j++) v -= L[j][i] * x[j];
      x[i] = v / L[i][i]; X[i][col] = x[i] / scale[i];
    }
  }
  return X;
}

function hexSystem(uv: Quad, thickness: number, D: Matrix): {
  Kuu: number[][]; Kua: number[][]; modeFromNodal: number[][];
} {
  const Kuu = zeros(24, 24), Kua = zeros(24, 9), Kaa = zeros(9, 9);
  const centre = mapping(uv, 0, 0);
  for (const xi of GP) for (const eta of GP) for (const zeta of GP) {
    const g = mapping(uv, xi, eta), weight = g.det * thickness / 2;
    const Bu = hexCompatibleB(g, thickness, zeta);
    const Ba = hexEnhancedB(g, centre, thickness, xi, eta, zeta);
    const DBu = product(D, Bu), DBa = product(D, Ba);
    accumulate(Kuu, Bu, DBu, weight);
    accumulate(Kua, Bu, DBa, weight);
    accumulate(Kaa, Ba, DBa, weight);
  }
  const Kau = Array.from({ length: 9 }, (_, i) => Kua.map(row => row[i]));
  return { Kuu, Kua, modeFromNodal: solvePositive(Kaa, Kau) };
}

/**
 * 24×24 H8 stiffness: bottom Q4 then top Q4, [u,v,w] per node. Full 2×2×2
 * integration and nine statically condensed enhanced modes. The constant-J
 * rectangular limit equals the existing Wilson incompatible-mode kernel.
 * Distorted cells still need refinement for bending accuracy; the modes do not
 * remove all distortion sensitivity or supply incompressible-material modes.
 */
export function extrudedHexK(uv: Quad, thickness: number, D: Matrix): number[][] {
  validateQuad(uv); validateThickness(thickness); validateMatrix(D, 6);
  const { Kuu, Kua, modeFromNodal } = hexSystem(uv, thickness, D);
  for (let r = 0; r < 24; r++) for (let c = r; c < 24; c++) {
    let condensed = 0;
    for (let a = 0; a < 9; a++) condensed += Kua[r][a] * modeFromNodal[a][c];
    const value = Kuu[r][c] - condensed;
    Kuu[r][c] = value; Kuu[c][r] = value;
  }
  return Kuu;
}

/**
 * Recover [ex,ey,ez,gamma_yz,gamma_xz,gamma_xy]. Enhanced modes vanish at the
 * default centre point, where D is optional. At any other natural point D is
 * required so alpha = -Kaa⁻¹ Kau u can be recovered from the same formulation
 * used for stiffness. A single centre value is not a surface stress maximum.
 */
export function extrudedHexStrain(
  uv: Quad, thickness: number, localDisplacements: ArrayLike<number>, D?: Matrix,
  point: readonly [number, number, number] = [0, 0, 0],
): HexStrain {
  validateQuad(uv); validateThickness(thickness); naturalPoint(...point);
  if (localDisplacements.length !== 24 || Array.from(localDisplacements).some(v => !Number.isFinite(v)))
    throw new Error('An H8 element needs 24 finite local displacements.');
  const [xi, eta, zeta] = point;
  const g = mapping(uv, xi, eta), Bu = hexCompatibleB(g, thickness, zeta);
  const strain = Bu.map(row => row.reduce((s, b, i) => s + b * localDisplacements[i], 0)) as HexStrain;
  if (xi !== 0 || eta !== 0 || zeta !== 0) {
    if (!D) throw new Error('A constitutive matrix is required for noncentral enhanced-strain recovery.');
    validateMatrix(D, 6);
    const { modeFromNodal } = hexSystem(uv, thickness, D);
    const alpha = modeFromNodal.map(row => -row.reduce((s, v, i) => s + v * localDisplacements[i], 0));
    const Ba = hexEnhancedB(g, mapping(uv, 0, 0), thickness, xi, eta, zeta);
    for (let r = 0; r < 6; r++) for (let a = 0; a < 9; a++) strain[r] += Ba[r][a] * alpha[a];
  }
  return strain;
}
