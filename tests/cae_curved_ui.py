"""Real curved STEP -> boundary mesh -> shell/H8 solve -> filled and wire views.

Requires the local CadQuery and Playwright runtimes. Run against a production
preview URL, with an optional fresh PyNite sidecar URL as the second argument.
"""
import json
import re
import sys
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out=Path(__file__).resolve().parent/'_output'/('cae_curved_ui_pynite' if len(sys.argv)>2 else 'cae_curved_ui')
out.mkdir(parents=True,exist_ok=True)
# Keep the native CAD runtime out of the browser process. This installed
# Windows OCP runtime hangs during interpreter teardown, after export finishes.
# Exit the generator only after validation/export; failures still fail the run.
subprocess.run([sys.executable,'-c', '''
import cadquery as cq
import os,sys
board=(cq.Workplane('XY').moveTo(0,0).lineTo(100,0).lineTo(100,80)
       .threePointArc((50,125),(0,80)).close().extrude(10))
bore=cq.Workplane('XY').center(50,55).circle(16).extrude(10)
board=board.cut(bore).rotate((0,0,0),(1,0,0),90)
assert board.val().isValid()
cq.exporters.export(board,sys.argv[1])
os._exit(0)
''',str(out/'curved-board.step')],check=True,timeout=60)
assert 'CIRCLE' in (out/'curved-board.step').read_text(), 'Fixture must contain real STEP curves'

def counts(text):
    return [int(re.search(pattern,text)[1].replace(',','')) for pattern in
            [r'([\d,]+)\s+(?:quad|hex)',r'([\d,]+)\s+nodes',r'([\d,]+)\s+DOF']]

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1500,'height':1000})
    errors=[]
    logs=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('console',lambda msg:logs.append(msg.text) if msg.text.startswith('[assembly]') else None)
    # A port with no listener exercises the internal solver without relying on
    # a possibly stale sidecar process. Pass a fresh sidecar URL to test PyNite.
    page.add_init_script('globalThis.__pyniteBase='+json.dumps(sys.argv[2] if len(sys.argv)>2 else 'http://127.0.0.1:8665'))
    page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:5184',wait_until='networkidle')
    page.set_input_files('#fileInput',str(out/'curved-board.step'))
    expect(page.locator('#bodyCount')).to_have_text('1',timeout=60000)
    page.locator('#modeAnalysisBtn').click()
    page.locator('#asmDetectBtn').click()
    stats=page.locator('#asmMeshStats')
    expect(stats).to_contain_text('Boundary-fitted mesh',timeout=20000)
    expect(stats).to_contain_text('Minimum scaled Jacobian')
    expect(page.locator('#asmMeshView')).to_have_value('surface')
    def snapshot(name):
        stats.scroll_into_view_if_needed()
        page.wait_for_timeout(600)
        page.screenshot(path=str(out/name),full_page=True)
    def wait_solved():
        try:
            page.wait_for_function("() => !document.querySelector('#asmSolveBtn').disabled && !document.querySelector('#asmFieldToggle').hidden",timeout=90000)
        except Exception:
            snapshot('failure.png')
            print(page.locator('#asmResult').inner_text(),logs,errors,flush=True)
            raise
    original=counts(stats.inner_text())
    page.locator('#asmMeshDensity').select_option('20')
    finer=counts(stats.inner_text())
    assert finer[1]>original[1]
    snapshot('curved-shell-filled.png')
    page.locator('#asmPreset50').click()
    page.locator('#asmSolveBtn').click()
    wait_solved()
    assert counts(stats.inner_text())==finer
    if len(sys.argv)>2:
        assert any('PyNite' in entry for entry in logs), logs
    page.locator('#asmShowLoads').uncheck()
    snapshot('curved-shell-solved.png')
    page.locator('#asmMeshKind').select_option('solid')
    expect(stats).to_contain_text('hex')
    solid=counts(stats.inner_text())
    assert solid[1]==finer[1]*3
    expect(page.locator('#asmFieldToggle')).to_be_hidden()
    snapshot('curved-solid-filled.png')
    page.locator('#asmMeshView').select_option('wire')
    page.locator('#asmShowNodes').check()
    snapshot('curved-solid-wire.png')
    page.locator('#asmMeshView').select_option('surface')
    page.locator('#asmShowNodes').uncheck()
    page.locator('#asmSolveBtn').click()
    wait_solved()
    assert counts(stats.inner_text())==solid
    expect(page.locator('#asmDeformScale')).to_have_value('0')
    snapshot('curved-solid-solved.png')
    page.locator('#asmShowMesh').uncheck()
    snapshot('curved-cad-result-overlay.png')
    page.locator('#asmShowMesh').check()
    assert not errors,errors
    (out/'summary.json').write_text(json.dumps({'original':original,'refined':finer,'solid':solid,'logs':logs,'errors':errors},indent=2),encoding='utf-8')
    browser.close()
print('PASS: actual STEP curves, preserved hole, refined shell/H8, preview/solve counts, both view modes, result overlay, no browser errors')
