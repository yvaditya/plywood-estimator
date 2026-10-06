"""UI smoke test against a running Vite server; pass a local STEP path."""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

file = Path(sys.argv[1]).resolve()
url = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:5173"
out = Path(__file__).resolve().parent / "_output" / "optimizer_ui"
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    def on_error(error):
        errors.append(str(error))
        print(f"BROWSER ERROR: {error}", flush=True)
    page.on("pageerror", on_error)
    page.goto(url, wait_until="networkidle")
    assert "Repeated long rips" in page.locator("#cutStrategy").inner_text()
    page.set_input_files("#fileInput", str(file))
    page.wait_for_function("() => /[1-9]/.test(document.querySelector('#bodyCount').textContent)", timeout=60000)
    page.locator("#selectAllBtn").click()
    page.select_option("#restarts", "32")
    page.select_option("#cutStrategy", "repeated")
    assert page.input_value("#sequenceStyle") == "optimized"
    results = []
    modes = ["repeated"] if "--repeated-only" in sys.argv else ["guillotine", "repeated", "free", "cnc"]
    for strategy in modes:
        page.select_option("#cutStrategy", strategy)
        start = time.perf_counter()
        page.locator("#nestBtn").click()
        page.wait_for_function("() => !document.querySelector('#nestBtn').disabled && !document.querySelector('#downloadPdfBtn').disabled", timeout=120000)
        result = {"strategy": strategy, "seconds": round(time.perf_counter() - start, 2),
                  "sheets": page.locator(".sheet-entry-meta").all_text_contents()}
        results.append(result)
        print(json.dumps(result), flush=True)
        page.screenshot(path=str(out / f"{strategy}.png"), full_page=True)
    page.select_option("#cutStrategy", "repeated")
    page.locator("#nestBtn").click()
    page.wait_for_function("() => !document.querySelector('#nestBtn').disabled && !document.querySelector('#downloadPdfBtn').disabled", timeout=120000)
    page.locator("#optimizeMoreBtn").click()
    try:
        page.wait_for_function("() => !document.querySelector('#nestBtn').disabled && !document.querySelector('#optimizeMoreBtn').disabled", timeout=120000)
    except Exception:
        print(page.locator("body").inner_text()[:6000], flush=True)
        page.screenshot(path=str(out / "failure.png"), full_page=True)
        raise
    assert page.input_value("#sequenceStyle") == "optimized"
    assert not errors, errors
    (out / "summary.json").write_text(json.dumps({"runs": results, "browserErrors": errors}, indent=2), encoding="utf-8")
    print(f"PASS: {len(modes)} modes, long-rip sequence, Optimize further, no browser errors", flush=True)
    browser.close()
