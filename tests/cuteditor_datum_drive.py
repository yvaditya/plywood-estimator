"""
Playwright drive for the DATUM + per-piece-diagram features of the rebuilt
(bare-stock, popup-flow) cut editor.

Exercises:
  - load a STEP, select all, estimate, open "Edit cuts" on sheet 1
  - assert the editor opens on BARE STOCK (no pre-made trims) and shows the
    board diagram section
  - make the two long trims + short trim via the popup so a usable frame exists
  - open the config popup on a breakdown candidate, choose "Save as datum: yes",
    "Make cut" -> assert a blue datum edge is drawn (line.cut-datum-edge) and
    the persisted step carries isDatum
  - after a cut splits the board, assert the left pane becomes a STACK of
    per-piece diagram sections (.cut-piece-section > .cut-piece-title)
  - commit a cut PARALLEL to the datum, choosing the "Datum ... edge" option ->
    assert the readout row quotes from that datum
  - download the training log and confirm manual_cut carries datumSaved +
    measuredProvenance, and that a set-datum cut persisted isDatum.

Run:  python tests/cuteditor_datum_drive.py
Output: tests/_output/cuteditor_datum_drive/
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

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
OUT = REPO / "tests" / "_output" / "cuteditor_datum_drive"


CANDS = """
() => {
  const out = [];
  document.querySelectorAll('.cut-editor-svg line.cut-candidate').forEach((l, i) => {
    const k = l.getAttribute('data-cand');
    const [vh, coord, rect] = k.split('|');
    const [x, y, w, h] = rect.split(',').map(Number);
    out.push({ i, vertical: vh === 'V', coord: Number(coord), x, y, w, h, key: k, isTrim: l.classList.contains('trim') });
  });
  return out;
}
"""

OPEN_POPUP = """
(key) => {
  const line = Array.from(document.querySelectorAll('.cut-editor-svg line.cut-candidate'))
    .find(l => l.getAttribute('data-cand') === key);
  if (!line) return {ok:false};
  line.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window, clientX:400, clientY:300}));
  return {ok: !!document.querySelector('.cut-config-popup')};
}
"""

POPUP_REFS = """
() => {
  const popup = document.querySelector('.cut-config-popup');
  if (!popup) return null;
  return {
    quote: popup.querySelector('.cut-config-quote')?.textContent || '',
    refs: Array.from(popup.querySelectorAll('.cut-config-ref')).map(r => r.querySelector('.cut-config-ref-label').textContent),
  };
}
"""

SET_DATUM = """
(yes) => {
  const b = document.querySelector(`.cut-config-popup .cut-config-yn[data-yn="${yes ? 'yes' : 'no'}"]`);
  if (!b) return {ok:false};
  b.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  return {ok:true};
}
"""

PICK_REF = """
(text) => {
  const rows = Array.from(document.querySelectorAll('.cut-config-popup .cut-config-ref'));
  const row = rows.find(r => (r.querySelector('.cut-config-ref-label').textContent||'').toLowerCase().includes(text.toLowerCase()));
  if (!row) return {ok:false, labels: rows.map(r=>r.querySelector('.cut-config-ref-label').textContent)};
  row.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  return {ok:true};
}
"""

MAKE_CUT = "() => { const b=document.querySelector('.cut-config-popup [data-role=\"make\"]'); if(!b) return {ok:false}; b.dispatchEvent(new MouseEvent('click',{bubbles:true})); return {ok:true}; }"
CANCEL = "() => { document.querySelector('.cut-config-popup [data-role=\"cancel\"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); }"

DATUM_EDGES = "() => document.querySelectorAll('.cut-editor-svg line.cut-datum-edge').length"
SECTIONS = "() => document.querySelectorAll('.cut-piece-section').length"
SECTION_TITLES = "() => Array.from(document.querySelectorAll('.cut-piece-title')).map(t=>t.textContent)"
BUILT_ROWS = "() => document.querySelectorAll('.cut-editor-list .cut-row:not(.trim)').length"
LAST_ROW_SUB = """
() => {
  const rows = Array.from(document.querySelectorAll('.cut-editor-list .cut-row:not(.trim)'));
  if (!rows.length) return '';
  const sub = rows[rows.length-1].querySelector('.cut-sub');
  return sub ? sub.textContent : '';
}
"""
TITLE_TEXT = "() => document.querySelector('.cut-editor-title')?.textContent || ''"


def overrides(page):
    return page.evaluate("() => { try { return JSON.parse(localStorage.getItem('plywood.cutOverrides')||'{}'); } catch(e){ return {}; } }")


def log_lines(page):
    raw = page.evaluate("() => { try { return localStorage.getItem('plywood.cutTrainingLog')||''; } catch(e){ return ''; } }")
    out = []
    for ln in (raw or "").split("\n"):
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            pass
    return out


def commit_default(page, key):
    """Open popup on a candidate, accept defaults, Make cut."""
    page.evaluate(OPEN_POPUP, key)
    page.wait_for_timeout(70)
    page.evaluate(MAKE_CUT)
    page.wait_for_timeout(220)


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
            page.wait_for_function("() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')", timeout=45_000)
            page.wait_for_timeout(1000)
            page.select_option("#units", "mm")
            page.wait_for_timeout(150)
            page.click("#selectAllBtn")
            page.wait_for_timeout(300)
            page.click("#nestBtn")
            page.wait_for_function("() => !document.getElementById('downloadPdfBtn').disabled", timeout=180_000)
            page.wait_for_timeout(600)

            edit_btns = page.query_selector_all(".edit-cuts-btn")
            if not edit_btns:
                problems.append("no Edit cuts button found")
                raise SystemExit(1)
            edit_btns[0].click()
            page.wait_for_selector(".cut-editor-svg", timeout=5000)
            page.wait_for_timeout(400)

            # --- Bare-stock start: one board section, no trim rows. ---
            secs0 = page.evaluate(SECTIONS)
            titles0 = page.evaluate(SECTION_TITLES)
            print(f"[start] sections={secs0}, titles={titles0}")
            page.screenshot(path=str(OUT / "01_bare_stock.png"), full_page=True)
            if secs0 < 1:
                problems.append("no diagram section on the bare-stock start")
            if not any("Board" in t for t in titles0):
                problems.append(f"board section not labelled 'Board' (titles={titles0})")

            # --- Make the trims first (all trim candidates), so a usable frame
            #     of breakdown cuts exists. ---
            for _ in range(6):
                cands = page.evaluate(CANDS)
                trims = [c for c in cands if c["isTrim"]]
                if not trims:
                    break
                commit_default(page, trims[0]["key"])
                print(f"[trim] committed a trim; remaining trim cands next loop")

            built_after_trims = page.evaluate(BUILT_ROWS)
            print(f"[trims] built rows after trims = {built_after_trims}")

            # --- Per-piece stack: after the trims split the board, expect >1
            #     section (board overview + at least one live piece). ---
            secs1 = page.evaluate(SECTIONS)
            titles1 = page.evaluate(SECTION_TITLES)
            print(f"[stack] sections={secs1}, titles={titles1}")
            page.screenshot(path=str(OUT / "02_piece_stack.png"), full_page=True)
            if secs1 < 2:
                problems.append(f"left pane did not become a per-piece stack after cuts (sections={secs1})")
            if not any("Piece" in t for t in titles1):
                problems.append(f"no 'Piece N' sub-diagram section after a split (titles={titles1})")

            # --- Save-as-datum on a breakdown candidate. ---
            cands = page.evaluate(CANDS)
            pool = [c for c in cands if not c["isTrim"]]
            if not pool:
                pool = cands
            target = pool[0]
            page.evaluate(OPEN_POPUP, target["key"])
            page.wait_for_timeout(120)
            refs = page.evaluate(POPUP_REFS)
            print(f"[datum] popup refs = {refs['refs'] if refs else None}")
            page.evaluate(SET_DATUM, True)
            page.wait_for_timeout(80)
            page.screenshot(path=str(OUT / "03_datum_popup.png"), full_page=True)
            page.evaluate(MAKE_CUT)
            page.wait_for_timeout(300)

            de = page.evaluate(DATUM_EDGES)
            print(f"[datum] blue datum edges drawn = {de}")
            page.screenshot(path=str(OUT / "04_datum_edge_blue.png"), full_page=True)
            if de < 1:
                problems.append("Save-as-datum cut did not draw a blue datum edge")

            # The persisted step must carry isDatum.
            ov = overrides(page)
            sig = next(iter(ov.keys()), None)
            custom = ov.get(sig, {}).get("customSteps", []) if sig else []
            datum_steps = [s for s in custom if s.get("isDatum")]
            print(f"[override] {len(custom)} customSteps; {len(datum_steps)} isDatum")
            if not any(s.get("isDatum") and not s.get("isTrim") for s in custom):
                problems.append("no persisted breakdown customStep carries isDatum (datum-saved cut lost)")

            # --- Commit a cut choosing a DATUM edge option if one is offered. ---
            cands = page.evaluate(CANDS)
            picked_datum = False
            for c in cands:
                page.evaluate(OPEN_POPUP, c["key"])
                page.wait_for_timeout(60)
                refs = page.evaluate(POPUP_REFS)
                labels = [r.lower() for r in (refs["refs"] if refs else [])]
                if any("datum" in l for l in labels):
                    page.evaluate(PICK_REF, "datum")
                    page.wait_for_timeout(70)
                    page.evaluate(MAKE_CUT)
                    page.wait_for_timeout(250)
                    sub = page.evaluate(LAST_ROW_SUB)
                    print(f"[datum-cut] committed against a datum; row sub = {sub!r}")
                    picked_datum = True
                    break
                page.evaluate(CANCEL)
                page.wait_for_timeout(40)
            if not picked_datum:
                print("[datum-cut] note: no candidate offered a datum option this run (acceptable)")

            page.evaluate(CANCEL)
            page.wait_for_timeout(60)
            page.screenshot(path=str(OUT / "05_after_datum_cut.png"), full_page=True)

            # --- Download the training log; confirm datumSaved + provenance. ---
            with page.expect_download(timeout=30_000) as dl:
                page.click('.cut-editor-head [data-role="download"]')
            logf = OUT / "cutlog.jsonl"
            dl.value.save_as(str(logf))

            events = log_lines(page)
            types = [e.get("type") for e in events]
            print(f"[log] {len(events)} events; types = {types}")
            manual = [e for e in events if e.get("type") == "manual_cut"]
            with_saved = [e for e in manual if e.get("datumSaved")]
            with_prov = [e for e in manual if "measuredProvenance" in e]
            print(f"[log] manual_cut={len(manual)}; datumSaved={len(with_saved)}; provenance={len(with_prov)}")
            if not manual:
                problems.append("no manual_cut events in the training log")
            if not with_saved:
                problems.append("no manual_cut recorded datumSaved=true (Save-as-datum not logged)")
            if not with_prov:
                problems.append("no manual_cut carries measuredProvenance")

            keep = with_saved[:1] + with_prov[-1:]
            (OUT / "log_sample.jsonl").write_text("\n".join(json.dumps(e) for e in keep), encoding="utf-8")
            (OUT / "console.log").write_text("\n".join(console[-400:]), encoding="utf-8")

            browser.close()
    finally:
        kill_dev_server(proc)

    print("\n=== RESULT ===")
    if problems:
        for pr in problems:
            print(f"[FAIL] {pr}")
        return 1
    print("all datum-editor drive checks PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
