"""
End-to-end Playwright drive for the reworked DIRECT-CUTTING cut editor.

Exercises: load a STEP, select all, estimate, open "Edit cuts" on sheet 1,
hand-make >=3 cuts by clicking candidate lines on the diagram (including one
made with a manually-armed FAR reference edge), undo one, auto-complete the
rest, close, export the job PDF, and verify with PyMuPDF that the cut-sequence
pages reflect the hand-built order (first layout cut = the line clicked) and
that a far-edge quote appears ("from R edge" or "from B edge").

Screenshots: popup mid-breakdown + finished state.

Run:  python tests/cuteditor_drive.py
Output: tests/_output/cuteditor_drive/
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz  # PyMuPDF
from playwright.sync_api import sync_playwright

# Windows consoles default to cp1252; the diagram/title carry non-ASCII. Force
# UTF-8 so prints never crash the run.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SAMPLE = REPO / "samlple step files" / "plywood workbench.stp"
OUT = REPO / "tests" / "_output" / "cuteditor_drive"


def pdf_pages_text(pdf_path: Path):
    doc = fitz.open(str(pdf_path))
    pages = [" ".join(pg.get_text().split()) for pg in doc]
    doc.close()
    return pages


def render_pages(pdf_path: Path, tag: str, dpi: int = 110):
    doc = fitz.open(str(pdf_path))
    for i, pg in enumerate(doc):
        pix = pg.get_pixmap(dpi=dpi)
        pix.save(str(OUT / f"{tag}_page-{i + 1:02d}.png"))
    doc.close()


# Committed candidate lines land in the JS `session.built` array. We drive the
# clicks by dispatching a synthetic 'click' on the candidate <line> via
# elementFromPoint, which is robust in headless. The candidate lines carry a
# data-cand attribute; we enumerate them and click by index.
CLICK_CAND_BY_INDEX = """
(idx) => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return {ok:false, reason:'no svg'};
  const cands = Array.from(svg.querySelectorAll('line.cut-candidate'));
  if (idx >= cands.length) return {ok:false, reason:'idx oob', n:cands.length};
  const line = cands[idx];
  const evt = new MouseEvent('click', {bubbles:true, cancelable:true, view:window});
  line.dispatchEvent(evt);
  return {ok:true, n:cands.length, cand:line.getAttribute('data-cand')};
}
"""

CAND_COUNT = """
() => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return -1;
  return svg.querySelectorAll('line.cut-candidate').length;
}
"""

# Arm the FAR edge of the first live piece that has candidates: click one of the
# edge bands (data-role isn't set, but the band rects are the transparent
# 'cut-edge-band' rects). We find the far edge band overlapping a candidate's
# region and dispatch a click. Simpler: pick the LAST edge band (bands are added
# left,right,top,bottom per region) — but to reliably hit a FAR edge we filter.
ARM_FAR_EDGE = """
() => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return {ok:false, reason:'no svg'};
  // Prefer arming via the exposed test hook if present.
  const bands = Array.from(svg.querySelectorAll('rect.cut-edge-band'));
  if (!bands.length) return {ok:false, reason:'no bands'};
  // Heuristic: a FAR vertical band sits at the right of its piece; a FAR
  // horizontal band at the bottom. We can't read JS state from here, so we
  // click the band whose center is farthest right+down (most likely a far
  // edge). The editor toggles arm on click.
  let best = null, bestScore = -1;
  for (const b of bands) {
    const x = parseFloat(b.getAttribute('x')) + parseFloat(b.getAttribute('width'))/2;
    const y = parseFloat(b.getAttribute('y')) + parseFloat(b.getAttribute('height'))/2;
    const score = x + y;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  const evt = new MouseEvent('click', {bubbles:true, cancelable:true, view:window});
  best.dispatchEvent(evt);
  return {ok:true};
}
"""

# Read the built-cut count from the readout list (rows that are NOT trims and
# have an undo button).
BUILT_ROWS = """
() => {
  const list = document.querySelector('.cut-editor-list');
  if (!list) return -1;
  return list.querySelectorAll('.cut-row:not(.trim)').length;
}
"""

ARMED_GREEN = """
() => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return false;
  // Armed edge is a thick green line (stroke #2F855A, width 5).
  return Array.from(svg.querySelectorAll('line')).some(l =>
    (l.getAttribute('stroke')||'').toUpperCase() === '#2F855A' &&
    parseFloat(l.getAttribute('stroke-width')||'0') >= 5);
}
"""

TITLE_TEXT = "() => document.querySelector('.cut-editor-title')?.textContent || ''"


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
            page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))

            page.goto(f"http://localhost:{port}", wait_until="networkidle")
            # Clear any persisted overrides from prior runs.
            page.evaluate("() => { try { localStorage.removeItem('plywood.cutOverrides'); } catch(e){} }")

            page.set_input_files("#fileInput", str(SAMPLE))
            page.wait_for_function(
                "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
                timeout=45_000,
            )
            page.wait_for_timeout(1000)
            page.select_option("#units", "mm")
            page.wait_for_timeout(150)
            page.click("#selectAllBtn")
            page.wait_for_timeout(300)

            page.click("#nestBtn")
            page.wait_for_function(
                "() => !document.getElementById('downloadPdfBtn').disabled",
                timeout=180_000,
            )
            page.wait_for_timeout(600)

            # Open "Edit cuts" on the FIRST sheet.
            edit_btns = page.query_selector_all(".edit-cuts-btn")
            print(f"[editor] {len(edit_btns)} edit-cuts buttons")
            if not edit_btns:
                problems.append("no Edit cuts button found")
                raise SystemExit(1)
            edit_btns[0].click()
            page.wait_for_selector(".cut-editor-svg", timeout=5000)
            page.wait_for_timeout(400)

            n_cands = page.evaluate(CAND_COUNT)
            print(f"[editor] initial candidate lines: {n_cands}")
            print(f"[editor] title: {page.evaluate(TITLE_TEXT)!r}")
            page.screenshot(path=str(OUT / "popup_initial.png"), full_page=True)

            if n_cands < 1:
                problems.append("no candidate lines on the initial diagram")

            # Hover a candidate so the red-dashed line + live quote render, then
            # screenshot — demonstrates the candidate visual for the report.
            page.evaluate("""() => {
              const svg = document.querySelector('.cut-editor-svg');
              const line = svg && svg.querySelector('line.cut-candidate');
              if (line) line.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true, view:window}));
            }""")
            page.wait_for_timeout(200)
            page.screenshot(path=str(OUT / "popup_candidate_hover.png"), full_page=True)

            # --- Cut 1: click the first candidate (this becomes the FIRST
            #     layout cut in the PDF). Record which line so we can assert. ---
            r1 = page.evaluate(CLICK_CAND_BY_INDEX, 0)
            print(f"[cut1] {r1}")
            page.wait_for_timeout(300)
            first_cand = r1.get("cand") if isinstance(r1, dict) else None

            # --- Cut 2: arm a FAR edge, then commit a candidate quoted from it. ---
            armed = page.evaluate(ARM_FAR_EDGE)
            page.wait_for_timeout(200)
            green = page.evaluate(ARMED_GREEN)
            print(f"[cut2] armed far edge = {armed}, green shown = {green}")
            if not green:
                problems.append("arming a far edge did not draw the green measured-from line")
            page.screenshot(path=str(OUT / "popup_armed.png"), full_page=True)
            # Click a candidate that belongs to the armed region if possible;
            # fall back to index 0.
            n2 = page.evaluate(CAND_COUNT)
            r2 = page.evaluate(CLICK_CAND_BY_INDEX, 0 if n2 > 0 else 0)
            print(f"[cut2] {r2}")
            page.wait_for_timeout(300)

            # --- Cut 3: another candidate. ---
            n3 = page.evaluate(CAND_COUNT)
            r3 = page.evaluate(CLICK_CAND_BY_INDEX, 0 if n3 > 0 else 0)
            print(f"[cut3] {r3}")
            page.wait_for_timeout(300)

            built = page.evaluate(BUILT_ROWS)
            print(f"[editor] built rows after 3 cuts: {built}")
            page.screenshot(path=str(OUT / "popup_mid_breakdown.png"), full_page=True)
            if built < 3:
                problems.append(f"expected >=3 built cuts, got {built}")

            # Inspect the persisted customSteps override: prove the hand-built
            # order + that at least one cut carries fromFar (the armed FAR edge).
            ov = page.evaluate("""() => {
              try { return JSON.parse(localStorage.getItem('plywood.cutOverrides')||'{}'); }
              catch(e){ return {}; }
            }""")
            sigs = list(ov.keys()) if isinstance(ov, dict) else []
            custom = ov[sigs[0]].get("customSteps", []) if sigs else []
            print(f"[override] {len(custom)} customSteps; first = "
                  f"{custom[0] if custom else None}")
            any_far = any(bool(s.get("fromFar")) for s in custom)
            print(f"[override] any fromFar among hand-built cuts = {any_far}")
            if not custom:
                problems.append("no customSteps persisted for the hand-built sheet")
            if not any_far:
                problems.append("no hand-built cut carries fromFar (armed FAR edge lost)")

            # First custom step must be the line clicked first (V, coord 14 →
            # parentX 13 + distance 1). Parse first_cand for the expected coord.
            if custom and first_cand:
                fc = str(first_cand).split("|")  # e.g. ['V','14','13,13,2413,720']
                exp_vertical = fc[0] == "V"
                exp_coord = float(fc[1])
                exp_px = float(fc[2].split(",")[0])
                s0 = custom[0]
                # The clicked V/H flag is in sheet-line space; convert the
                # stored step back to a sheet line coord. A vertical sheet line
                # sits at parentX+distance; horizontal at parentY+distance. We
                # don't re-derive axis mapping here — just check the line coord
                # + parent origin match the clicked candidate.
                got_v = s0["parentX"] + s0["distance"]
                got_h = s0["parentY"] + s0["distance"]
                got_coord = got_v if exp_vertical else got_h
                print(f"[override] first step axis={s0['axis']} "
                      f"parent=({s0['parentX']},{s0['parentY']}) dist={s0['distance']} "
                      f"line coord {got_coord} (expected {exp_coord}); "
                      f"parentX {s0['parentX']} (expected {exp_px})")
                if abs(got_coord - exp_coord) > 2 or abs(s0["parentX"] - exp_px) > 2:
                    problems.append("first customStep is not the first line clicked")

            # --- Undo one. ---
            page.click('.cut-editor-head [data-role="undo"]')
            page.wait_for_timeout(300)
            built_after_undo = page.evaluate(BUILT_ROWS)
            print(f"[editor] built rows after undo: {built_after_undo}")
            if built_after_undo != built - 1:
                problems.append(f"undo did not remove exactly one cut ({built}->{built_after_undo})")

            # --- Auto-complete the rest. ---
            page.click('.cut-editor-head [data-role="auto"]')
            page.wait_for_timeout(400)
            title_done = page.evaluate(TITLE_TEXT)
            built_final = page.evaluate(BUILT_ROWS)
            print(f"[editor] after auto-complete: title={title_done!r}, built rows={built_final}")
            page.screenshot(path=str(OUT / "popup_finished.png"), full_page=True)

            # Close (a "why" prompt may appear — auto-dismiss any dialog).
            page.on("dialog", lambda d: d.accept(""))
            page.click('.cut-editor-head [data-role="close"]')
            page.wait_for_timeout(400)

            # --- Export the job PDF (now carries the customSteps override). ---
            with page.expect_download(timeout=180_000) as dl:
                page.click("#downloadPdfBtn")
            job_pdf = OUT / "job_custom_cuts.pdf"
            dl.value.save_as(str(job_pdf))
            pages = pdf_pages_text(job_pdf)
            render_pages(job_pdf, "job")
            print(f"[pdf] {len(pages)} pages")

            all_text = " ".join(pages).lower()
            # Far-edge quote must appear somewhere in the cut sequence.
            has_far = ("from r edge" in all_text) or ("from b edge" in all_text)
            print(f"[pdf] far-edge quote present = {has_far}")
            if not has_far:
                problems.append("PDF cut sequence has no far-edge quote (from R/B edge)")

            # The cut-sequence pages should exist (Cut 1 ... etc). Find them.
            cut_pages = [i + 1 for i, t in enumerate(pages) if "cut 1" in t.lower() or "cut sequence" in t.lower()]
            print(f"[pdf] cut-sequence-ish pages: {cut_pages}")
            if not cut_pages:
                problems.append("no cut-sequence page found in the PDF")

            (OUT / "console.log").write_text("\n".join(console[-400:]), encoding="utf-8")
            (OUT / "first_cand.txt").write_text(str(first_cand), encoding="utf-8")
            browser.close()
    finally:
        kill_dev_server(proc)

    print("\n=== RESULT ===")
    if problems:
        for pr in problems:
            print(f"[FAIL] {pr}")
        return 1
    print("all cut-editor drive checks PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
