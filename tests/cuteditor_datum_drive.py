"""
Playwright drive for the DATUM-EDGE feature of the direct-cutting cut editor.

Exercises the new edge context popup + datum edges:
  - load a STEP, select all, estimate, open "Edit cuts" on sheet 1
  - ⏺ Record (so set_datum / manual_cut events land in the log)
  - click a live piece EDGE  -> screenshot the context popup
  - "Set as datum edge"      -> screenshot the blue datum edge; assert a
                                line.cut-datum-edge appears
  - commit a cut PARALLEL to the datum WITHOUT arming -> assert the readout
    row + persisted step quote from that edge (fromFar when the datum is far)
  - make another cut and verify the datum PROPAGATED to the child piece (blue
    edge still shown; still the default measuring edge)
  - download the training log and confirm set_datum + measured-from provenance
    fields are present.

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


# --- DOM helpers (evaluated in the page) ------------------------------------

# Parse every candidate's data-cand ("V|coord|x,y,w,h") into region rects, and
# return, per candidate, its orientation + region. We use this to pick a
# candidate whose region is NOT the seed piece (a child produced by a cut) so a
# FAR-edge datum actually drives fromFar (the seed's left/top are implicit
# datums that always win the near slot).
CANDS = """
() => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return [];
  return Array.from(svg.querySelectorAll('line.cut-candidate')).map((l, i) => {
    const k = l.getAttribute('data-cand');           // V|coord|x,y,w,h
    const [vh, coord, rect] = k.split('|');
    const [x, y, w, h] = rect.split(',').map(Number);
    return { i, vertical: vh === 'V', coord: Number(coord), x, y, w, h, key: k };
  });
}
"""

CLICK_CAND_BY_INDEX = """
(idx) => {
  const svg = document.querySelector('.cut-editor-svg');
  const cands = Array.from(svg.querySelectorAll('line.cut-candidate'));
  if (idx >= cands.length) return {ok:false, n:cands.length};
  cands[idx].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
  return {ok:true, n:cands.length, cand:cands[idx].getAttribute('data-cand')};
}
"""

# Click the edge band for a given region rect + side. Bands carry data-side and
# sit half-inset on the region boundary; match by geometry + side.
CLICK_EDGE_BAND = """
(arg) => {
  const {x, y, w, h, side} = arg;
  const svg = document.querySelector('.cut-editor-svg');
  const bands = Array.from(svg.querySelectorAll('rect.cut-edge-band'));
  const near = (a, b) => Math.abs(a - b) < 2;
  let hit = null;
  for (const b of bands) {
    if (b.getAttribute('data-side') !== side) continue;
    const bx = parseFloat(b.getAttribute('x')), by = parseFloat(b.getAttribute('y'));
    const bw = parseFloat(b.getAttribute('width')), bh = parseFloat(b.getAttribute('height'));
    // Reconstruct the region edge this band covers.
    let ok = false;
    if (side === 'left')   ok = near(bx + bw/2, x)     && near(by, y) && near(bh, h);
    if (side === 'right')  ok = near(bx + bw/2, x + w) && near(by, y) && near(bh, h);
    if (side === 'top')    ok = near(by + bh/2, y)     && near(bx, x) && near(bw, w);
    if (side === 'bottom') ok = near(by + bh/2, y + h) && near(bx, x) && near(bw, w);
    if (ok) { hit = b; break; }
  }
  if (!hit) return {ok:false, n:bands.length};
  // Position the synthetic click at the band center so the popup opens there.
  const r = hit.getBoundingClientRect();
  hit.dispatchEvent(new MouseEvent('click', {
    bubbles:true, cancelable:true, view:window,
    clientX: r.left + r.width/2, clientY: r.top + r.height/2,
  }));
  return {ok:true};
}
"""

MENU_ITEMS = """
() => Array.from(document.querySelectorAll('.cut-edge-menu .cut-edge-menu-item'))
        .map(b => b.textContent)
"""

CLICK_MENU_ITEM = """
(text) => {
  const items = Array.from(document.querySelectorAll('.cut-edge-menu .cut-edge-menu-item'));
  const it = items.find(b => (b.textContent||'').includes(text));
  if (!it) return {ok:false, items: items.map(b=>b.textContent)};
  it.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
  return {ok:true};
}
"""

DATUM_EDGE_COUNT = """
() => {
  const svg = document.querySelector('.cut-editor-svg');
  if (!svg) return 0;
  return svg.querySelectorAll('line.cut-datum-edge').length;
}
"""

BUILT_ROWS = """
() => {
  const list = document.querySelector('.cut-editor-list');
  return list ? list.querySelectorAll('.cut-row:not(.trim)').length : -1;
}
"""

# The sub-text of the LAST built (non-trim) row: "from R edge · piece 800x600".
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
    return page.evaluate(
        "() => { try { return JSON.parse(localStorage.getItem('plywood.cutOverrides')||'{}'); } catch(e){ return {}; } }"
    )


def log_lines(page):
    raw = page.evaluate(
        "() => { try { return localStorage.getItem('plywood.cutTrainingLog')||''; } catch(e){ return ''; } }"
    )
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
            if not edit_btns:
                problems.append("no Edit cuts button found")
                raise SystemExit(1)
            edit_btns[0].click()
            page.wait_for_selector(".cut-editor-svg", timeout=5000)
            page.wait_for_timeout(400)

            # Turn recording ON so set_datum / manual_cut events are logged.
            page.click('.cut-editor-head [data-role="record"]')
            page.wait_for_timeout(150)

            # Walk the breakdown until a live region has an INTERIOR left edge
            # (a cut line, not the implicit left datum) AND a vertical candidate.
            # Setting that region's RIGHT edge as a datum then genuinely drives
            # fromFar (the near/left datum slot is free). The workbench's first
            # cut frees a full-height strip, so one or two breakdown cuts get us
            # to a multi-part right child.
            def group_regions(cands):
                regions = {}
                for c in cands:
                    key = (round(c["x"]), round(c["y"]), round(c["w"]), round(c["h"]))
                    regions.setdefault(key, []).append(c)
                return regions

            target = None
            usable_left = None
            for step in range(6):
                cands = page.evaluate(CANDS)
                if not cands:
                    break
                regions = group_regions(cands)
                usable_left = min(k[0] for k in regions.keys())
                for key, cs in regions.items():
                    x, y, w, h = key
                    if x > usable_left + 3 and any(c["vertical"] for c in cs):
                        target = (key, cs)
                        break
                if target is not None:
                    print(f"[walk] found interior-left region after {step} extra cut(s)")
                    break
                # Commit the first candidate and look again.
                r = page.evaluate(CLICK_CAND_BY_INDEX, 0)
                print(f"[walk step {step}] committed {r.get('cand')}")
                page.wait_for_timeout(250)

            print(f"[regions] usable-left (implicit datum X) = {usable_left}")
            if target is None:
                problems.append("no live region with an interior left edge + vertical candidate found")
                raise SystemExit(1)

            (tx, ty, tw, th), tcands = target
            print(f"[target] region ({tx},{ty},{tw},{th}); left-interior={tx>usable_left+3}")

            # --- Open the edge context popup on the target region's RIGHT edge.
            band = page.evaluate(CLICK_EDGE_BAND, {"x": tx, "y": ty, "w": tw, "h": th, "side": "right"})
            print(f"[edge] open right-edge menu = {band}")
            page.wait_for_timeout(200)
            items = page.evaluate(MENU_ITEMS)
            print(f"[popup] items = {items}")
            page.screenshot(path=str(OUT / "01_edge_popup.png"), full_page=True)
            if not any("datum" in (i or "").lower() for i in items):
                problems.append(f"edge popup missing datum option (items={items})")

            # --- Set as datum edge.
            page.evaluate(CLICK_MENU_ITEM, "Set as datum edge")
            page.wait_for_timeout(250)
            de = page.evaluate(DATUM_EDGE_COUNT)
            print(f"[datum] blue datum edges drawn = {de}")
            page.screenshot(path=str(OUT / "02_datum_edge_blue.png"), full_page=True)
            if de < 1:
                problems.append("Set as datum edge did not draw a blue datum edge")

            # --- Commit a VERTICAL candidate in the target region (parallel to
            #     the right datum) WITHOUT arming. Expect it quoted fromFar.
            cands2 = page.evaluate(CANDS)
            v_in_target = [
                c for c in cands2
                if c["vertical"] and round(c["x"]) == tx and round(c["y"]) == ty
                and round(c["w"]) == tw and round(c["h"]) == th
            ]
            if not v_in_target:
                problems.append("no vertical candidate remained in the datum region")
            else:
                idx = v_in_target[0]["i"]
                built_before = page.evaluate(BUILT_ROWS)
                page.evaluate(CLICK_CAND_BY_INDEX, idx)
                page.wait_for_timeout(300)
                built_after = page.evaluate(BUILT_ROWS)
                sub = page.evaluate(LAST_ROW_SUB)
                print(f"[cut-parallel] built {built_before}->{built_after}; last row sub = {sub!r}")
                if "from R edge" not in sub and "from B edge" not in sub:
                    problems.append(f"cut parallel to a far datum did not quote from the far edge (sub={sub!r})")

            page.screenshot(path=str(OUT / "03_datum_cut_committed.png"), full_page=True)

            # Persisted override: datumEdges present + last customStep fromFar.
            ov = overrides(page)
            sig = next(iter(ov.keys()), None)
            entry = ov.get(sig, {}) if sig else {}
            datum_edges = entry.get("datumEdges", [])
            custom = entry.get("customSteps", [])
            print(f"[override] datumEdges = {datum_edges}")
            print(f"[override] last customStep = {custom[-1] if custom else None}")
            if not datum_edges:
                problems.append("no datumEdges persisted to SheetOverrides")
            if custom and not custom[-1].get("fromFar"):
                problems.append("the cut committed against a far datum did not persist fromFar")

            # --- Propagation: the vertical cut above split the datum region into
            #     a left child + a right child that RETAINS the right datum edge.
            #     The persisted datumEdges already re-anchored to the child rect
            #     (proof the datum moved). The blue edge must still be shown, and
            #     it must still show after a FURTHER cut.
            datum_coord = tx + tw  # the right-datum X line
            de_now = page.evaluate(DATUM_EDGE_COUNT)
            print(f"[propagate] datum re-anchored to child = {datum_edges}; blue edges = {de_now}")
            reanchored = any(
                de.get("side") == "right" and round(float(de["piece"].split(",")[0]) + float(de["piece"].split(",")[2])) == round(datum_coord)
                for de in datum_edges
            )
            if not reanchored:
                problems.append(f"datum did not re-anchor to a child piece at X={datum_coord} (datumEdges={datum_edges})")

            # Commit ANOTHER cut and confirm a blue datum edge is STILL drawn.
            cands3 = page.evaluate(CANDS)
            # Prefer a candidate whose region still carries the datum on its right
            # edge (so we cut a datum-bearing child), else any candidate.
            bearing = [c for c in cands3 if round(c["x"] + c["w"]) == round(datum_coord)]
            pool = bearing if bearing else cands3
            pick = pool[0]["i"] if pool else None
            if pick is not None:
                page.evaluate(CLICK_CAND_BY_INDEX, pick)
                page.wait_for_timeout(300)
            de_after = page.evaluate(DATUM_EDGE_COUNT)
            print(f"[propagate] blue datum edges after another cut = {de_after}")
            page.screenshot(path=str(OUT / "04_datum_propagated.png"), full_page=True)
            if de_after < 1:
                problems.append("datum edge did not propagate to a child piece after a further cut")

            # --- Download the training log; confirm set_datum + provenance.
            with page.expect_download(timeout=30_000) as dl:
                page.click('.cut-editor-head [data-role="download"]')
            logf = OUT / "cutlog.jsonl"
            dl.value.save_as(str(logf))

            events = log_lines(page)
            types = [e.get("type") for e in events]
            print(f"[log] {len(events)} events; types = {types}")
            set_datum_evs = [e for e in events if e.get("type") == "set_datum"]
            manual_evs = [e for e in events if e.get("type") == "manual_cut"]
            print(f"[log] set_datum events = {len(set_datum_evs)}")
            if set_datum_evs:
                print(f"[log] set_datum sample = {json.dumps(set_datum_evs[0])}")
            prov_evs = [e for e in manual_evs if "measuredProvenance" in e]
            datum_prov = [e for e in prov_evs if e.get("measuredProvenance") == "datum"]
            if prov_evs:
                print(f"[log] manual_cut w/ provenance sample = {json.dumps(prov_evs[-1])}")
            if not set_datum_evs:
                problems.append("no set_datum event in the training log")
            if not any(e.get("piece_key") and e.get("side") for e in set_datum_evs):
                problems.append("set_datum event missing piece_key/side fields")
            if not prov_evs:
                problems.append("no manual_cut carries measuredFrom/measuredProvenance")
            if not datum_prov:
                problems.append("no manual_cut recorded 'datum' provenance")

            # Persist the interesting log lines for the report.
            keep = set_datum_evs[:1] + datum_prov[:1] + prov_evs[-1:]
            (OUT / "log_sample.jsonl").write_text(
                "\n".join(json.dumps(e) for e in keep), encoding="utf-8"
            )
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
