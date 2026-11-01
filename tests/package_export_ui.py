"""Exercise the actual app export buttons, then open both saved downloads offline."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out=Path(__file__).resolve().parent/'_output'/'package'
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:5187'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1500,'height':1100},accept_downloads=True)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(url,wait_until='networkidle')
    expect(page.locator('#downloadPcHtmlBtn')).to_be_disabled()
    expect(page.locator('#downloadPhoneHtmlBtn')).to_be_disabled()
    page.set_input_files('#fileInput',str(out/'cabinet.step'))
    page.wait_for_function("() => document.querySelector('#bodyCount').textContent.trim() === '6'",timeout=60000)
    page.locator('#selectAllBtn').click()
    page.locator('#nestBtn').click()
    expect(page.locator('#downloadPcHtmlBtn')).to_be_enabled(timeout=120000)
    page.locator('#exportOptions > summary').click()
    saved=[]
    for mode,button in [('pc','#downloadPcHtmlBtn'),('phone','#downloadPhoneHtmlBtn')]:
        with page.expect_download(timeout=60000) as dl:
            page.locator(button).click()
        download=dl.value
        assert download.suggested_filename.endswith(f'_{mode}.html'),download.suggested_filename
        path=out/f'exported_{mode}.html';download.save_as(path);saved.append((mode,path))
        expect(page.locator(button)).to_be_enabled()
    assert not errors,errors
    for mode,path in saved:
        context=browser.new_context(offline=True,viewport={'width':390 if mode=='phone' else 1440,'height':900})
        export=context.new_page();errors=[];requests=[]
        export.on('pageerror',lambda e:errors.append(str(e)))
        export.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        export.goto(path.as_uri(),wait_until='load')
        expect(export.locator('#inventory-body tr')).to_have_count(6)
        expect(export.locator('#cuts-panel')).to_be_visible()
        export.locator('button[data-stage="assembly"]').click()
        expect(export.locator('#model canvas')).to_be_visible()
        export.locator('#model canvas').click(position={'x':170 if mode=='phone' else 320,'y':250})
        expect(export.locator('#selected-details')).to_contain_text('SELECTED PIECE')
        export.screenshot(path=str(out/f'exported_{mode}.png'),full_page=True)
        assert not errors,errors
        assert not requests,requests
        context.close()
    browser.close()
print('Real STEP import, estimate, PC and phone downloads, offline model picking passed')
