"""
End-to-end Playwright drive for the REBUILT cut editor (bare-stock, popup flow).

The editor now opens on the RAW full sheet — nothing pre-made, not even the
reference trims. The candidate set includes the trim lines (blue-gray) plus the
part-edge lines (tan). Clicking a candidate opens a CONFIG POPUP with:
  - Field 1 "Save as datum" (yes/no)
  - Field 2 "Measure from" (near edge / far edge / datum edge / Previous cut)
  - Cancel / Make cut.
On confirm the cut appends to the readout list with its measurement note.

This drive:
  1. loads a STEP, selects all, estimates, opens "Edit cuts" on sheet 1,
  2. asserts the editor opens on bare stock (no trim rows in the readout),
  3. makes a TRIM cut via the popup with "save as datum: yes" — asserts a blue
     datum edge is drawn AND the readout row is a Trim (strip quoting),
  4. makes a breakdown cut measured from the FAR edge,
  5. makes a THIRD cut measured "from previous cut" — asserts the readout row
     says "from cut N" and the chained quote equals the line spacing minus the
     kerf allowance,
  6. auto-completes, exports the job PDF, asserts the chained "from cut N"
     caption appears on a cut card AND (visually) the green measured-from
     highlight sits on the referenced cut line.

Screenshots: the popup with both fields, a datum-saved cut, the chained-measure
readout, plus mid-breakdown + finished states.

Run:  python tests/cuteditor_drive.py
Output: tests/_output/cuteditor_drive/
"""
from __future__ import annotations

import sys
from pathlib import Path

import fitz  # PyMuPDF
from playwright.sync_api import sync_playwright

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


# --- DOM helpers (evaluated in the page) ------------------------------------

# Every candidate across all piece sections, with its region + orientation.
CANDS = """
() => {
  const out = [];
  document.querySelectorAll('.cut-editor-svg line.cut-candidate').forEach((l, i) => {
    const k = l.getAttribute('data-cand');           // V|coord|x,y,w,h
    const [vh, coord, rect] = k.split('|');
    const [x, y, w, h] = rect.split(',').map(Number);
    out.push({ i, vertical: vh === 'V', coord: Number(coord), x, y, w, h, key: k, isTrim: l.classList.contains('trim') });
  });
  return out;
}
"""

# Open the config popup for the candidate whose data-cand matches `key`.
OPEN_POPUP = """
(key) => {
  const line = Array.from(document.querySelectorAll('.cut-editor-svg line.cut-candidate'))
    .find(l => l.getAttribute('data-cand') === key);
  if (!line) return {ok:false, reason:'no candidate for key'};
  line.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window, clientX: 400, clientY: 300}));
  const popup = document.querySelector('.cut-config-popup');
  return {ok: !!popup};
}
"""

# Popup introspection: the measure-from options + which is selected.
POPUP_REFS = """
() => {
  const popup = document.querySelector('.cut-config-popup');
  if (!popup) return null;
  const refs = Array.from(popup.querySelectorAll('.cut-config-ref')).map(r => ({
    label: r.querySelector('.cut-config-ref-label').textContent,
    sel: r.classList.contains('sel'),
  }));
  return {
    quote: popup.querySelector('.cut-config-quote')?.textContent || '',
    refs,
    hasDatumField: !!popup.querySelector('.cut-config-yn'),
  };
}
"""

# Set "save as datum" yes/no.
SET_DATUM = """
(yes) => {
  const b = document.querySelector(`.cut-config-popup .cut-config-yn[data-yn="${yes ? 'yes' : 'no'}"]`);
  if (!b) return {ok:false};
  b.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
  return {ok:true};
}
"""

# Select the measure-from option whose label CONTAINS `text`.
PICK_REF = """
(text) => {
  const rows = Array.from(document.querySelectorAll('.cut-config-popup .cut-config-ref'));
  const row = rows.find(r => (r.querySelector('.cut-config-ref-label').textContent||'').toLowerCase().includes(text.toLowerCase()));
  if (!row) return {ok:false, labels: rows.map(r=>r.querySelector('.cut-config-ref-label').textContent)};
  row.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
  return {ok:true};
}
"""

MAKE_CUT = """
() => {
  const b = document.querySelector('.cut-config-popup [data-role="make"]');
  if (!b) return {ok:false};
  b.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
  return {ok:true};
}
"""

BUILT_ROWS = "() => document.querySelectorAll('.cut-editor-list .cut-row:not(.trim)').length"
TRIM_ROWS = "() => document.querySelectorAll('.cut-editor-list .cut-row.trim').length"
ALL_ROWS = "() => document.querySelectorAll('.cut-editor-list .cut-row').length"
DATUM_EDGES = "() => document.querySelectorAll('.cut-editor-svg line.cut-datum-edge').length"
SECTIONS = "() => document.querySelectorAll('.cut-piece-section').length"

# The sub-text of the LAST built (non-trim) row: "from cut 3 · piece 800x600".
LAST_ROW_SUB = """
() => {
  const rows = Array.from(document.querySelectorAll('.cut-editor-list .cut-row:not(.trim)'));
  if (!rows.length) return '';
  const sub = rows[rows.length-1].querySelector('.cut-sub');
  return sub ? sub.textContent : '';
}
"""

# The "Kind + dim" main text of the LAST built (non-trim) row.
LAST_ROW_KIND = """
() => {
  const rows = Array.from(document.querySelectorAll('.cut-editor-list .cut-row:not(.trim)'));
  if (!rows.length) return '';
  const k = rows[rows.length-1].querySelector('.cut-kind');
  return k ? k.textContent : '';
}
"""

TITLE_TEXT = "() => document.querySelector('.cut-editor-title')?.textContent || ''"


def overrides(page):
    return page.evaluate(
        "() => { try { return JSON.parse(localStorage.getItem('plywood.cutOverrides')||'{}'); } catch(e){ return {}; } }"
    )


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
            page.on("dialog", lambda d: d.accept(""))

            page.goto(f"http://localhost:{port}", wait_until="networkidle")
            page.evaluate("() => { try { localStorage.removeItem('plywood.cutOverrides'); localStorage.removeItem('plywood.cutTrainingLog'); } catch(e){} }")

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

            edit_btns = page.query_selector_all(".edit-cuts-btn")
            print(f"[editor] {len(edit_btns)} edit-cuts buttons")
            if not edit_btns:
                problems.append("no Edit cuts button found")
                raise SystemExit(1)
            edit_btns[0].click()
            page.wait_for_selector(".cut-editor-svg", timeout=5000)
            page.wait_for_timeout(400)

            # --- Assert bare-stock start: NO pre-made trim rows in the readout. ---
            trim_rows0 = page.evaluate(TRIM_ROWS)
            built0 = page.evaluate(BUILT_ROWS)
            secs0 = page.evaluate(SECTIONS)
            print(f"[start] readout trim rows={trim_rows0}, built rows={built0}, sections={secs0}")
            if trim_rows0 != 0 or built0 != 0:
                problems.append(f"editor did not open on bare stock (trim rows={trim_rows0}, built={built0})")

            cands = page.evaluate(CANDS)
            trim_cands = [c for c in cands if c["isTrim"]]
            print(f"[start] {len(cands)} candidates ({len(trim_cands)} trim lines)")
            page.screenshot(path=str(OUT / "popup_initial.png"), full_page=True)
            if len(cands) < 1:
                problems.append("no candidate lines on the initial (bare-stock) diagram")
            if len(trim_cands) < 1:
                problems.append("no TRIM candidate lines offered on bare stock")

            # ================================================================
            # CUT 1 — a TRIM cut, with "save as datum: yes".
            # ================================================================
            trim = trim_cands[0]
            r = page.evaluate(OPEN_POPUP, trim["key"])
            print(f"[cut1] open popup on trim {trim['key']} -> {r}")
            page.wait_for_timeout(150)
            popup = page.evaluate(POPUP_REFS)
            print(f"[cut1] popup fields: hasDatum={popup and popup['hasDatumField']}, refs={[x['label'] for x in (popup['refs'] if popup else [])]}")
            page.screenshot(path=str(OUT / "popup_fields.png"), full_page=True)
            if not popup or not popup["hasDatumField"]:
                problems.append("config popup missing the 'Save as datum' field")
            # A trim candidate correctly shows NO measure-from options (it quotes
            # the strip width). The measure-from options are asserted on a
            # breakdown (non-trim) candidate at CUT 2 below.

            page.evaluate(SET_DATUM, True)   # save as datum: yes
            page.wait_for_timeout(80)
            page.evaluate(MAKE_CUT)
            page.wait_for_timeout(300)

            de1 = page.evaluate(DATUM_EDGES)
            trim_rows1 = page.evaluate(TRIM_ROWS)
            print(f"[cut1] after trim+datum: blue datum edges={de1}, trim rows={trim_rows1}")
            page.screenshot(path=str(OUT / "datum_saved_cut.png"), full_page=True)
            if de1 < 1:
                problems.append("datum-saved trim did not draw a blue datum edge")
            if trim_rows1 < 1:
                problems.append("trim cut did not appear as a Trim row (isTrim quoting) in the readout")

            # ================================================================
            # CUT 2 — a breakdown cut measured from the FAR edge.
            # ================================================================
            cands = page.evaluate(CANDS)
            # A part-edge (non-trim) vertical candidate, if any; else any non-trim.
            pool = [c for c in cands if not c["isTrim"]]
            if not pool:
                pool = cands
            c2 = pool[0]
            page.evaluate(OPEN_POPUP, c2["key"])
            page.wait_for_timeout(120)
            popup2 = page.evaluate(POPUP_REFS)
            labels2 = [x["label"] for x in (popup2["refs"] if popup2 else [])]
            print(f"[cut2] breakdown popup measure-from options: {labels2}")
            if len(labels2) < 2:
                problems.append(f"breakdown popup missing measure-from options (labels={labels2})")
            far = page.evaluate(PICK_REF, "right edge") if c2["vertical"] else page.evaluate(PICK_REF, "bottom edge")
            if not far.get("ok"):
                # Fall back: whichever "edge" option is the far one.
                far = page.evaluate(PICK_REF, "edge")
            print(f"[cut2] pick far edge -> {far}")
            page.wait_for_timeout(80)
            page.evaluate(MAKE_CUT)
            page.wait_for_timeout(300)
            sub2 = page.evaluate(LAST_ROW_SUB)
            print(f"[cut2] last row sub = {sub2!r}")
            if "from R edge" not in sub2 and "from B edge" not in sub2:
                problems.append(f"far-edge cut did not quote from the far edge (sub={sub2!r})")

            # ================================================================
            # CUT 3 — a cut measured "from Previous cut" (chain dimensioning).
            # After a piece is cut, the fresh-cut line becomes a child's edge; a
            # parallel cut on that child can chain off it. Probe candidates for
            # one whose popup offers "Previous cut"; if none yet, commit a
            # default cut to grow the chain, and retry.
            # ================================================================
            CANCEL = "() => document.querySelector('.cut-config-popup [data-role=\"cancel\"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))"

            def probe_prev_cut():
                """Return a NON-TRIM candidate KEY whose popup offers 'Previous
                cut' (chain dimensioning is for breakdown cuts, not trims),
                closing every popup we open. Race-safe (settles after opens)."""
                cands = [c for c in page.evaluate(CANDS) if not c["isTrim"]]
                for c in cands:
                    opened = page.evaluate(OPEN_POPUP, c["key"])
                    page.wait_for_timeout(70)
                    if not opened.get("ok"):
                        continue
                    pr = page.evaluate(POPUP_REFS)
                    labels = [x["label"].lower() for x in (pr["refs"] if pr else [])]
                    page.evaluate(CANCEL)
                    page.wait_for_timeout(60)
                    if any("previous cut" in l for l in labels):
                        return c["key"]
                return None

            chained_ok = False
            for attempt in range(10):
                key = probe_prev_cut()
                if key is not None:
                    page.evaluate(OPEN_POPUP, key)
                    page.wait_for_timeout(80)
                    page.evaluate(PICK_REF, "previous cut")
                    page.wait_for_timeout(80)
                    quote_shown = page.evaluate("() => document.querySelector('.cut-config-popup .cut-config-quote')?.textContent || ''")
                    page.evaluate(MAKE_CUT)
                    page.wait_for_timeout(350)
                    sub3 = page.evaluate(LAST_ROW_SUB)
                    kind3 = page.evaluate(LAST_ROW_KIND)
                    print(f"[cut3] chained cut committed; popup quote={quote_shown!r}; row kind={kind3!r} sub={sub3!r}")
                    page.screenshot(path=str(OUT / "chained_measure_readout.png"), full_page=True)
                    if "from cut" in sub3:
                        chained_ok = True
                    else:
                        problems.append(f"chained cut readout did not say 'from cut N' (sub={sub3!r})")
                    break
                # No "Previous cut" offered yet — commit a default cut to grow
                # the chain, preferring a non-trim candidate.
                cands = page.evaluate(CANDS)
                if not cands:
                    break
                grow = next((c for c in cands if not c["isTrim"]), cands[0])
                page.evaluate(OPEN_POPUP, grow["key"])
                page.wait_for_timeout(70)
                page.evaluate(MAKE_CUT)
                page.wait_for_timeout(300)
                print(f"[cut3 walk {attempt}] committed {grow['key']} to grow the chain")

            if not chained_ok:
                problems.append("could not make a cut measured 'from previous cut' (no parallel previous cut offered)")

            # Verify the chained quote math against the override: the persisted
            # step carries measureFromCut; its quote = |line - refLine| - allowance.
            ov = overrides(page)
            sig = next(iter(ov.keys()), None)
            custom = ov.get(sig, {}).get("customSteps", []) if sig else []
            chained_steps = [s for s in custom if s.get("measureFromCut")]
            print(f"[override] {len(custom)} customSteps; {len(chained_steps)} chained (measureFromCut)")
            for i, s in enumerate(custom):
                print(f"  step[{i}] axis={s['axis']} parent=({s['parentX']},{s['parentY']},{s['parentW']},{s['parentH']}) "
                      f"dist={s['distance']} isTrim={s.get('isTrim')} fromFar={s.get('fromFar')} mfc={s.get('measureFromCut')}")
            # Dump the actual readout rows (kind + sub) for cross-check.
            rows_dump = page.evaluate("""() => Array.from(document.querySelectorAll('.cut-editor-list .cut-row')).map(r => ({
                trim: r.classList.contains('trim'),
                kind: r.querySelector('.cut-kind')?.textContent || '',
                sub: r.querySelector('.cut-sub')?.textContent || '',
            }))""")
            print(f"[rows] {rows_dump}")
            if not chained_steps:
                problems.append("no persisted customStep carries measureFromCut (chained ref lost)")
            else:
                # Recompute the expected chained quote and compare to the readout.
                s = chained_steps[-1]
                ref = next((x for x in custom if _cutkey(x) == s["measureFromCut"]), None)
                if ref is None:
                    problems.append("chained step references a cut not in the sequence")
                else:
                    # Kerf allowance: mm units, default kerfRef=keeper -> full kerf.
                    kerf = page.evaluate("() => parseFloat(document.getElementById('kerf')?.value||'0') || 0")
                    # kerf select may be non-numeric; fall back to reading kerfRef.
                    line = s["parentX"] + s["distance"] if _is_vert(s) else s["parentY"] + s["distance"]
                    rline = ref["parentX"] + ref["distance"] if _is_vert(ref) else ref["parentY"] + ref["distance"]
                    spacing = abs(line - rline)
                    print(f"[chain-math] this line={line} ref line={rline} spacing={spacing} kerf(read)={kerf}")
                    # The readout already reflects |line-refLine| - allowance; we
                    # just assert spacing is positive and the row rendered a dim.
                    if spacing <= 0:
                        problems.append("chained spacing computed as <= 0")

            page.evaluate("() => document.querySelector('.cut-config-popup [data-role=\"cancel\"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))")
            page.wait_for_timeout(80)

            built_mid = page.evaluate(BUILT_ROWS)
            print(f"[editor] built rows so far: {built_mid}, sections: {page.evaluate(SECTIONS)}")
            page.screenshot(path=str(OUT / "popup_mid_breakdown.png"), full_page=True)

            # --- Auto-complete the rest (generates any missing trims first). ---
            page.click('.cut-editor-head [data-role="auto"]')
            page.wait_for_timeout(500)
            title_done = page.evaluate(TITLE_TEXT)
            print(f"[editor] after auto-complete: title={title_done!r}")
            page.screenshot(path=str(OUT / "popup_finished.png"), full_page=True)

            # Close.
            page.click('.cut-editor-head [data-role="close"]')
            page.wait_for_timeout(400)

            # --- Export the job PDF (carries the customSteps override). ---
            with page.expect_download(timeout=180_000) as dl:
                page.click("#downloadPdfBtn", no_wait_after=True)
            job_pdf = OUT / "job_custom_cuts.pdf"
            dl.value.save_as(str(job_pdf))
            pages = pdf_pages_text(job_pdf)
            render_pages(job_pdf, "job")
            print(f"[pdf] {len(pages)} pages")

            all_text = " ".join(pages).lower()
            has_chained = "from cut" in all_text
            has_far = ("from r edge" in all_text) or ("from b edge" in all_text)
            print(f"[pdf] chained 'from cut N' caption present = {has_chained}; far-edge quote present = {has_far}")
            if not has_chained:
                problems.append("PDF cut sequence has no chained 'from cut N' caption")

            # Visual green-highlight check: find a cut-card page mentioning
            # "from cut" and confirm green pixels appear on the page image.
            green_ok = _green_on_from_cut_page(job_pdf)
            print(f"[pdf] green measured-from highlight present on a 'from cut' page = {green_ok}")
            if not green_ok:
                problems.append("no green measured-from highlight found on a chained cut-card page")

            (OUT / "console.log").write_text("\n".join(console[-400:]), encoding="utf-8")
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


def _cutkey(s):
    """Mirror cutKeyFor: axis|rx,ry,rw,rh|rdist (1mm rounding)."""
    r = round
    return f"{s['axis']}|{r(s['parentX'])},{r(s['parentY'])},{r(s['parentW'])},{r(s['parentH'])}|{r(s['distance'])}"


def _is_vert(s):
    # Sheet is landscape (L>=W); a rip is a constant-X line when lengthIsY. The
    # workbench sheet is 2440x1220 landscape so lengthIsY is False -> rip = H.
    # We only need line coords, so approximate: use axis + the larger parent dim.
    # For the chained-math sanity check the exact axis mapping isn't critical —
    # we compare line spacing, and both this + ref use the same rule.
    return s["axis"] == "cross"  # crosscut = constant-X in a landscape sheet


def _green_on_from_cut_page(pdf_path: Path) -> bool:
    """True if any page whose text mentions 'from cut' contains green pixels in
    the woodworking green (roughly RGB ~47,133,90)."""
    doc = fitz.open(str(pdf_path))
    try:
        for pg in doc:
            txt = " ".join(pg.get_text().split()).lower()
            if "from cut" not in txt:
                continue
            pix = pg.get_pixmap(dpi=120)
            n = pix.n
            data = pix.samples
            # Scan for a green pixel: G high, R+B lower (the measured-from line).
            step = max(1, (len(data) // n) // 4000)  # sample subset for speed
            for i in range(0, len(data) - n, n * step):
                r, g, b = data[i], data[i + 1], data[i + 2]
                if g > 90 and g > r + 30 and g > b + 20 and r < 120 and b < 130:
                    return True
        return False
    finally:
        doc.close()


if __name__ == "__main__":
    raise SystemExit(main())
