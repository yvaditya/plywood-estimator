"""
End-to-end Playwright drive for the unit-aware dimension inputs.

Exercises the Width / Length / Edge margin / Custom-kerf fields:
  - type "24\"" into Width while units = inches  → field normalises to 24",
    subtext "= 609.6 mm"
  - type "4mm"  into Edge margin (display units still inches) → field
    re-renders as 3/16" (nearest 1/16"), subtext "= 4.0 mm"
  - switch Units → mm: every field re-renders in mm, subtexts flip to inches
  - run an Estimate and assert the per-sheet header shows the mm dimensions
    that came from those fields (609.6 mm x 2438.4 mm)

Run:  python tests/units_drive.py
Output: tests/_output/units_drive/  (screenshots)
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Reuse the server lifecycle helpers from the visual pipeline.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SAMPLE = REPO / "samlple step files" / "Dishwasher cabinrt A.stp"
OUT = REPO / "tests" / "_output" / "units_drive"


def field_value(page, sel: str) -> str:
    return page.locator(sel).input_value()


def field_mm(page, sel: str) -> float:
    return float(page.locator(sel).get_attribute("data-mm"))


def sub_text(page, sel: str) -> str:
    return (page.locator(sel).text_content() or "").strip()


def commit(page, sel: str, text: str) -> None:
    """Type a value into a dim field and fire change/blur by committing."""
    loc = page.locator(sel)
    loc.fill(text)
    # Committing = the 'change' + 'blur' the app listens for. Focus elsewhere.
    loc.blur()
    page.wait_for_timeout(150)


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def run(page, port: int) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    page.goto(f"http://localhost:{port}", wait_until="networkidle")
    page.set_input_files("#fileInput", str(SAMPLE))
    page.wait_for_function(
        "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
        timeout=45_000,
    )
    page.wait_for_timeout(600)

    # Units default = inches.
    expect(page.locator("#units").input_value() == "in", "units should default to inches")

    # 1) Type 24" into Width -> normalises to 24", subtext = 609.6 mm.
    commit(page, "#sheetW", '24"')
    expect(field_value(page, "#sheetW") == '24"', f'Width value: {field_value(page, "#sheetW")!r}')
    expect(sub_text(page, "#sheetWSub") == "= 609.6 mm", f'Width sub: {sub_text(page, "#sheetWSub")!r}')
    expect(abs(field_mm(page, "#sheetW") - 609.6) < 0.05, "Width mm mismatch")

    # 2) Type 4mm into Edge margin while display units are inches ->
    #    field re-renders as a fractional inch (3/16" at 1/16" precision),
    #    subtext = 4.0 mm.
    commit(page, "#margin", "4mm")
    mval = field_value(page, "#margin")
    expect('"' in mval and "mm" not in mval, f'margin should render in inches: {mval!r}')
    expect(mval == '3/16"', f'margin value (nearest 1/16"): {mval!r}')
    expect(sub_text(page, "#marginSub") == "= 4.0 mm", f'margin sub: {sub_text(page, "#marginSub")!r}')
    expect(abs(field_mm(page, "#margin") - 4.0) < 0.05, "margin mm mismatch")

    # Feet parsing into Length: "8ft" -> 96" -> 2438.4 mm.
    commit(page, "#sheetL", "8ft")
    expect(field_value(page, "#sheetL") == '96"', f'Length value: {field_value(page, "#sheetL")!r}')
    expect(abs(field_mm(page, "#sheetL") - 2438.4) < 0.05, "Length mm mismatch")

    # Garbage reverts silently to the last-good value.
    commit(page, "#sheetW", "not-a-number")
    expect(field_value(page, "#sheetW") == '24"', f'garbage should revert Width: {field_value(page, "#sheetW")!r}')

    page.screenshot(path=str(OUT / "01_inches_subtexts.png"), full_page=True)

    # Widen the sheet so the parts actually nest for the Estimate step below.
    # (A 24"-wide sheet leaves every dishwasher panel unplaced — fine for the
    # parser checks above, but we want a real layout to read the header from.)
    commit(page, "#sheetW", '48"')
    expect(abs(field_mm(page, "#sheetW") - 1219.2) < 0.05, "Width reset to 48in")

    # 3) Switch Units -> mm. Fields re-render in mm, subtexts flip to inches.
    page.select_option("#units", "mm")
    page.wait_for_timeout(200)
    expect(field_value(page, "#sheetW") == "1219.2 mm", f'Width mm value: {field_value(page, "#sheetW")!r}')
    expect(sub_text(page, "#sheetWSub") == '= 48"', f'Width sub in mm mode: {sub_text(page, "#sheetWSub")!r}')
    expect(field_value(page, "#sheetL") == "2438.4 mm", f'Length mm value: {field_value(page, "#sheetL")!r}')
    expect(field_value(page, "#margin") == "4.0 mm", f'margin mm value: {field_value(page, "#margin")!r}')
    expect(sub_text(page, "#marginSub") == '= 3/16"', f'margin sub in mm mode: {sub_text(page, "#marginSub")!r}')
    expect(abs(field_mm(page, "#sheetW") - 1219.2) < 0.05, "Width mm preserved across unit switch")

    page.screenshot(path=str(OUT / "02_mm_subtexts.png"), full_page=True)

    # Screenshot just the Stock + Cutting groups showing the subtexts.
    stock = page.query_selector('[data-group="stock"]')
    if stock:
        stock.screenshot(path=str(OUT / "03_stock_group.png"))
    cutting = page.query_selector('[data-group="cutting"]')
    if cutting:
        cutting.screenshot(path=str(OUT / "04_cutting_group.png"))

    # 4) Run an Estimate; assert a sheet header shows the mm dims from the
    #    fields (1219.2 x 2438.4 mm).
    page.click("#selectAllBtn")
    page.wait_for_timeout(200)
    page.click("#nestBtn")
    page.wait_for_function(
        "() => !document.getElementById('downloadPdfBtn').disabled",
        timeout=120_000,
    )
    # Wait for the stacked sheet list to actually render into #detailSvg.
    page.wait_for_function(
        "() => document.querySelectorAll('.sheet-entry-meta').length > 0",
        timeout=30_000,
    )
    page.wait_for_timeout(400)

    metas = page.eval_on_selector_all(
        ".sheet-entry-meta", "els => els.map(e => e.textContent)"
    )
    joined = " || ".join(m.strip() for m in metas)
    expect(
        any(("1219.2 mm" in m and "2438.4 mm" in m) for m in metas),
        f"sheet header should show 1219.2 mm x 2438.4 mm; got: {joined!r}",
    )

    page.screenshot(path=str(OUT / "05_estimated.png"), full_page=True)
    print("[ok] units_drive: all assertions passed")
    print(f"     sheet meta sample: {metas[0].strip() if metas else '(none)'}")


def main() -> int:
    proc, port = boot_dev_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(accept_downloads=True)
            page = ctx.new_page()
            console_lines: list[str] = []
            page.on("console", lambda m: console_lines.append(f"[{m.type}] {m.text}"))
            try:
                run(page, port)
            except Exception:
                import traceback
                OUT.mkdir(parents=True, exist_ok=True)
                try:
                    page.screenshot(path=str(OUT / "FAIL.png"), full_page=True)
                except Exception:
                    pass
                (OUT / "console.log").write_text("\n".join(console_lines[-300:]), encoding="utf-8")
                traceback.print_exc()
                return 1
            finally:
                ctx.close()
                browser.close()
    finally:
        kill_dev_server(proc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
