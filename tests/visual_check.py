"""
Visual smoke-test pipeline for the PDF export.

For each sample STEP file in ``samlple step files/``:
  1. boots the Vite dev server (background)
  2. drives a headless Chromium through Playwright
     - load STEP, select all bodies, click Estimate, download PDF
  3. saves the PDF + per-page PNGs into ``tests/_output/<sample>/``

The output folder is gitignored — purely for human / Claude visual review.

Dependencies (host):
  pip install playwright pymupdf
  playwright install chromium

Usage:
  python tests/visual_check.py                 # all samples
  python tests/visual_check.py "Dishwasher"    # filter by substring
"""
from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

import fitz  # PyMuPDF — PDF → PNG
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
APP_DIR = REPO / "app"
SAMPLES_DIR = REPO / "samlple step files"
OUT_DIR = REPO / "tests" / "_output"


# ----------------------------------------------------------------------------
# Dev server lifecycle
# ----------------------------------------------------------------------------
def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def boot_dev_server() -> Tuple[subprocess.Popen, int]:
    """Start ``npm run dev`` on a free port. Block until vite prints 'ready'."""
    port = _free_port()
    print(f"[server] starting vite on port {port}")
    npm = shutil.which("npm") or ("npm.cmd" if os.name == "nt" else "npm")
    proc = subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(port), "--strictPort"],
        cwd=str(APP_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        shell=False,
    )
    assert proc.stdout is not None
    deadline = time.time() + 45
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("vite exited before becoming ready")
            time.sleep(0.05)
            continue
        sys.stdout.write(f"[server] {line}")
        if "ready in" in line or re.search(r"http://localhost:\d+", line):
            # vite is up — keep a thread draining stdout so it doesn't block.
            import threading
            def drain() -> None:
                for ln in proc.stdout:  # type: ignore[union-attr]
                    pass
            threading.Thread(target=drain, daemon=True).start()
            return proc, port
    raise RuntimeError("timed out waiting for vite to start")


def kill_dev_server(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ----------------------------------------------------------------------------
# Single-sample run
# ----------------------------------------------------------------------------
def run_sample(page, sample_path: Path, port: int, out_dir: Path) -> Path:
    """Drive one sample through the app, return the saved PDF path."""
    name = sample_path.stem
    sample_out = out_dir / name
    if sample_out.exists():
        shutil.rmtree(sample_out)
    sample_out.mkdir(parents=True)

    print(f"[run] {name}")
    page.goto(f"http://localhost:{port}", wait_until="networkidle")

    # Load the STEP via the hidden file input
    page.set_input_files("#fileInput", str(sample_path))

    # Wait for non-zero body count
    page.wait_for_function(
        "() => /[1-9]/.test(document.getElementById('bodyCount')?.textContent || '')",
        timeout=45_000,
    )
    page.wait_for_timeout(1500)  # let the 3D scene settle for clean snapshots
    page.screenshot(path=str(sample_out / "ui_loaded.png"), full_page=True)

    page.click("#selectAllBtn")
    page.wait_for_timeout(200)

    page.click("#nestBtn")
    # Estimate complete → PDF button enabled
    page.wait_for_function(
        "() => !document.getElementById('downloadPdfBtn').disabled",
        timeout=120_000,
    )
    page.wait_for_timeout(1000)
    page.screenshot(path=str(sample_out / "ui_estimated.png"), full_page=True)

    with page.expect_download(timeout=120_000) as dl_info:
        page.click("#downloadPdfBtn")
    pdf_path = sample_out / f"{name}.pdf"
    dl_info.value.save_as(str(pdf_path))
    return pdf_path


def pdf_to_pngs(pdf_path: Path, dpi: int = 110) -> int:
    """Render each page of ``pdf_path`` as a PNG next to the PDF. Returns count."""
    out_dir = pdf_path.parent
    doc = fitz.open(str(pdf_path))
    pages = doc.page_count
    text_summary: List[str] = [f"# {pdf_path.name}  ({pages} pages)\n"]
    for i, pg in enumerate(doc):
        pix = pg.get_pixmap(dpi=dpi)
        pix.save(str(out_dir / f"page-{i + 1:02d}.png"))
        snippet = pg.get_text().strip().replace("\n", " | ")[:240]
        text_summary.append(f"## p{i + 1} ({pg.rect.width:.0f}x{pg.rect.height:.0f})\n{snippet}\n")
    doc.close()
    (out_dir / "summary.md").write_text("\n".join(text_summary), encoding="utf-8")
    return pages


# ----------------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None) -> int:
    argv = argv or sys.argv[1:]
    filter_substr = argv[0].lower() if argv else ""

    samples = sorted([p for p in SAMPLES_DIR.glob("*.stp") if filter_substr in p.stem.lower()])
    if not samples:
        print(f"[err] no samples matched filter {filter_substr!r}", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    proc, port = boot_dev_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for sample in samples:
                t0 = time.time()
                ctx = browser.new_context(accept_downloads=True)
                page = ctx.new_page()
                console_lines: List[str] = []
                page.on("console", lambda m: console_lines.append(f"[{m.type}] {m.text}"))
                try:
                    pdf = run_sample(page, sample, port, OUT_DIR)
                    pages = pdf_to_pngs(pdf)
                    (pdf.parent / "console.log").write_text(
                        "\n".join(console_lines[-300:]), encoding="utf-8"
                    )
                    print(f"[ok] {sample.stem}: {pages} pages, {time.time() - t0:.1f}s")
                except Exception as exc:
                    import traceback
                    print(f"[FAIL] {sample.stem}: {exc}")
                    traceback.print_exc()
                    try:
                        page.screenshot(path=str(OUT_DIR / f"{sample.stem}_FAIL.png"), full_page=True)
                    except Exception:
                        pass
                finally:
                    try:
                        ctx.close()
                    except Exception:
                        pass
            browser.close()
    finally:
        kill_dev_server(proc)

    print(f"[done] output under {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
