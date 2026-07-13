"""
Benchmark the assembly linear solve: PCG vs Eigen LDLT (wasm) on the plywood
workbench under the "50 kg on top" preset, in the real browser drive.

Solves the SAME assembly system twice:
  1. Eigen LDLT (wasm) — the sparse-direct backend (default)
  2. PCG               — forced via window.__caeForcePcg = true

Reports each backend's timing (factorize + solve ms for LDLT; iterations + ms
for PCG), parsed from the result line and the [assembly] console log.

Run:  python tests/asm_bench.py
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


def solve_once(page, label: str, console: list[str]) -> str:
    before = len(console)
    prev_asm = sum(1 for c in console if "[assembly]" in c.lower())
    # Clear the result so we can detect the NEW solve's line (and don't race a
    # stale one). Then wait for a fresh [assembly] console log to appear.
    page.evaluate("() => { const el = document.getElementById('asmResult'); if (el) el.textContent = ''; }")
    page.click("#asmSolveBtn")
    page.wait_for_function(
        "() => { const el = document.getElementById('asmResult'); "
        "return el && /(deflection|floor|non-physical)/i.test(el.textContent || ''); }",
        timeout=90_000,
    )
    # Give the console event a beat to flush the [assembly] log line.
    page.wait_for_timeout(300)
    result = page.eval_on_selector("#asmResult", "el => el.textContent")
    asm_logs = [c for c in console[before:] if "[assembly]" in c.lower()]
    now_asm = sum(1 for c in console if "[assembly]" in c.lower())
    if now_asm <= prev_asm:
        print(f"  WARNING: no new [assembly] log for {label} (solve may not have re-run)")

    def ascii_safe(s: str) -> str:
        return s.encode("ascii", "replace").decode("ascii")

    print(f"\n=== {label} ===")
    print(f"  result: {ascii_safe(result)}")
    for c in asm_logs:
        print(f"  log:    {ascii_safe(c)}")
    return result


def main() -> int:
    proc, port = boot_dev_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
            page = ctx.new_page()
            console: list[str] = []
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
            page.click("#asmDetectBtn")
            page.wait_for_timeout(600)
            page.click("#asmPreset50")
            page.wait_for_timeout(300)

            # 1) Eigen LDLT (wasm) — default backend.
            page.evaluate("() => { window.__caeForcePcg = false; }")
            ldlt = solve_once(page, "Eigen LDLT (wasm)", console)

            # 2) PCG — force the fallback on the identical system.
            page.evaluate("() => { window.__caeForcePcg = true; }")
            page.wait_for_timeout(200)
            pcg = solve_once(page, "PCG (forced fallback)", console)

            browser.close()
    finally:
        kill_dev_server(proc)

    # Parse the numbers out for a compact summary.
    def grab(pat, text):
        m = re.search(pat, text, re.I)
        return m.group(1) if m else "?"

    ldlt_factor = grab(r"factor\s+(\d+)\s*ms", ldlt)
    ldlt_solve = grab(r"solve\s+(\d+)\s*ms", ldlt)
    pcg_iters = grab(r"PCG:\s*(\d+)\s*iters", pcg)
    pcg_ms = grab(r"iters,\s*(\d+)\s*ms", pcg)

    print("\n================ BENCHMARK SUMMARY ================")
    print(f"  Eigen LDLT (wasm): factorize {ldlt_factor} ms + solve {ldlt_solve} ms")
    print(f"  PCG (fallback):    {pcg_iters} iterations, {pcg_ms} ms")
    print("==================================================")

    ok = "eigen ldlt" in ldlt.lower() and "pcg" in pcg.lower()
    print("PASS" if ok else "FAIL: backends did not run as expected")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
