"""
End-to-end Playwright drive for the CAE MESH + CONSTRAINT view.

Loads the plywood workbench, switches to Analysis mode, detects joints, and
checks the three things the mesh view has to get right:

  1. PRE-SOLVE the FE mesh and the solver's real boundary conditions are
     drawn and reported (element/node/DOF counts, fixed nodes, joint
     couplings, loaded nodes) — before anything is solved.
  2. The mesh REBUILDS at a new density and the counts move with it, and
     switching to solid (hex) elements changes the element family + DOF.
  3. POST-SOLVE the mesh is contoured, the colour-bar legend appears with the
     field max, and the deformed-shape scale is live.

Run:  python tests/cae_mesh_drive.py
Output: tests/_output/cae_mesh_drive/
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SAMPLE = REPO / "samlple step files" / "plywood workbench.stp"
OUT = REPO / "tests" / "_output" / "cae_mesh_drive"


def stats_text(page) -> str:
    return " ".join((page.inner_text("#asmMeshStats") or "").split())


def shot_viewer(page, path: Path):
    """Capture the 3D pane.

    Locator.screenshot() waits for the element to be "stable", which a viewer
    driving a requestAnimationFrame render loop never is — the canvas is
    repainting every frame by design. Clip the page instead.
    """
    box = page.locator("#viewerWrap").bounding_box()
    if not box:
        raise RuntimeError("#viewerWrap has no bounding box")
    page.screenshot(path=str(path), clip=box)


def parse_counts(txt: str) -> dict:
    """Pull the numbers out of the mesh stats line."""
    out = {}
    m = re.search(r"([\d,]+)\s+(quad|hex)", txt)
    if m:
        out["elems"] = int(m.group(1).replace(",", ""))
        out["kind"] = m.group(2)
    m = re.search(r"([\d,]+)\s+nodes", txt)
    if m:
        out["nodes"] = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+DOF", txt)
    if m:
        out["dof"] = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+fixed nodes", txt)
    if m:
        out["fixed"] = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+couplings", txt)
    if m:
        out["couplings"] = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,]+)\s+loaded nodes", txt)
    if m:
        out["loaded"] = int(m.group(1).replace(",", ""))
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    proc, port = boot_dev_server()
    problems = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))

            page.goto(f"http://localhost:{port}", wait_until="networkidle")
            page.set_input_files("#fileInput", str(SAMPLE))
            page.wait_for_function(
                "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
                timeout=45_000,
            )
            page.wait_for_timeout(1200)
            page.select_option("#units", "mm")
            page.click("#selectAllBtn")
            page.wait_for_timeout(400)
            page.click("#modeAnalysisBtn")
            page.wait_for_timeout(300)

            # ---------------------------------------------------------------
            # 1. Detect joints → mesh + constraints must appear WITHOUT a solve
            # ---------------------------------------------------------------
            page.click("#asmDetectBtn")
            page.wait_for_timeout(2500)

            pre = parse_counts(stats_text(page))
            print(f"[pre-solve] mesh stats = {pre}")
            for key in ("elems", "nodes", "dof", "fixed", "couplings"):
                if not pre.get(key):
                    problems.append(f"pre-solve mesh stats missing/zero: {key} ({stats_text(page)!r})")
            if pre.get("kind") != "quad":
                problems.append(f"default element family should be quad, got {pre.get('kind')}")
            if pre.get("dof") and pre.get("nodes") and pre["dof"] != pre["nodes"] * 6:
                problems.append(f"shell DOF should be 6/node: {pre['dof']} vs {pre['nodes']}*6")

            page.screenshot(path=str(OUT / "01_mesh_presolve.png"))
            shot_viewer(page, OUT / "01_mesh_presolve_3d.png")

            # Toggle nodes on, mesh off → constraint glyphs only.
            page.check("#asmShowNodes")
            page.wait_for_timeout(600)
            shot_viewer(page, OUT / "02_mesh_with_nodes.png")
            page.uncheck("#asmShowMesh")
            page.wait_for_timeout(600)
            shot_viewer(page, OUT / "03_constraints_only.png")
            page.check("#asmShowMesh")
            page.uncheck("#asmShowNodes")
            page.wait_for_timeout(400)

            # ---------------------------------------------------------------
            # 2. Density + element-family changes rebuild the mesh
            # ---------------------------------------------------------------
            # The achieved element size must land close to the requested one —
            # that's the whole point of specifying a size instead of a density.
            # A request finer than the DOF ceiling allows may be coarsened, but
            # ONLY if the stats line says so; silent coarsening is the bug.
            sizes = {}
            for want in (30, 20, 15):
                page.select_option("#asmMeshDensity", str(want))
                page.wait_for_timeout(3500)
                txt = stats_text(page)
                got = parse_counts(txt)
                m = re.search(r"element (?:≤ )?([\d.]+)(?:–([\d.]+))? mm", txt)
                if not m:
                    problems.append(f"no element size reported at {want} mm: {txt!r}")
                    continue
                lo, hi = float(m.group(1)), float(m.group(2) or m.group(1))
                capped = "coarsened" in txt
                sizes[want] = got.get("nodes", 0)
                print(f"[size {want} mm] achieved {lo}–{hi} mm, {got.get('nodes')} nodes, capped={capped}")
                # Only the UPPER bound matters. Small panels are clamped to a
                # minimum of 4 nodes per side, so they legitimately come out
                # FINER than the request — that's the mesher refusing to model a
                # rail with two elements, not a failure to honour the size.
                if not capped and hi > want * 1.35:
                    problems.append(f"requested {want} mm elements but got up to {hi} mm (not reported as capped)")

            # Finer request => strictly more nodes, as long as it wasn't capped.
            if sizes.get(15, 0) <= sizes.get(30, 0):
                problems.append(f"15 mm mesh not finer than 30 mm: {sizes}")
            shot_viewer(page, OUT / "04_mesh_fine.png")

            # A request the ceiling cannot honour must SAY it was coarsened.
            page.select_option("#asmMeshDensity", "5")
            page.wait_for_timeout(4000)
            txt5 = stats_text(page)
            print(f"[size 5 mm] {txt5}")
            m5 = re.search(r"element (?:≤ )?([\d.]+)(?:–([\d.]+))? mm", txt5)
            if m5 and float(m5.group(2) or m5.group(1)) > 5 * 1.35 and "coarsened" not in txt5:
                problems.append(f"5 mm request silently coarsened without a notice: {txt5!r}")

            page.select_option("#asmMeshDensity", "20")
            page.wait_for_timeout(3000)

            # Solid (hex) elements: family changes, DOF becomes 3/node.
            page.select_option("#asmMeshKind", "solid")
            page.wait_for_timeout(3000)
            solid = parse_counts(stats_text(page))
            print(f"[solid] mesh stats = {solid}")
            if solid.get("kind") != "hex":
                problems.append(f"solid mode should report hex elements, got {solid.get('kind')}")
            if solid.get("dof") and solid.get("nodes") and solid["dof"] != solid["nodes"] * 3:
                problems.append(f"solid DOF should be 3/node: {solid['dof']} vs {solid['nodes']}*3")
            layers_visible = page.evaluate(
                "() => document.getElementById('asmSolidLayersRow')?.offsetParent !== null"
            )
            if not layers_visible:
                problems.append("through-thickness Layers control not shown in solid mode")
            shot_viewer(page, OUT / "05_mesh_solid.png")

            page.select_option("#asmMeshKind", "shell")
            page.wait_for_timeout(2500)

            # ---------------------------------------------------------------
            # 3. Solve → contoured mesh + colour bar + deform scale
            # ---------------------------------------------------------------
            page.click("#asmPreset50")
            page.wait_for_timeout(800)
            post_load = parse_counts(stats_text(page))
            print(f"[after load preset] loaded nodes = {post_load.get('loaded')}")
            if not post_load.get("loaded"):
                problems.append("load preset produced no loaded nodes in the constraint view")

            page.click("#asmSolveBtn")
            page.wait_for_function(
                "() => { const t = document.getElementById('asmResult')?.textContent || '';"
                "        return /Max deflection/.test(t); }",
                timeout=300_000,
            )
            page.wait_for_timeout(1500)

            result = " ".join((page.inner_text("#asmResult") or "").split())
            print(f"[solve] {result}")

            legend = " ".join((page.inner_text(".cae-legend3d") or "").split())
            print(f"[legend] {legend!r}")
            if "deflection" not in legend.lower():
                problems.append(f"legend missing deflection caption: {legend!r}")
            if not re.search(r"\d", legend):
                problems.append(f"legend missing a numeric max: {legend!r}")
            if "max" not in legend.lower() or "min" not in legend.lower():
                problems.append(f"legend missing max/min extremes: {legend!r}")

            # The on-canvas legend must be over the 3D view, and the cut-layout
            # half must be gone in Analysis mode.
            layout_visible = page.evaluate(
                "() => document.getElementById('layoutPane')?.offsetParent !== null"
            )
            if layout_visible:
                problems.append("Cut layout pane still visible in Analysis mode")
            callouts = page.locator(".cae-callout").count()
            print(f"[callouts] {callouts}")
            if callouts < 1:
                problems.append("no MAX/MIN callout rendered on the solved mesh")

            # Legend customisation: open the gear, switch map + banding, and
            # confirm the legend re-renders with the new band count.
            page.click(".cae-legend3d-gear")
            page.wait_for_timeout(400)
            if page.locator(".cae-legend3d-pop").count() < 1:
                problems.append("legend settings popover did not open")
            else:
                page.select_option('.cae-legend3d-pop [data-lg="map"]', "viridis")
                page.wait_for_timeout(500)
                page.select_option('.cae-legend3d-pop [data-lg="bands"]', "5")
                page.wait_for_timeout(600)
                bands = page.locator(".cae-legend3d-row").count()
                print(f"[legend] rows after 5-band select = {bands}")
                if bands != 6:   # 5 bands + the lower-edge row
                    problems.append(f"5-band legend should show 6 rows, got {bands}")
                page.screenshot(path=str(OUT / "06b_legend_popover.png"))
                page.select_option('.cae-legend3d-pop [data-lg="bands"]', "0")
                page.wait_for_timeout(500)
                if page.locator(".cae-legend3d-grad").count() < 1:
                    problems.append("smooth legend did not render a gradient bar")
                page.select_option('.cae-legend3d-pop [data-lg="bands"]', "12")
                page.select_option('.cae-legend3d-pop [data-lg="map"]', "rainbow")
                page.wait_for_timeout(500)
                page.mouse.click(700, 950)   # dismiss the popover
                page.wait_for_timeout(300)
            deform_visible = page.evaluate(
                "() => document.getElementById('asmDeformRow')?.offsetParent !== null"
            )
            if not deform_visible:
                problems.append("deformed-shape scale row not shown after solve")

            shot_viewer(page, OUT / "06_solved_mesh_deflection.png")
            page.screenshot(path=str(OUT / "06_solved_full.png"))

            # Stress field → legend caption + max must follow.
            page.click("#asmFieldStress")
            page.wait_for_timeout(1200)
            legend_s = " ".join((page.inner_text(".cae-legend3d") or "").split())
            print(f"[legend:stress] {legend_s!r}")
            if "mises" not in legend_s.lower() or "MPa" not in legend_s:
                problems.append(f"stress legend wrong: {legend_s!r}")
            shot_viewer(page, OUT / "07_solved_mesh_stress.png")

            # Deformed shape off vs exaggerated.
            page.click("#asmFieldDefl")
            page.wait_for_timeout(600)
            page.select_option("#asmDeformScale", "0")
            page.wait_for_timeout(900)
            shot_viewer(page, OUT / "08_deform_off.png")
            page.select_option("#asmDeformScale", "auto")
            page.wait_for_timeout(900)
            shot_viewer(page, OUT / "09_deform_auto.png")

            # ---------------------------------------------------------------
            # 4. SOLID solve — the hex path has to run end-to-end in the browser
            #    and land in the same ballpark as the shell answer.
            # ---------------------------------------------------------------
            shell_defl = float(re.search(r"Max deflection ([\d.]+) mm", result).group(1))

            page.select_option("#asmMeshKind", "solid")
            page.wait_for_timeout(3000)
            page.click("#asmSolveBtn")
            page.wait_for_function(
                "() => { const t = document.getElementById('asmResult')?.textContent || '';"
                "        return /Max deflection/.test(t); }",
                timeout=600_000,
            )
            page.wait_for_timeout(2000)
            solid_result = " ".join((page.inner_text("#asmResult") or "").split())
            solid_stats = parse_counts(stats_text(page))
            print(f"[solid solve] {solid_result}")
            print(f"[solid solve] mesh = {solid_stats}")

            m = re.search(r"Max deflection ([\d.]+) mm", solid_result)
            if not m:
                problems.append(f"solid solve produced no deflection: {solid_result!r}")
            else:
                solid_defl = float(m.group(1))
                ratio = solid_defl / (shell_defl or 1)
                print(f"[solid solve] shell {shell_defl} mm vs solid {solid_defl} mm → ratio {ratio:.3f}")
                if not (0.5 < ratio < 2.5):
                    problems.append(
                        f"solid deflection {solid_defl} mm is not in the same range as shell {shell_defl} mm"
                    )
            if solid_stats.get("kind") != "hex":
                problems.append(f"solved solid mesh should report hex, got {solid_stats.get('kind')}")
            shot_viewer(page, OUT / "11_solid_solved.png")
            page.screenshot(path=str(OUT / "12_solid_full.png"))

            page.screenshot(path=str(OUT / "10_sidebar_final.png"))
            (OUT / "console.log").write_text("\n".join(console), encoding="utf-8")

            ctx.close()
            browser.close()
    finally:
        kill_dev_server(proc)

    print("\n=== RESULT ===")
    if problems:
        for pr in problems:
            print(f"  FAIL: {pr}")
        return 1
    print("all CAE mesh-view checks PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
