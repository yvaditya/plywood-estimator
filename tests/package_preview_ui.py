"""Saved build packages stay readable when a phone preview cannot run scripts."""
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(__file__).resolve().parent / '_output' / 'package'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for mode, width, height in [('phone', 390, 844), ('phone', 844, 390), ('pc', 1440, 1000)]:
        original = (out / f'cabinet_{mode}.html').read_text(encoding='utf-8')
        for failure in ['disabled', 'blocked', 'startup-error']:
            html = original
            if failure == 'blocked':
                html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'">', 1)
            elif failure == 'startup-error':
                html = re.sub(r'<script>.*?</script>', '<script>document.getElementById("app").innerHTML = "Partial startup"; throw new Error("Startup failed");</script>', html, flags=re.S)
            path = out / f'preview_{mode}_{failure}.html'
            path.write_text(html, encoding='utf-8')
            context = browser.new_context(java_script_enabled=failure != 'disabled', offline=True,
                                          viewport={'width': width, 'height': height}, has_touch=mode == 'phone')
            page = context.new_page()
            requests = []
            page.on('request', lambda r: requests.append(r.url) if r.url.startswith(('http:', 'https:')) else None)
            page.goto(path.as_uri(), wait_until='load')
            preview = page.locator('#package-preview')
            expect(preview.get_by_role('heading', name='Workshop cabinet', exact=True)).to_be_visible()
            expect(preview.get_by_role('heading', name='Part inventory', exact=True)).to_be_visible()
            rows = preview.locator('.preview-inventory tbody tr')
            expect(rows).to_have_count(7)
            expect(rows.first).to_contain_text('1a')
            expect(rows.first).to_contain_text('Back')
            expect(rows.first).to_contain_text('564.0 mm')
            expect(rows.first).to_contain_text('18.0 mm')
            expect(rows.filter(has_text='Shelf')).to_have_count(2)
            expect(preview.get_by_role('img', name='Sheet 1 cutting layout')).to_be_visible()
            expect(preview.locator('.preview-cut-steps > li')).to_have_count(17)
            expect(preview.locator('.preview-cut-steps > li').first).to_contain_text('11.5 mm')
            for index, edge in enumerate(['top edge', 'left edge', 'bottom edge', 'right edge']):
                expect(preview.locator('.preview-cut-steps > li').nth(index)).to_contain_text(edge)
            expect(preview).to_contain_text('JavaScript')
            expect(page.locator('#app')).to_be_hidden()
            expect(page.get_by_text('Opening your build package')).to_have_count(0)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'No page overflow'
            assert not requests, requests
            if failure == 'disabled':
                page.screenshot(path=str(out / f'preview_{mode}_{width}.png'), full_page=True)
            context.close()

        context = browser.new_context(offline=True, viewport={'width': width, 'height': height})
        page = context.new_page()
        page.goto((out / f'cabinet_{mode}.html').as_uri(), wait_until='load')
        expect(page.locator('#package-preview')).to_have_count(0)
        expect(page.locator('#app')).to_be_visible()
        expect(page.locator('#inventory-body tr')).to_have_count(7)
        context.close()
    browser.close()

print('Preview checks passed: scripts disabled, blocked, failed, and successful interactive startup')
