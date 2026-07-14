# PyNite structural-FE sidecar

A small local [FastAPI](https://fastapi.tiangolo.com/) service that solves the
Woodworking Companion **assembly** structural model with
[PyNite](https://github.com/JWock82/Pynite) (open-source Python finite-element)
and returns nodal displacements. When it's running the web app uses it as the
**primary** assembly CAE solver; when it isn't, the app transparently falls back
to its built-in Eigen-LDLT (WASM) → Jacobi-PCG chain, so the app works with or
without this sidecar.

## Install & run

```bash
python -m pip install -r server/requirements.txt      # PyNite, FastAPI, numpy, scipy, uvicorn
python -m uvicorn server.main:app --port 8642         # from the repo root
```

`launch.bat` / `launch.command` start this automatically **if** PyNite is
installed (and print a one-line hint if it isn't). The app detects it via
`GET /health` once per session with a short timeout.

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/health`   | `{ "name": "pynite", "version": "<PyniteFEA version>" }` — liveness + identity. |
| POST   | `/solve`    | Takes the serialized assembly model (JSON), returns `{ ok, disp[], stats }`. `disp` is 6 values per node (DX DY DZ RX RY RZ, mm/rad) in node order. |
| GET    | `/progress` | A coarse `{ stage, pct }` hint for a progress bar (single-solve service). |

CORS allows any `localhost` / `127.0.0.1` origin (Vite dev ports vary).

## What the app sends, and how it's mapped to PyNite

The frontend (`app/src/cae.ts`) preprocesses the cabinet **exactly** as it does
for its own backends — per-panel quad meshes, 6 DOF/node, joint node-pair
couplings, floor grounding, nodal loads — then serialises that SAME model here
(`serializeAssembly`). The mapping:

| App concept            | PyNite mapping |
|------------------------|----------------|
| Mesh node (world mm)   | `add_node` |
| Panel quad element     | `add_quad` (MITC4 isoparametric plate/membrane, 6 DOF/node) |
| Panel material         | one **isotropic** material per panel (see fidelity note) |
| Rigid joint            | short stiff link **member**, full-stiffness section (couples all 6 DOF) |
| Semi-rigid joint       | link member, **5%** rotational section (reduced rotational stiffness) |
| Hinged joint           | link member, **0.1%** rotational section — a *regularised* near-hinge (a token rotational stiffness, mirroring the app's own hinge regularisation, so the seam is not a free numerical mechanism) |
| Floor grounding        | `def_support` — all 6 DOF fixed on floor-contact nodes |
| Patch / uniform load   | `add_node_load` — the app's consistent nodal world forces |

A joint's paired seam nodes are often (near-)coincident; a zero-length member is
degenerate in PyNite, so a coincident link's B-endpoint is nudged ~1 mm (sub-mm
on a shell — negligible, and displacements are read back by node id, not
position) to give the member a real length. A tiny **soft grounding spring** on
every DOF removes residual rigid-body / drilling mechanisms (the same trick the
app's PCG path uses).

After the solve the app maps the returned displacement vector straight back into
its DOF vector and runs its **existing** stress recovery + verdicts — the
sidecar only replaces the linear solve.

## Fidelity note — "PyNite (isotropic E_eff)"

PyNite's quad plate takes a **single** Young's modulus (isotropic). Plywood is
orthotropic (stiffer along the face grain than across). Each panel is therefore
mapped with an **effective modulus**

```
E_eff = sqrt(E_along * E_across),    nu ~= 0.3
```

which is the geometric mean of the two grain-direction moduli. This is a
faithful *average* stiffness but it does not capture grain directionality, so
PyNite results differ modestly from the app's own orthotropic Mindlin solver
(the validation harness uses looser tolerances for the PyNite backend: rigid
seam ≈ continuous within 15%, stress within 20%). The result line and PDF name
the backend **"PyNite (isotropic E_eff)"** so this approximation is always
visible to the user.

## Validation

- `python tests/pynite_check.py` — boots this sidecar as a subprocess, runs
  `tests/cae_check.ts` with it up (the PyNite assembly cases e/f/g run), then
  kills it. CI-style single command.
- `cd app && npx tsx ../tests/cae_check.ts` — with the sidecar running, adds the
  PyNite backend to the assembly-case sweep and prints the PyNite-vs-Eigen
  deltas (case e + a 5-panel workbench box). With it down, only Eigen/PCG run.
