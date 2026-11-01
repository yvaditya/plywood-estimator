"""Exercise a blocked correction through real STEP import and interactive review."""
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
out = root / 'tests' / '_output' / 'thickness_review'
out.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', '--input-type=module', '-e', '''
import {build} from './app/node_modules/esbuild/lib/main.js';
import {writeFileSync} from 'node:fs';
await build({entryPoints:['app/src/stepExport.ts'],outfile:'tests/_output/thickness_review/exporter.mjs',bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {buildAssemblyStep}=await import('./tests/_output/thickness_review/exporter.mjs');
const panel=x=>({name:'Board',outer:[[0,0],[110,0],[110,80],[0,80]],holes:[],thickness:19.05,origin:[x,0,0],uAxis:[1,0,0],vAxis:[0,1,0],normal:[0,0,1]});
writeFileSync('tests/_output/thickness_review/overlap.step',buildAssemblyStep([panel(0),panel(50)],new Date().toISOString(),'Overlap fixture'));
'''], cwd=root, check=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5183', wait_until='networkidle')
    page.set_input_files('#fileInput', str(out / 'overlap.step'))
    expect(page.locator('#bodyCount')).to_have_text('2', timeout=60000)
    page.locator('#modeThicknessBtn').click()
    page.fill('#thicknessTarget', '18')
    page.locator('#thicknessAnalyseBtn').click()
    expect(page.get_by_role('heading', name='Why Apply is blocked')).to_be_visible()
    expect(page.locator('#thicknessApplyBtn')).to_be_disabled()
    expect(page.locator('.thickness-issue')).to_have_count(1)
    expect(page.locator('.thickness-issue')).to_contain_text('Existing solids overlap')
    expect(page.locator('.thickness-issue')).to_contain_text('source CAD')
    buttons = page.locator('.thickness-issue-board')
    expect(buttons).to_have_count(2)
    expect(page.locator('#thicknessReviewHelp')).to_contain_text('not an approval')
    before = page.locator('#viewer').screenshot()
    buttons.first.click()
    expect(buttons.first).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#thicknessInspection')).to_contain_text('Highlighted in 3D')
    assert page.locator('#viewer').screenshot() != before, 'Review must highlight/frame the actual geometry'
    page.locator('#modeCutBtn').click()
    expect(page.locator('.file-sub').first).to_contain_text('2 selected')
    page.locator('#modeThicknessBtn').click()
    buttons.nth(1).focus()
    page.keyboard.press('Enter')
    expect(buttons.nth(1)).to_have_attribute('aria-pressed', 'true')
    expect(buttons.first).to_have_attribute('aria-pressed', 'false')
    page.screenshot(path=str(out / 'interactive-review.png'), full_page=True)
    page.locator('#thicknessShowAllBtn').click()
    expect(page.locator('#thicknessInspection')).to_be_hidden()
    expect(buttons.nth(1)).to_have_attribute('aria-pressed', 'false')
    page.fill('#thicknessTarget', '17')
    expect(page.locator('.thickness-issue')).to_have_count(0)
    expect(page.locator('#thicknessReviewHelp')).to_be_hidden()
    page.fill('#thicknessTarget', '18')
    page.locator('#thicknessAnalyseBtn').click()
    page.set_viewport_size({'width': 900, 'height': 850})
    expect(page.get_by_role('heading', name='Why Apply is blocked')).to_be_visible()
    buttons.first.click()
    expect(page.locator('#thicknessInspection')).to_be_visible()
    expect(page.locator('#thicknessApplyBtn')).to_be_disabled()
    page.screenshot(path=str(out / 'review-narrow.png'), full_page=True)
    assert not errors, errors
    browser.close()
    print('PASS: actionable blocking report, board highlight/frame, keyboard review, unchanged cutting selection, clear inspection, stale-report invalidation, narrow viewport, no browser errors')
