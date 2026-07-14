"""
PyNite structural-FE sidecar for Woodworking Companion.

A small FastAPI service that solves an ASSEMBLY flat-shell model with PyNite
(https://github.com/JWock82/Pynite) and returns nodal displacements. The
frontend (app/src/) preprocesses the cabinet exactly as it does for its own
Eigen/PCG backends (per-panel quad meshes, 6 DOF/node, joint node-pair links,
floor grounding, nodal loads) and serialises that SAME model here. We map it to
PyNite, run one linear static solve, and hand the 6-DOF-per-node displacement
vector back. The app then runs its EXISTING stress recovery + verdicts on those
displacements — unchanged — so the only thing PyNite replaces is the linear
solve.

Fidelity note (documented in README.md too): PyNite's isotropic quad plate
takes a single Young's modulus, so an orthotropic plywood panel is mapped with
an effective modulus  E_eff = sqrt(E_along * E_across)  and poisson ~0.3. The
result line therefore names the backend "PyNite (isotropic E_eff)". Joints are
mapped as short stiff link MEMBERS between the app's paired seam nodes:
  rigid       -> full-stiffness section (couples all 6 DOF)
  semi-rigid  -> 5%  rotational section  (reduced rotational stiffness)
  hinged      -> 0.1% rotational section (a regularised near-hinge, mirroring
                 the app's own token-rotational-stiffness regularisation so the
                 seam is not a free numerical mechanism)
Floor grounding maps to fully-fixed node supports. A tiny soft grounding spring
on every DOF removes residual rigid-body / drilling mechanisms (the same trick
the app's PCG path uses).

Run:
  python -m pip install -r server/requirements.txt
  python -m uvicorn server.main:app --port 8642
"""
from __future__ import annotations

import logging
import math
import time
from typing import Dict, List, Optional

log = logging.getLogger("pynite_sidecar")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# PyNite import — the module is `Pynite` (package `PyniteFEA`).
from Pynite import FEModel3D

try:  # version, best-effort
    from importlib.metadata import version as _pkg_version

    PYNITE_VERSION = _pkg_version("PyniteFEA")
except Exception:  # pragma: no cover
    PYNITE_VERSION = "unknown"

BACKEND_NAME = "pynite"

# --- Link (joint) calibration constants. Tuned against the app's validation
#     cases (cae_check): a stiff, short (offset) link reproduces a continuous
#     panel to <1% (case e); scaling the section's second moment of area gives
#     monotonic rigid < semi-rigid < hinged (case f). No member end releases are
#     used — pure section scaling mirrors the app's kRot scaling and sidesteps
#     PyNite's singular-matrix behaviour when a seam's rotations are fully
#     released against otherwise-unconstrained nodes. ---
LINK_AREA = 1.0e5            # link cross-section area (mm^2) — axially near-rigid
LINK_I_BASE = 1.0e4          # base second moment for a RIGID link (mm^4)
LINK_STIFF_FRAC = {
    "rigid": 1.0,
    "semi-rigid": 0.05,      # 5% rotational stiffness
    "hinged": 0.001,         # 0.1% — a regularised near-hinge (not a free pin)
}
LINK_MIN_LEN = 0.5           # mm — below this a seam pair is "coincident"
LINK_OFFSET = 1.0            # mm — synthetic length given to a coincident link
# Per-DOF soft grounding spring — small enough to be negligible for a properly
# constrained DOF, present only to kill a residual drilling/rigid-body mode.
# (Correct joint coupling — not a strong soft spring — is what prevents a real
# sub-assembly from drifting; see the LINK_* section stiffnesses.)
SOFT_SPRING_ABS = 1.0e-4


# ---------------------------------------------------------------------------
# Request / response schema (mirrors app/src/cae.ts serialiseAssembly()).
# ---------------------------------------------------------------------------
class Material(BaseModel):
    name: str
    E: float            # effective Young's modulus (MPa == N/mm^2)
    G: float            # shear modulus (MPa)
    nu: float           # Poisson's ratio
    rho: float          # density (kg/m^3)


class Quad(BaseModel):
    # Node indices (into `nodes`) in i, j, m, n order (CCW), the panel's
    # thickness and the material name it references.
    n: List[int]
    t: float
    mat: str


class Link(BaseModel):
    a: int              # node index on panel A
    b: int              # node index on panel B
    stiffness: str      # 'rigid' | 'semi-rigid' | 'hinged'


class Load(BaseModel):
    node: int
    fx: float
    fy: float
    fz: float


class Model(BaseModel):
    # World node positions, mm: nodes[i] = [X, Y, Z].
    nodes: List[List[float]]
    materials: List[Material]
    quads: List[Quad]
    links: List[Link]
    supports: List[int]   # node indices fully fixed (all 6 DOF)
    loads: List[Load]
    # Per-DOF soft grounding-spring stiffness the app's own solver uses — pins
    # residual rigid-body / weakly-coupled modes identically to cae.ts. Optional
    # (falls back to a tiny absolute value) for older/hand-built payloads.
    kSoft: float = 1.0e-4


class SolveStats(BaseModel):
    backend: str
    version: str
    nodes: int
    quads: int
    links: int
    supports: int
    dof: int
    buildMs: float
    solveMs: float
    label: str            # e.g. "PyNite (isotropic E_eff)"


class SolveResponse(BaseModel):
    ok: bool
    message: Optional[str] = None
    # Flat displacement vector, 6 per node in node order:
    #   [DX0,DY0,DZ0,RX0,RY0,RZ0, DX1,...]  (mm / rad)
    disp: List[float]
    stats: Optional[SolveStats] = None


app = FastAPI(title="Woodworking Companion — PyNite sidecar")

# Vite dev ports vary (5173, 5174, ...) and the test harness picks a free port,
# so allow any localhost/127.0.0.1 origin via a regex.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-flight progress (single-solve service). The frontend can poll /progress to
# animate an indeterminate bar; it also just shows a pulse, so this is a hint.
_progress: Dict[str, object] = {"stage": "idle", "pct": 0}


@app.get("/health")
def health() -> Dict[str, str]:
    """Liveness + identity. The frontend detects the sidecar via this."""
    return {"name": BACKEND_NAME, "version": PYNITE_VERSION}


@app.get("/progress")
def progress() -> Dict[str, object]:
    return dict(_progress)


@app.post("/solve", response_model=SolveResponse)
def solve(model: Model) -> SolveResponse:
    t0 = time.perf_counter()
    _progress.update(stage="building", pct=10)

    n_nodes = len(model.nodes)
    if n_nodes == 0:
        _progress.update(stage="idle", pct=0)
        return SolveResponse(ok=False, message="No nodes in model.", disp=[])

    m = FEModel3D()

    # --- Materials. PyNite plates are isotropic: E is the effective modulus
    #     the frontend already computed (sqrt(E_along*E_across)). ---
    for mat in model.materials:
        m.add_material(mat.name, mat.E, mat.G, mat.nu, mat.rho)

    # --- Nodes. Name = "N{index}" so we can map results back by index. ---
    for i, (X, Y, Z) in enumerate(model.nodes):
        m.add_node(f"N{i}", float(X), float(Y), float(Z))

    # --- Quads (flat-shell panels). PyNite's quad is a MITC4 isoparametric
    #     plate/membrane — 6 DOF/node, exactly the assembly the frontend built. ---
    for qi, q in enumerate(model.quads):
        i, j, k, l = q.n
        m.add_quad(
            f"Q{qi}", f"N{i}", f"N{j}", f"N{k}", f"N{l}",
            float(q.t), q.mat,
        )

    # --- Joint links. Between each app-paired seam node pair. When the pair is
    #     (near-)coincident we nudge the B endpoint by LINK_OFFSET mm so the
    #     member has a real length (a zero-length member is degenerate in
    #     PyNite). The nudge is sub-mm-to-mm on a shell — negligible — and
    #     displacements are read back by node id, not position. Each B node is
    #     offset at most once (idempotent) so multi-link seam nodes stay
    #     consistent. ---
    link_mat = model.materials[0].name if model.materials else None
    offset_done: set = set()
    for li, link in enumerate(model.links):
        a, b = link.a, link.b
        if a < 0 or b < 0 or a >= n_nodes or b >= n_nodes:
            continue
        na, nb = m.nodes[f"N{a}"], m.nodes[f"N{b}"]
        dxl = nb.X - na.X
        dyl = nb.Y - na.Y
        dzl = nb.Z - na.Z
        seg = math.sqrt(dxl * dxl + dyl * dyl + dzl * dzl)
        if seg < LINK_MIN_LEN and b not in offset_done:
            # Offset along the world axis with the smallest current separation
            # component so the link gains length without folding onto the seam.
            ax = min(range(3), key=lambda c: abs((dxl, dyl, dzl)[c]))
            if ax == 0:
                nb.X += LINK_OFFSET
            elif ax == 1:
                nb.Y += LINK_OFFSET
            else:
                nb.Z += LINK_OFFSET
            offset_done.add(b)

        frac = LINK_STIFF_FRAC.get(link.stiffness, 1.0)
        I = LINK_I_BASE * frac
        sec = f"lk{li}"
        m.add_section(sec, A=LINK_AREA, Iy=I, Iz=I, J=I)
        m.add_member(f"L{li}", f"N{a}", f"N{b}", link_mat, sec)

    # --- Floor grounding: fully fix all 6 DOF on grounded nodes. ---
    for s in model.supports:
        if 0 <= s < n_nodes:
            m.def_support(f"N{s}", True, True, True, True, True, True)

    # --- Soft grounding spring on every DOF. Use the stiffness the app's OWN
    #     solver uses (model.kSoft = repStiff·1e-4) so the sidecar regularizes a
    #     residual rigid-body / weakly-coupled-sub-assembly mode IDENTICALLY to
    #     cae.ts — strong enough to pin an orphan panel to a physical
    #     displacement, negligible for a properly-constrained DOF. Falls back to
    #     a tiny absolute value if the payload omits it. ---
    soft = model.kSoft if model.kSoft and model.kSoft > 0 else SOFT_SPRING_ABS
    for i in range(n_nodes):
        nm = f"N{i}"
        for dof in ("DX", "DY", "DZ", "RX", "RY", "RZ"):
            m.def_support_spring(nm, dof, soft)

    # --- Loads: world nodal forces (N). ---
    for load in model.loads:
        if not (0 <= load.node < n_nodes):
            continue
        nm = f"N{load.node}"
        if load.fx:
            m.add_node_load(nm, "FX", float(load.fx))
        if load.fy:
            m.add_node_load(nm, "FY", float(load.fy))
        if load.fz:
            m.add_node_load(nm, "FZ", float(load.fz))

    build_ms = (time.perf_counter() - t0) * 1000.0
    _progress.update(stage="solving", pct=55)
    log.info(
        "solve: %d nodes, %d quads, %d links, %d supports, %d loads",
        n_nodes, len(model.quads), len(model.links), len(model.supports), len(model.loads),
    )

    # --- Linear static solve, single load combo. Try the stability check first;
    #     if PyNite flags instability (a weakly-connected panel etc.), retry
    #     WITHOUT the check — the soft grounding springs already regularise the
    #     system, and the frontend's non-physical backstop catches any garbage. ---
    ts = time.perf_counter()
    try:
        m.analyze_linear(check_statics=False, check_stability=True, sparse=True)
    except Exception as exc:
        log.warning("stability-checked solve failed (%s) — retrying without stability check", exc)
        try:
            m.analyze_linear(check_statics=False, check_stability=False, sparse=True)
        except Exception as exc2:  # genuinely singular — let the frontend fall back.
            log.warning("solve failed: %s", exc2)
            _progress.update(stage="idle", pct=0)
            return SolveResponse(ok=False, message=f"PyNite solve failed: {exc2}", disp=[])
    solve_ms = (time.perf_counter() - ts) * 1000.0

    combo = next(iter(m.load_combos), None)
    if combo is None:
        # No explicit combo (e.g. zero load) — PyNite defaults to 'Combo 1'.
        combo = "Combo 1"

    _progress.update(stage="recovering", pct=90)

    disp: List[float] = [0.0] * (n_nodes * 6)
    for i in range(n_nodes):
        node = m.nodes[f"N{i}"]
        base = i * 6
        try:
            disp[base + 0] = float(node.DX[combo])
            disp[base + 1] = float(node.DY[combo])
            disp[base + 2] = float(node.DZ[combo])
            disp[base + 3] = float(node.RX[combo])
            disp[base + 4] = float(node.RY[combo])
            disp[base + 5] = float(node.RZ[combo])
        except (KeyError, TypeError):
            # Unsolved DOF (shouldn't happen) — leave zeros.
            pass

    _progress.update(stage="done", pct=100)

    stats = SolveStats(
        backend=BACKEND_NAME,
        version=PYNITE_VERSION,
        nodes=n_nodes,
        quads=len(model.quads),
        links=len(model.links),
        supports=len(model.supports),
        dof=n_nodes * 6,
        buildMs=build_ms,
        solveMs=solve_ms,
        label="PyNite (isotropic E_eff)",
    )
    return SolveResponse(ok=True, disp=disp, stats=stats)
