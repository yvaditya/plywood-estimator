"""
End-to-end Playwright drive for the extended Quick-CAE feature.

Exercises: multiple loads (incl. a 100mm round patch), a uniform load, two
pins, edge supports, solve, the opaque heatmap overlay, the standalone
"Export analysis PDF" button, and the job-PDF gating (Structure + Analysis
pages appear ONLY after a solve).

Run:  python tests/cae_drive.py
Output: tests/_output/cae_drive/  (screenshots + PDFs + rendered pages)
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz  # PyMuPDF
from playwright.sync_api import sync_playwright

# Reuse the server lifecycle helpers from the visual pipeline.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SAMPLE = REPO / "samlple step files" / "plywood workbench.stp"
OUT = REPO / "tests" / "_output" / "cae_drive"

BODY_INDEX = 15  # a visible top panel


def pdf_page_titles(pdf_path: Path):
    """Return (page_count, [full text per page, whitespace-collapsed])."""
    doc = fitz.open(str(pdf_path))
    titles = []
    for pg in doc:
        txt = " ".join(pg.get_text().split())
        titles.append(txt)
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

            page.goto(f"http://localhost:{port}", wait_until="networkidle")
            page.set_input_files("#fileInput", str(SAMPLE))
            page.wait_for_function(
                "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
                timeout=45_000,
            )
            page.wait_for_timeout(1200)

            # Switch to mm so the "100" footprint size is unambiguously 100 mm.
            page.select_option("#units", "mm")
            page.wait_for_timeout(200)

            # Select all (also makes every body's CAE block render).
            page.click("#selectAllBtn")
            page.wait_for_timeout(300)

            # Expand the file group so body rows are visible.
            headers = page.query_selector_all(".file-header .file-chevron")
            for h in headers:
                # Expand any collapsed group (chevron shows a right-arrow when collapsed).
                try:
                    h.click()
                except Exception:
                    pass
            page.wait_for_timeout(300)

            # --- Estimate FIRST so the PDF button enables. ---
            page.click("#nestBtn")
            page.wait_for_function(
                "() => !document.getElementById('downloadPdfBtn').disabled",
                timeout=120_000,
            )
            page.wait_for_timeout(800)

            # --- Job PDF BEFORE any solve: must have NO Structure/Analysis. ---
            with page.expect_download(timeout=120_000) as dl:
                page.click("#downloadPdfBtn")
            pre_pdf = OUT / "job_before_solve.pdf"
            dl.value.save_as(str(pre_pdf))
            n_pre, titles_pre = pdf_page_titles(pre_pdf)
            render_pages(pre_pdf, "before")
            if has_section(titles_pre, "structure", "analysis"):
                problems.append("Structure/Analysis present in job PDF BEFORE any solve")
            print(f"[before] job PDF {n_pre} pages, structure/analysis present = "
                  f"{has_section(titles_pre, 'structure', 'analysis')}")

            # --- Open the CAE panel on body index 15. ---
            toggles = page.query_selector_all(".cae-toggle")
            print(f"[cae] {len(toggles)} cae-toggles found")
            assert len(toggles) > BODY_INDEX, f"need >{BODY_INDEX} toggles, got {len(toggles)}"
            toggles[BODY_INDEX].scroll_into_view_if_needed()
            toggles[BODY_INDEX].click()
            page.wait_for_selector(".cae-panel", timeout=5000)
            page.wait_for_timeout(300)

            def panel():
                # The just-opened panel is the only .cae-panel on screen.
                return page.query_selector(".cae-panel")

            # --- Uniform 20 kg ---
            page.fill('.cae-panel [data-cae="uniformKg"]', "20")
            page.dispatch_event('.cae-panel [data-cae="uniformKg"]', "change")
            page.wait_for_timeout(150)

            # --- First point load: place it at panel centre via the viewer. We
            #     click "Place" then click the canvas centre. ---
            def place_via_canvas(place_selector, cx_frac=0.5, cy_frac=0.5):
                page.click(place_selector)
                page.wait_for_timeout(150)
                box = page.query_selector("#viewer canvas").bounding_box()
                page.mouse.click(box["x"] + box["width"] * cx_frac,
                                 box["y"] + box["height"] * cy_frac)
                page.wait_for_timeout(250)

            place_via_canvas('.cae-panel .cae-load-row[data-load="0"] [data-lf="place"]', 0.5, 0.45)

            # --- Second load: a 100mm round patch. Add it, set size, place. ---
            page.click('.cae-panel [data-cae="addLoad"]')
            page.wait_for_timeout(200)
            # shape defaults to round; set the footprint size to 100 mm. The size
            # input is in the user's units (default inch), so switch units to mm
            # first for an unambiguous 100.
            # Ensure the second row exists.
            page.wait_for_selector('.cae-panel .cae-load-row[data-load="1"]', timeout=3000)
            # Set shape to round explicitly + size 100 (units may be inch — set via
            # the app's mm by toggling the units select to mm for clarity).
            units_val = page.eval_on_selector("#units", "el => el.value") if page.query_selector("#units") else None
            print(f"[units] current = {units_val}")

            # Place the round patch off-centre.
            place_via_canvas('.cae-panel .cae-load-row[data-load="1"] [data-lf="place"]', 0.62, 0.55)
            # Set its footprint size input to 100 (in whatever unit) then re-read.
            page.fill('.cae-panel .cae-load-row[data-load="1"] [data-lf="size"]', "100")
            page.dispatch_event('.cae-panel .cae-load-row[data-load="1"] [data-lf="size"]', "change")
            page.wait_for_timeout(200)

            # --- Two pins ---
            for frac in [(0.30, 0.5), (0.72, 0.5)]:
                page.click('.cae-panel [data-cae="addPin"]')
                page.wait_for_timeout(150)
                box = page.query_selector("#viewer canvas").bounding_box()
                page.mouse.click(box["x"] + box["width"] * frac[0],
                                 box["y"] + box["height"] * frac[1])
                page.wait_for_timeout(250)

            # --- Set left + right edges supported. Each edge button cycles
            #     free→supported→fixed; from 'free' one click = supported. ---
            def set_edge_supported(edge):
                sel = f'.cae-panel .cae-edge[data-edge="{edge}"]'
                el = page.query_selector(sel)
                strong = el.inner_text().lower()
                if "free" in strong:
                    el.click()
                    page.wait_for_timeout(120)
            # Re-query after each render (panel rebuilds).
            for edge in ["left", "right"]:
                el = page.query_selector(f'.cae-panel .cae-edge[data-edge="{edge}"]')
                if el and "free" in el.inner_text().lower():
                    el.click()
                    page.wait_for_timeout(200)

            page.screenshot(path=str(OUT / "cae_panel_configured.png"), full_page=True)

            # --- Solve ---
            page.click('.cae-panel [data-cae="solve"]')
            # Wait until the result line reports a sag figure.
            page.wait_for_function(
                "() => { const el = document.querySelector('.cae-panel .cae-result'); "
                "return el && /sag/i.test(el.textContent || ''); }",
                timeout=30_000,
            )
            result_text = page.eval_on_selector(".cae-panel .cae-result", "el => el.textContent")
            print(f"[solve] result = {result_text!r}")
            if "sag" not in result_text.lower():
                problems.append("cae-result did not report a sag after solve")

            page.wait_for_timeout(500)
            # Screenshot the canvas — the opaque heatmap must be visible.
            canvas = page.query_selector("#viewer canvas")
            canvas.screenshot(path=str(OUT / "heatmap_canvas.png"))
            page.screenshot(path=str(OUT / "cae_solved_full.png"), full_page=True)

            # --- Standalone analysis PDF ---
            with page.expect_download(timeout=60_000) as dl2:
                page.click('.cae-panel [data-cae="exportPdf"]')
            an_pdf = OUT / "standalone_analysis.pdf"
            dl2.value.save_as(str(an_pdf))
            n_an, titles_an = pdf_page_titles(an_pdf)
            render_pages(an_pdf, "standalone")
            print(f"[standalone] analysis PDF {n_an} pages; p1={titles_an[0][:140]!r}")
            if not has_section(titles_an, "analysis"):
                problems.append("standalone analysis PDF missing 'Analysis' heading")
            # It should list each load's shape + size + direction (ASCII labels,
            # jsPDF core font has no Unicode arrows).
            an_all = " ".join(titles_an).lower()
            if not ("round" in an_all or "square" in an_all):
                problems.append("standalone analysis PDF does not list a load footprint shape")
            if not ("down" in an_all or "up" in an_all):
                problems.append("standalone analysis PDF does not list a load direction")

            # --- Job PDF AFTER solve: must have BOTH Structure + Analysis. ---
            with page.expect_download(timeout=120_000) as dl3:
                page.click("#downloadPdfBtn")
            post_pdf = OUT / "job_after_solve.pdf"
            dl3.value.save_as(str(post_pdf))
            n_post, titles_post = pdf_page_titles(post_pdf)
            render_pages(post_pdf, "after")
            has_struct = has_section(titles_post, "structure")
            has_analysis = has_section(titles_post, "analysis")
            print(f"[after] job PDF {n_post} pages; structure={has_struct} analysis={has_analysis}")
            # Find which page numbers carry them.
            for i, t in enumerate(titles_post):
                tl = t.lower()
                if "structure" in tl or tl.startswith("analysis"):
                    print(f"        page {i + 1}: {t[:90]!r}")
            if not has_struct:
                problems.append("Structure page MISSING in job PDF after solve")
            if not has_analysis:
                problems.append("Analysis page MISSING in job PDF after solve")

            (OUT / "console.log").write_text("\n".join(console[-300:]), encoding="utf-8")
            browser.close()
    finally:
        kill_dev_server(proc)

    print("\n=== RESULT ===")
    if problems:
        for p in problems:
            print(f"[FAIL] {p}")
        return 1
    print("all CAE drive checks PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
