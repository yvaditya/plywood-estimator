/**
 * Ambient types for the emscripten-generated `eigen-solver.js` ES module.
 * The .js is built from app/native/solver.cpp (see app/native/README.md); this
 * hand-written declaration describes only the surface solverBackend.ts uses.
 */

/** The embind module instance returned by the factory. */
export interface EigenSolverModule {
  /** Factorize a symmetric CSR (== CSC) SPD system. false on numeric failure. */
  factorize(n: number, indptr: Int32Array, indices: Int32Array, data: Float64Array): boolean;
  /** Solve K x = rhs with the stored factorization (empty array on failure). */
  solve(rhs: Float64Array): Float64Array;
  /** Release the factorization + matrix. */
  dispose(): void;
}

/** Options accepted by the emscripten module factory (subset we pass). */
export interface EigenSolverModuleOptions {
  locateFile?: (path: string, scriptDirectory: string) => string;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;
  [key: string]: unknown;
}

/** MODULARIZE + EXPORT_ES6 default export: an async factory. */
declare function createEigenSolver(
  options?: EigenSolverModuleOptions,
): Promise<EigenSolverModule>;

export default createEigenSolver;
