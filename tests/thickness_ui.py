"""Real-browser thickness correction flow. Needs a running app and local STEP."""
import json
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

file=Path(sys.argv[1]).resolve()
url=sys.argv[2] if len(sys.argv)>2 else 'http://127.0.0.1:5174'
out=Path(__file__).resolve().parent/'_output'/'thickness_ui'
out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1600,'height':1100},accept_downloads=True)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(url,wait_until='networkidle')
    page.set_input_files('#fileInput',str(file))
    page.wait_for_function("() => document.querySelector('#bodyCount').textContent.includes('42 sheet')",timeout=60000)
    print('Imported 42 panels',flush=True)
    page.select_option('#units','mm')
    page.locator('.file-chevron').first.click()
    original=page.locator('.body-meta').all_text_contents()
    page.locator('#modeThicknessBtn').click()
    expect(page.locator('#modeThicknessBtn')).to_have_attribute('aria-selected','true')
    expect(page.locator('#thicknessReview')).to_be_visible()
    expect(page.locator('#layoutPane')).to_be_hidden()
    expect(page.locator('#nestBtn')).to_be_hidden()
    expect(page.locator('#thicknessSource')).to_have_value('19.05',timeout=10000)
    page.fill('#thicknessTarget','18')
    page.locator('#thicknessAnalyseBtn').click()
    expect(page.locator('#thicknessApplyBtn')).to_be_enabled(timeout=30000)
    print('Analysed in thickness workspace',flush=True)
    expect(page.get_by_role('columnheader',name='Old size')).to_be_visible()
    expect(page.get_by_role('columnheader',name='New size')).to_be_visible()
    first_row=page.locator('.thickness-change').first
    expect(first_row.locator('td').nth(0)).to_contain_text('19.05')
    expect(first_row.locator('td').nth(1)).to_contain_text('18')
    first_row.locator('button').click()
    expect(first_row.locator('button')).to_have_attribute('aria-expanded','true')
    first_row.locator('button').click()
    status=page.locator('#thicknessStatus').inner_text()
    assert '126' in status,status
    assert page.locator('.body-meta').all_text_contents()==original,'analysis cannot change the live cut list'
    page.locator('#thicknessPreview').check()
    print('Enabled preview',flush=True)
    assert page.locator('.body-meta').all_text_contents()==original,'preview cannot change the live cut list'
    expect(page.locator('#thicknessPreviewLegend')).to_be_visible()
    page.locator('#modeAnalysisBtn').click()
    print('Switched to analysis',flush=True)
    expect(page.locator('#thicknessReview')).to_be_hidden()
    expect(page.locator('#thicknessPreview')).not_to_be_checked()
    expect(page.locator('#thicknessPreviewLegend')).to_be_hidden()
    page.locator('#modeThicknessBtn').click()
    expect(page.locator('#thicknessApplyBtn')).to_be_enabled()
    page.locator('#thicknessPreview').check()
    page.fill('#thicknessSearch','Body 42')
    assert page.locator('.thickness-change').count()==1
    page.fill('#thicknessSearch','no-such-board')
    expect(page.locator('#thicknessChanges')).to_contain_text('No boards match')
    page.fill('#thicknessSearch','')
    print('Board filtering passed',flush=True)
    assert page.locator('.thickness-change').count()==42
    # Review scrolls independently; Apply stays visible on desktop and laptop.
    page.locator('#thicknessReviewScroll').evaluate('(el) => el.scrollTop = el.scrollHeight')
    for w,h in [(1600,1100),(1280,800),(900,700)]:
        page.set_viewport_size({'width':w,'height':h})
        print(f'Checking viewport {w} x {h}',flush=True)
        expect(page.locator('#thicknessApplyBtn')).to_be_in_viewport()
        assert page.locator('body').evaluate('(el) => el.scrollWidth <= innerWidth'), 'workspace must not overflow horizontally'
    page.set_viewport_size({'width':1600,'height':1100})
    page.locator('#thicknessReviewScroll').evaluate('(el) => el.scrollTop = 0')
    page.screenshot(path=str(out/'preview.png'),full_page=True)
    print('Saved workspace preview',flush=True)
    page.locator('#modeCutBtn').click()
    page.select_option('#thicknessOverride','19.05')
    page.locator('#modeThicknessBtn').click()
    page.locator('#thicknessApplyBtn').click()
    expect(page.locator('#thicknessResetBtn')).to_be_enabled()
    expect(page.locator('#thicknessOverride')).to_have_value('')
    changed=page.locator('.body-meta').all_text_contents()
    assert changed!=original,'apply must update the live dimensions'
    assert not page.locator('#thicknessPreview').is_checked()
    page.locator('#modeCutBtn').click()
    page.select_option('#restarts','32')
    page.select_option('#cutStrategy','repeated')
    page.locator('#nestBtn').click()
    page.wait_for_function("() => !document.querySelector('#nestBtn').disabled && !document.querySelector('#downloadPdfBtn').disabled",timeout=120000)
    assert page.locator('.sheet-entry-meta').count()==2
    sheet_labels=page.locator('.sheet-entry-meta').all_text_contents()
    assert all(re.search(r'18(?:\.0+)?\s*mm\s+thick',s) for s in sheet_labels),sheet_labels
    # Export is the applied state, even while a different target is entered.
    page.locator('#modeThicknessBtn').click()
    page.fill('#thicknessTarget','17')
    expect(page.locator('#thicknessApplyBtn')).to_be_disabled()
    with page.expect_download() as event:page.locator('#thicknessExportBtn').click()
    download=event.value
    download.save_as(out/'browser-corrected.step')
    assert (out/'browser-corrected.step').stat().st_size>1000
    page.fill('#thicknessTarget','18')
    page.locator('#thicknessAnalyseBtn').click()
    expect(page.locator('#thicknessApplyBtn')).to_be_enabled()
    page.locator('#thicknessApplyBtn').click()
    assert page.locator('.body-meta').all_text_contents()==changed,'repeated apply cannot accumulate allowances'
    expect(page.locator('#downloadPdfBtn')).to_be_disabled()
    page.locator('#thicknessResetBtn').click()
    assert page.locator('.body-meta').all_text_contents()==original,'reset must restore imported dimensions'
    expect(page.locator('#thicknessExportBtn')).to_be_disabled()
    page.fill('#thicknessTarget','0')
    expect(page.locator('#thicknessAnalyseBtn')).to_be_disabled()
    page.screenshot(path=str(out/'reset.png'),full_page=True)
    # A second file is shifted for display, but its CAD export must keep the
    # source coordinates. Duplicate filenames also need separate identities.
    page.fill('#thicknessTarget','18')
    page.set_input_files('#fileInput',str(file))
    page.wait_for_function("() => document.querySelector('#bodyCount').textContent.includes('84 sheet')",timeout=60000)
    page.select_option('#thicknessCabinet',label='FULL TOE KICK (2)')
    page.locator('#thicknessAnalyseBtn').click()
    expect(page.locator('#thicknessApplyBtn')).to_be_enabled(timeout=30000)
    page.locator('#thicknessApplyBtn').click()
    assert page.locator('.body-meta').all_text_contents()==original,'correcting the second cabinet must not change the first'
    with page.expect_download() as event:page.locator('#thicknessExportBtn').click()
    event.value.save_as(out/'browser-second-corrected.step')
    page.locator('#modeCutBtn').click()
    page.locator('#clearAllBtn').click()
    page.locator('#modeThicknessBtn').click()
    expect(page.locator('#thicknessAnalyseBtn')).to_be_disabled()
    expect(page.locator('#thicknessExportBtn')).to_be_disabled()
    (out/'summary.json').write_text(json.dumps({'status':status,'parts':len(changed),'download':download.suggested_filename,'browserErrors':errors},indent=2),encoding='utf-8')
    page.reload(wait_until='networkidle')
    expect(page.locator('#modeThicknessBtn')).to_have_attribute('aria-selected','true')
    expect(page.locator('#thicknessReview')).to_be_visible()
    expect(page.locator('#thicknessAnalyseBtn')).to_be_disabled()
    assert not errors,errors
    print('PASS: thickness workspace, responsive fixed actions, search, mode switching, import, analyse, preview, apply, 18 mm nesting, STEP download, no cumulative edits, reset, invalid target, duplicate filenames, isolated cabinets, clear, persisted mode, no browser errors',flush=True)
    browser.close()
