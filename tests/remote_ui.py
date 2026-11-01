"""Shop remote end to end: desktop publishes, a phone on the LAN reads the job,
edits the cut list, and the desktop re-plans.

    python tests/remote_ui.py [desktop_url] [phone_url] [step_file]
"""
import json
import sys
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

repo = Path(__file__).resolve().parent.parent
out = repo / 'tests' / '_output' / 'remote'
out.mkdir(parents=True, exist_ok=True)
desk_url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:5173'
lan = json.load(urllib.request.urlopen(desk_url + '/__remote/info'))['addresses'][0]
phone_url = sys.argv[2] if len(sys.argv) > 2 else f'http://{lan}:5173/remote.html'
step = Path(sys.argv[3]) if len(sys.argv) > 3 else repo / 'samlple step files' / '30x12x42 A.stp'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader'])
    desk = browser.new_page(viewport={'width': 1500, 'height': 1000})
    errors = []
    desk.on('pageerror', lambda e: errors.append(f'desk: {e}'))
    desk.goto(desk_url, wait_until='load')
    desk.set_input_files('#fileInput', str(step))
    desk.wait_for_function("() => Number(document.querySelector('#bodyCount').textContent.trim().split(' ')[0]) > 0", timeout=90000)
    desk.locator('#selectAllBtn').click()
    desk.locator('#nestBtn').click()
    expect(desk.locator('#nestBtn')).to_have_text('Estimate cut sheets', timeout=180000)

    # QR popover in the header corner
    expect(desk.locator('#remoteBtn')).to_be_visible()
    desk.locator('#remoteBtn').click()
    expect(desk.locator('.remote-pop svg')).to_be_visible()
    expect(desk.locator('.remote-url')).to_have_text('http://woodworking.local:5173/remote.html')
    desk.screenshot(path=str(out / 'desk_qr.png'))

    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    phone = ctx.new_page()
    phone.on('pageerror', lambda e: errors.append(f'phone: {e}'))
    phone.goto(phone_url, wait_until='load')
    expect(phone.locator('#conn')).to_have_class('r-conn on', timeout=15000)
    expect(desk.locator('#remoteBtn')).to_have_class('remote-btn live')

    # 1. Inventory
    expect(phone.locator('#tab-inventory .r-panel').first).to_be_visible(timeout=15000)
    expect(phone.locator('#tab-inventory .r-sheet-icon').first).to_be_visible()
    phone.screenshot(path=str(out / 'phone_1_inventory.png'), full_page=True)

    # 2. Cut list: bump the first panel's qty, desktop must follow and re-plan
    phone.locator('.r-tabs [data-tab="cuts"]').click()
    expect(phone.locator('.r-sheet').first).to_be_visible()
    first = phone.locator('.r-edit').first
    before = int(first.locator('output').inner_text())
    sheets_before = phone.locator('.r-sheet').count()
    first.locator('[data-d="1"]').click()
    desk.wait_for_function(f"() => [...document.querySelectorAll('#bodyList input[data-field=qty]')].some(i => i.value === '{before + 1}')"
                           " || document.querySelector('#loadStatus').textContent.includes('Phone edit')", timeout=15000)
    expect(desk.locator('#loadStatus')).to_contain_text('Phone edit')
    expect(phone.locator('.r-edit').first.locator('output')).to_have_text(str(before + 1), timeout=30000)
    expect(phone.locator('#banner')).to_be_hidden(timeout=180000)
    phone.locator('.r-steps button').first.click()
    expect(phone.locator('.r-cutline')).to_have_count(1)
    phone.locator('.r-part').first.click()
    expect(phone.locator('#card')).to_be_visible()
    phone.screenshot(path=str(out / 'phone_2_cutlist.png'), full_page=True)
    print(f'qty {before} -> {before + 1}; sheets {sheets_before} -> {phone.locator(".r-sheet").count()}')

    # progress tick syncs through the bridge
    phone.locator('#card input[data-prog="cut"]').first.check()

    # 3. 3D: tap a chip -> spin + ghost; tap model -> card
    phone.locator('.r-tabs [data-tab="3d"]').click()
    expect(phone.locator('#model canvas')).to_be_visible(timeout=30000)
    phone.locator('.r-chip').nth(1).click()
    phone.wait_for_timeout(2600)
    expect(phone.locator('#card')).to_be_visible()
    phone.screenshot(path=str(out / 'phone_3_3d.png'))

    # restore the original qty so the desktop job is left as found
    phone.locator('.r-tabs [data-tab="cuts"]').click()
    phone.locator('.r-edit').first.locator('[data-d="-1"]').click()
    expect(phone.locator('.r-edit').first.locator('output')).to_have_text(str(before), timeout=30000)
    urllib.request.urlopen(urllib.request.Request(desk_url + '/__remote/progress-reset', method='POST'))
    assert not errors, errors
    browser.close()
print('Shop remote: QR, LAN load, inventory, live cut-list edit, re-plan, 3D focus passed')
