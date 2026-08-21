"""
Update-check behaviour, with the GitHub API intercepted.

Every case is driven by a stubbed response, so the test says nothing about
whether the machine is online or where the real repo happens to be — it checks
the app's reaction to each answer GitHub can give.

Run: python tests/update_check.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tests"))

from playwright.sync_api import sync_playwright  # noqa: E402

from visual_check import boot_dev_server, kill_dev_server  # noqa: E402

API = "**api.github.com/repos/**/compare/**"


def behind(n: int, head: str = "f" * 40) -> dict:
    return {
        "status": "behind",
        "behind_by": n,
        "html_url": "https://github.com/x/y/compare/a...b",
        "commits": [{"sha": "a" * 40}, {"sha": head}],
    }


def run_case(pg, port, body, status=200, clear_storage=True):
    """Load the app with a stubbed compare response; return banner state."""
    def handler(route):
        if status != 200:
            route.fulfill(status=status, body="{}",
                          content_type="application/json")
        else:
            route.fulfill(status=200, body=json.dumps(body),
                          content_type="application/json")

    pg.unroute(API)
    if body is None and status == 200:
        pg.route(API, lambda r: r.abort())          # offline / DNS failure
    else:
        pg.route(API, handler)
    pg.goto(f"http://localhost:{port}", wait_until="domcontentloaded")
    if clear_storage:
        pg.evaluate("() => localStorage.clear()")
        pg.reload(wait_until="domcontentloaded")
    # The check is deliberately deferred ~2s after load.
    try:
        pg.wait_for_selector("#updateBanner:not([hidden])", timeout=6000)
        return {
            "shown": True,
            "text": pg.inner_text("#updateBanner").replace("\n", " "),
            "href": pg.get_attribute("#updateDownload", "href"),
        }
    except Exception:
        return {"shown": False}


def main() -> int:
    proc, port = boot_dev_server()
    fails: list[str] = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            ctx = b.new_context(viewport={"width": 1400, "height": 900})
            pg = ctx.new_page()
            errs: list[str] = []
            pg.on("pageerror", lambda e: errs.append(str(e)))

            # The sha the plugin injected must be a real, resolvable one —
            # without it the check can't run at all.
            pg.goto(f"http://localhost:{port}", wait_until="domcontentloaded")
            sha = pg.get_attribute("#versionLine", "data-sha") or ""
            print(f"injected sha: {sha[:12]}… ({len(sha)} chars)")
            if len(sha) != 40:
                fails.append(f"data-sha is not a full sha: {sha!r}")

            cases = [
                ("behind by 5", behind(5), 200, True, True),
                ("identical", {"status": "identical", "behind_by": 0}, 200, True, False),
                ("ahead (unpushed local work)", {"status": "ahead", "behind_by": 0}, 200, True, False),
                ("404 — commit unknown to GitHub", {}, 404, True, False),
                ("403 — rate limited", {}, 403, True, False),
                ("offline", None, 200, True, False),
            ]
            for name, body, status, clear, expect in cases:
                got = run_case(pg, port, body, status, clear)
                ok = got["shown"] == expect
                print(f"  {name:32s} banner={got['shown']!s:5s} expected={expect!s:5s} "
                      f"{'ok' if ok else 'FAIL'}")
                if not ok:
                    fails.append(f"{name}: banner={got['shown']}, expected {expect}")
                if expect and got["shown"]:
                    if "5 commits behind" not in got["text"]:
                        fails.append(f"{name}: text missing count — {got['text']!r}")
                    if not (got["href"] or "").endswith("master.zip"):
                        fails.append(f"{name}: download link wrong — {got['href']!r}")

            # Dismiss must survive a reload, and must key off the head sha so
            # a LATER release can still speak up.
            run_case(pg, port, behind(5), 200, True)
            pg.click("#updateDismiss")
            again = run_case(pg, port, behind(5), 200, clear_storage=False)
            print(f"  {'dismiss sticks':32s} banner={again['shown']!s:5s} expected=False "
                  f"{'ok' if not again['shown'] else 'FAIL'}")
            if again["shown"]:
                fails.append("dismiss did not persist across reload")

            # Expire the 6h result cache but KEEP the dismissal — otherwise
            # this only proves the cache short-circuits the fetch, which is a
            # different claim. What is being tested is that dismissal is keyed
            # to a head sha, so the next release still gets to speak.
            pg.evaluate("() => localStorage.removeItem('wc.updateCheck.v1')")
            newer = run_case(pg, port, behind(9, head="b" * 40), 200, clear_storage=False)
            print(f"  {'newer release still shows':32s} banner={newer['shown']!s:5s} "
                  f"expected=True {'ok' if newer['shown'] else 'FAIL'}")
            if not newer["shown"]:
                fails.append("a newer head sha was suppressed by an old dismissal")

            if errs:
                print("page errors:", errs[:5])
                fails.append(f"{len(errs)} page errors")
    finally:
        kill_dev_server(proc)

    print("\n" + ("FAILED: " + "; ".join(fails) if fails else "ALL CHECKS PASSED"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
