"""
End-to-end Playwright drive for the ASSEMBLY structural-analysis feature.

Loads the plywood workbench, selects all bodies, finds the new sidebar
"Analysis" section (below Estimate), runs Detect joints, flips one joint to
hinged, applies the "50 kg on top" preset, solves the assembly, asserts the
result line reports a max deflection + verdict, screenshots the heatmap + the
Analysis UI, exports the standalone analysis PDF and confirms content, and
checks the job-PDF gating (Structure + Assembly analysis appear ONLY after an
assembly solve).

Run:  python tests/asm_drive.py
Output: tests/_output/asm_drive/
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz  # PyMuPDF
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SAMPLE = REPO / "samlple step files" / "plywood workbench.stp"
OUT = REPO / "tests" / "_output" / "asm_drive"


def pdf_page_titles(pdf_path: Path):
    doc = fitz.open(str(pdf_path))
    titles = [" ".join(pg.get_text().split()) for pg in doc]
    n = doc.page_count
    doc.close()
    return n, titles


def has_section(titles, *names) -> bool:
    low = [t.lower() for t in titles]
    return any(any(nm.lower() in t for t in low) for nm in names)


def render_pages(pdf_path: Path, tag: str, dpi: int = 110):
    doc = fitz.open(str(pdf_path))
    for i, pg in enumerate(doc):
        pix = pg.get_pixmap(dpi=dpi)
        pix.save(str(OUT / f"{tag}_page-{i + 1:02d}.png"))
    doc.close()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    proc, port = boot_dev_server()
    problems = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(accept_downloads=True, viewport={"width": 1500, "height": 1000})
            page = ctx.new_page()
            console = []
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))

            # Robust download: register a persistent listener (expect_download
            # can race a slow, large PDF blob on headless Windows). Click, then
            # poll the captured download.
            pending = {"dl": None}
            page.on("download", lambda d: pending.__setitem__("dl", d))

            def download_to(click_selector, dest: Path, timeout_ms=300_000):
                pending["dl"] = None
                page.click(click_selector)
                waited = 0
                while pending["dl"] is None and waited < timeout_ms:
                    page.wait_for_timeout(500)
                    waited += 500
                if pending["dl"] is None:
                    raise TimeoutError(f"no download after {timeout_ms}ms for {click_selector}")
                pending["dl"].save_as(str(dest))
                return dest

            page.goto(f"http://localhost:{port}", wait_until="networkidle")
            page.set_input_files("#fileInput", str(SAMPLE))
            page.wait_for_function(
                "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
                timeout=45_000,
            )
            page.wait_for_timeout(1200)

            # mm so the "2" join tolerance is unambiguous.
            page.select_option("#units", "mm")
            page.wait_for_timeout(200)

            # Select all bodies.
            page.click("#selectAllBtn")
            page.wait_for_timeout(400)

            # --- The mode switch + Analysis section must exist. ---
            assert page.query_selector("#modeCutBtn") is not None, "Cut planning mode tab missing"
            assert page.query_selector("#modeAnalysisBtn") is not None, "Analysis mode tab missing"
            sec = page.query_selector('section.panel--group[data-group="analysis"]')
            assert sec is not None, "Analysis section not found"

            # --- Estimate FIRST (in Cut planning mode) so the PDF button enables. ---
            page.click("#nestBtn")
            page.wait_for_function(
                "() => !document.getElementById('downloadPdfBtn').disabled",
                timeout=120_000,
            )
            page.wait_for_timeout(600)

            # --- Switch to Analysis mode: cut-only groups must hide, Analysis
            #     group + Parts stay visible. ---
            page.click("#modeAnalysisBtn")
            page.wait_for_timeout(300)
            vis = page.evaluate(
                """() => {
                    const show = (sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return null;
                        return el.offsetParent !== null;  // visible if laid out
                    };
                    return {
                        stock: show('[data-group=\"stock\"]'),
                        cutting: show('[data-group=\"cutting\"]'),
                        cta: document.querySelector('.panel--cta')?.offsetParent !== null,
                        parts: show('[data-group=\"parts\"]'),
                        analysis: show('[data-group=\"analysis\"]'),
                    };
                }"""
            )
            print(f"[mode:analysis] visibility = {vis}")
            if vis.get("stock") or vis.get("cutting") or vis.get("cta"):
                problems.append("Cut-planning groups still visible in Analysis mode")
            if not vis.get("analysis"):
                problems.append("Analysis group not visible in Analysis mode")
            if not vis.get("parts"):
                problems.append("Parts group not visible in Analysis mode")
            page.wait_for_timeout(200)

            # --- Job PDF BEFORE any solve: NO Structure/Assembly analysis. ---
            pre_pdf = download_to("#downloadPdfBtn", OUT / "job_before_solve.pdf")
            n_pre, titles_pre = pdf_page_titles(pre_pdf)
            if has_section(titles_pre, "assembly analysis", "structure"):
                problems.append("Structure/Assembly analysis present in job PDF BEFORE any solve")
            print(f"[before] job PDF {n_pre} pages, gated content present = "
                  f"{has_section(titles_pre, 'assembly analysis', 'structure')}")

            # --- Detect joints. ---
            page.click("#asmDetectBtn")
            page.wait_for_timeout(600)
            joint_rows = page.query_selector_all(".asm-joint-row")
            n_joints = len(joint_rows)
            print(f"[detect] {n_joints} joints detected")
            if n_joints < 1:
                problems.append("Detect joints found no joints on the workbench")

            # --- Set the first joint to hinged. ---
            if n_joints > 0:
                first_sel = page.query_selector('.asm-joint-row[data-joint="0"] [data-jf="stiff"]')
                first_sel.select_option("hinged")
                page.wait_for_timeout(200)

            # --- Preset: 50 kg on top. ---
            page.click("#asmPreset50")
            page.wait_for_timeout(300)
            load_rows = page.query_selector_all(".asm-load-row")
            print(f"[preset] {len(load_rows)} load rows after '50 kg on top'")
            if len(load_rows) < 1:
                problems.append("'50 kg on top' preset did not populate a load row")

            page.screenshot(path=str(OUT / "analysis_configured.png"), full_page=True)

            # --- Solve assembly. ---
            # Install a MutationObserver on the Solve button BEFORE clicking so
            # we capture the staged progress labels (Meshing → Assembling →
            # Factorizing/Solving → Recovering → Rendering) even though the
            # solve is fast. window.__asmStages collects each distinct label.
            page.evaluate(
                """() => {
                    window.__asmStages = [];
                    const btn = document.getElementById('asmSolveBtn');
                    const obs = new MutationObserver(() => {
                        const lbl = btn.querySelector('.asm-solve-stage');
                        if (lbl) {
                            const t = lbl.textContent || '';
                            const arr = window.__asmStages;
                            if (t && (arr.length === 0 || arr[arr.length - 1] !== t)) arr.push(t);
                        }
                    });
                    obs.observe(btn, { childList: true, subtree: true, characterData: true });
                    window.__asmStageObs = obs;
                }"""
            )
            page.click("#asmSolveBtn")
            page.wait_for_function(
                "() => { const el = document.getElementById('asmResult'); "
                "return el && /(deflection|floor|non-physical|under-constrained|nothing)/i.test(el.textContent || ''); }",
                timeout=60_000,
            )
            stages = page.evaluate(
                "() => { if (window.__asmStageObs) window.__asmStageObs.disconnect(); return window.__asmStages || []; }"
            )
            print(f"[solve] progress stages observed = {stages}")
            # Assert the staged pipeline feedback appeared during the solve.
            joined = " ".join(stages).lower()
            expect_stages = ["mesh", "assembl", "solv"]  # solving OR factorizing
            missing = [s for s in expect_stages if s not in joined and not ("factoriz" in joined and s == "solv")]
            if not stages:
                problems.append("no progress stages observed on the Solve button during a solve")
            elif missing:
                problems.append(f"Solve progress bar missing stages {missing}; saw {stages}")

            result_text = page.eval_on_selector("#asmResult", "el => el.textContent")
            print(f"[solve] result = {result_text!r}")
            if "deflection" not in result_text.lower():
                problems.append(f"assembly result line did not report a deflection: {result_text!r}")
            if not any(v in result_text.upper() for v in ["OK", "BORDERLINE", "WEAK"]):
                problems.append("assembly result line missing a verdict")
            # STRESS: the result line must also report a max stress in MPa and a
            # utilization %.
            if "mpa" not in result_text.lower():
                problems.append(f"assembly result line did not report a stress in MPa: {result_text!r}")
            if "util" not in result_text.lower() or "%" not in result_text:
                problems.append(f"assembly result line did not report a utilization %: {result_text!r}")

            # BACKEND: the result line must NAME the linear backend that ran —
            # the PyNite local sidecar (primary), the Eigen LDLT (wasm) direct
            # solver, or the PCG fallback.
            backend_names = ("pynite", "eigen ldlt", "pcg")
            if not any(b in result_text.lower() for b in backend_names):
                problems.append(f"assembly result line did not name the solve backend: {result_text!r}")
            # The console log line must also name the backend (for the drive).
            backend_logged = any(
                any(b in c.lower() for b in backend_names) and "[assembly]" in c.lower()
                for c in console
            )
            print(f"[solve] backend named in console log = {backend_logged}")
            if not backend_logged:
                problems.append("[assembly] console log line did not name the solve backend")

            page.wait_for_timeout(500)

            # --- Green solved dot on the Analysis tab must show after a solve. ---
            dot_shown = page.evaluate(
                "() => { const d = document.getElementById('modeAnalysisDot'); return d && !d.hidden; }"
            )
            print(f"[solved-dot] shown = {dot_shown}")
            solved_ok = "deflection" in result_text.lower()
            if solved_ok and not dot_shown:
                problems.append("Analysis-tab green solved dot NOT shown after a successful solve")

            canvas = page.query_selector("#viewer canvas")
            canvas.screenshot(path=str(OUT / "assembly_heatmap.png"))
            page.screenshot(path=str(OUT / "analysis_solved.png"), full_page=True)
            # Screenshot just the Analysis section.
            page.query_selector('section.panel--group[data-group="analysis"]').screenshot(
                path=str(OUT / "analysis_section.png"))

            # --- Field toggle: switch to Stress (re-textures from cache, no
            #     re-solve) and screenshot the stress heatmap. ---
            toggle = page.query_selector("#asmFieldToggle")
            if toggle is None or not toggle.is_visible():
                problems.append("Deflection/Stress field toggle not shown after a solve")
            else:
                stress_btn = page.query_selector("#asmFieldStress")
                stress_btn.click()
                page.wait_for_timeout(500)
                stress_active = page.evaluate(
                    "() => document.getElementById('asmFieldStress')?.classList.contains('active')"
                )
                if not stress_active:
                    problems.append("Stress field tab did not become active after click")
                canvas.screenshot(path=str(OUT / "assembly_stress_heatmap.png"))
                page.query_selector('section.panel--group[data-group="analysis"]').screenshot(
                    path=str(OUT / "analysis_section_stress.png"))
                # Switch back to deflection so the export screenshot is stable.
                page.click("#asmFieldDefl")
                page.wait_for_timeout(300)

            # --- Standalone analysis PDF. ---
            an_pdf = download_to("#asmExportBtn", OUT / "standalone_assembly.pdf", timeout_ms=90_000)
            n_an, titles_an = pdf_page_titles(an_pdf)
            render_pages(an_pdf, "standalone")
            print(f"[standalone] assembly PDF {n_an} pages; p1={titles_an[0][:140]!r}")
            an_all = " ".join(titles_an).lower()
            if "assembly analysis" not in an_all:
                problems.append("standalone assembly PDF missing 'Assembly analysis' heading")
            if not any(k in an_all for k in ["rigid", "semi-rigid", "hinged"]):
                problems.append("standalone assembly PDF does not list joint stiffness")
            if "verdict" not in an_all and not any(v in an_all for v in ["ok", "borderline", "weak"]):
                problems.append("standalone assembly PDF missing a verdict")
            # STRESS block: the standalone PDF must carry the von-Mises max (MPa)
            # and utilization %.
            if "mpa" not in an_all:
                problems.append("standalone assembly PDF missing a stress (MPa) figure")
            if "von mises" not in an_all and "utilization" not in an_all:
                problems.append("standalone assembly PDF missing the von-Mises/utilization stress block")

            # --- Job PDF AFTER solve: BOTH Structure + Assembly analysis. ---
            post_pdf = download_to("#downloadPdfBtn", OUT / "job_after_solve.pdf")
            n_post, titles_post = pdf_page_titles(post_pdf)
            render_pages(post_pdf, "after")
            has_struct = has_section(titles_post, "structure")
            has_asm = has_section(titles_post, "assembly analysis")
            print(f"[after] job PDF {n_post} pages; structure={has_struct} assembly={has_asm}")
            for i, t in enumerate(titles_post):
                tl = t.lower()
                if "assembly analysis" in tl or tl.startswith("structure"):
                    print(f"        page {i + 1}: {t[:90]!r}")
            if not has_struct:
                problems.append("Structure page MISSING in job PDF after assembly solve")
            if not has_asm:
                problems.append("Assembly analysis page MISSING in job PDF after solve")
            # STRESS block must appear on the job PDF's assembly page too.
            post_all = " ".join(titles_post).lower()
            if "mpa" not in post_all:
                problems.append("job PDF assembly page missing a stress (MPa) figure after solve")

            # --- Switch back to Cut planning: the estimate/sidebar must be
            #     intact (Stock/Cutting/Estimate visible again, Analysis hidden,
            #     and the estimate results still present). ---
            page.click("#modeCutBtn")
            page.wait_for_timeout(300)
            back = page.evaluate(
                """() => {
                    const show = (sel) => { const el = document.querySelector(sel); return el ? el.offsetParent !== null : null; };
                    return {
                        stock: show('[data-group=\"stock\"]'),
                        cutting: show('[data-group=\"cutting\"]'),
                        cta: document.querySelector('.panel--cta')?.offsetParent !== null,
                        analysis: show('[data-group=\"analysis\"]'),
                        pdfEnabled: !document.getElementById('downloadPdfBtn').disabled,
                    };
                }"""
            )
            print(f"[mode:cut-back] {back}")
            if not (back.get("stock") and back.get("cutting") and back.get("cta")):
                problems.append("Cut-planning groups not restored after switching back")
            if back.get("analysis"):
                problems.append("Analysis group still visible after switching back to Cut planning")
            if not back.get("pdfEnabled"):
                problems.append("Estimate/PDF state lost after switching modes")
            # The solved dot persists across the mode switch (state not lost).
            dot_after = page.evaluate("() => { const d = document.getElementById('modeAnalysisDot'); return d && !d.hidden; }")
            if solved_ok and not dot_after:
                problems.append("Green solved dot lost after switching modes (state not persisted)")

            (OUT / "console.log").write_text("\n".join(console[-300:]), encoding="utf-8")
            browser.close()
    finally:
        kill_dev_server(proc)

    print("\n=== RESULT ===")
    if problems:
        for pr in problems:
            print(f"[FAIL] {pr}")
        return 1
    print("all assembly-analysis drive checks PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
