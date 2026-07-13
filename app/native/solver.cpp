// solver.cpp — Eigen SimplicialLDLT sparse direct solver, compiled to WASM.
//
// Exposes a tiny embind API used by app/src/solverBackend.ts as an OPTIONAL
// fast backend for the assembly CAE linear solve (app/src/cae.ts). When this
// module fails to load, cae.ts falls back to the pure-TS Jacobi-PCG.
//
//   factorize(n, indptr, indices, data) -> bool   // symbolic + numeric factor
//   solve(rhs)                          -> Float64Array
//   dispose()                           -> void    // free the factorization
//
// ── The CSR-loads-as-CSC trick ────────────────────────────────────────────
// The caller hands us the assembly stiffness matrix in CSR (row pointer,
// column indices, values) — the format cae.ts already builds. Eigen's
// SparseMatrix<double> defaults to COLUMN-MAJOR (CSC), and its
// {outerIndexPtr, innerIndexPtr, valuePtr} layout is byte-for-byte identical
// to CSR when you reinterpret "rows" as "columns".
//
// The assembly stiffness matrix is SYMMETRIC (it's an FE stiffness matrix:
// K = Kᵀ), so its CSC representation equals its CSR representation. Therefore
// the caller's CSR arrays load DIRECTLY as Eigen CSC with no transpose. We
// document that assumption here and, in a debug build, cheaply assert
// symmetry on a sample of entries.
//
// SimplicialLDLT (not LLT) is deliberate: the penalty-conditioned system can
// have near-singular / tiny pivots from soft-grounding regularization, and
// LDLT's D factor tolerates non-positive-definite wobble that would make a
// plain Cholesky (LLT) bail.

#include <Eigen/Sparse>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>
#include <cstdint>

using namespace emscripten;

using SpMat = Eigen::SparseMatrix<double>;   // column-major (CSC) by default
using Solver = Eigen::SimplicialLDLT<SpMat>;

namespace {

// The single live factorization. One module instance solves one system at a
// time (the CAE calls factorize → solve → dispose serially). Kept as a raw
// owning pointer so dispose() can release it deterministically.
Solver* g_solver = nullptr;
SpMat*  g_matrix = nullptr;   // must outlive the solver (LDLT references it)
int     g_n = 0;
bool    g_ok = false;

// Copy a JS TypedArray into a std::vector. embind hands typed arrays across as
// emscripten::val; convertJSArrayToNumberVector does the marshalling.
template <typename T>
std::vector<T> toVec(const val& arr) {
  return convertJSArrayToNumberVector<T>(arr);
}

}  // namespace

// Build the CSC (== CSR, symmetric) matrix and compute the LDLT factorization.
// Returns false if the numeric factorization fails (Eigen sets a non-Success
// info code) so the JS side can fall back to PCG.
bool factorize(int n, val indptrV, val indicesV, val dataV) {
  // Fresh state every call.
  delete g_solver; g_solver = nullptr;
  delete g_matrix; g_matrix = nullptr;
  g_ok = false;
  g_n = n;
  if (n <= 0) return false;

  std::vector<int32_t>  indptr  = toVec<int32_t>(indptrV);
  std::vector<int32_t>  indices = toVec<int32_t>(indicesV);
  std::vector<double>   data    = toVec<double>(dataV);

  if ((int)indptr.size() != n + 1) return false;
  const int nnz = indptr[n];
  if ((int)indices.size() < nnz || (int)data.size() < nnz) return false;

  // Assemble directly into Eigen's internal CSC storage. We map the CSR arrays
  // as CSC: outer = row/col pointer (n+1), inner = col/row indices (nnz),
  // values = data. Because K is symmetric this is exactly K in CSC.
  g_matrix = new SpMat(n, n);
  g_matrix->reserve(nnz);
  // Fill via triplets? No — for up to ~60k DOF the direct CSC construction is
  // fastest and avoids doubling memory. We build the internal arrays by hand.
  {
    // Eigen's makeCompressed layout: use setFromTriplets is simplest & robust
    // across Eigen minor versions; the extra pass is cheap next to the factor.
    std::vector<Eigen::Triplet<double>> trips;
    trips.reserve(nnz);
    for (int col = 0; col < n; ++col) {
      for (int k = indptr[col]; k < indptr[col + 1]; ++k) {
        trips.emplace_back(indices[k], col, data[k]);
      }
    }
    g_matrix->setFromTriplets(trips.begin(), trips.end());
  }
  g_matrix->makeCompressed();

#ifndef NDEBUG
  // Cheap symmetry sanity check on a handful of off-diagonal entries: for a
  // sampled (i,j) look up (j,i) and compare. A gross asymmetry means the
  // CSR-as-CSC assumption is being violated by the caller.
  {
    int checked = 0;
    for (int col = 0; col < n && checked < 64; ++col) {
      for (SpMat::InnerIterator it(*g_matrix, col); it; ++it) {
        int row = it.row();
        if (row == col) continue;
        double aij = it.value();
        double aji = g_matrix->coeff(col, row);
        double denom = std::abs(aij) + std::abs(aji) + 1e-12;
        if (std::abs(aij - aji) / denom > 1e-6) {
          // Not fatal (release ignores it) — just a debug signal.
          emscripten::val::global("console").call<void>(
            "warn", std::string("[eigen-solver] asymmetry at (") +
              std::to_string(row) + "," + std::to_string(col) + ")");
        }
        if (++checked >= 64) break;
      }
    }
  }
#endif

  g_solver = new Solver();
  g_solver->compute(*g_matrix);
  g_ok = (g_solver->info() == Eigen::Success);
#ifdef EIGEN_SOLVER_DIAG
  if (!g_ok) {
    emscripten::val::global("console").call<void>(
      "error", std::string("[eigen-solver] compute info=") +
        std::to_string((int)g_solver->info()) + " n=" + std::to_string(n) +
        " nnz=" + std::to_string(nnz));
  }
#endif
  return g_ok;
}

// Solve K x = rhs using the stored factorization. Returns a fresh Float64Array
// (JS) of length n. On any failure returns an empty array so JS can detect it.
val solve(val rhsV) {
  if (!g_ok || !g_solver) return val::array();
  std::vector<double> rhs = toVec<double>(rhsV);
  if ((int)rhs.size() != g_n) return val::array();

  Eigen::Map<const Eigen::VectorXd> b(rhs.data(), g_n);
  Eigen::VectorXd x = g_solver->solve(b);
  if (g_solver->info() != Eigen::Success) return val::array();

  // Copy result into a JS Float64Array via the memory view.
  return val(typed_memory_view(g_n, x.data())).call<val>("slice");
}

// Release the factorization + matrix. Safe to call repeatedly.
void dispose() {
  delete g_solver; g_solver = nullptr;
  delete g_matrix; g_matrix = nullptr;
  g_ok = false;
  g_n = 0;
}

EMSCRIPTEN_BINDINGS(eigen_solver) {
  function("factorize", &factorize);
  function("solve", &solve);
  function("dispose", &dispose);
}
